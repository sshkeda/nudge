import { afterAll, beforeAll, expect } from "bun:test"
import { chmod, lstat, mkdir, readdir, rm } from "node:fs/promises"
import { createConnection } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { Effect, Fiber } from "effect"

import { sendViaCodexBridge as sendEffect } from "../src/codex/bridge.ts"
import { environment, spawnScoped, temporaryDirectory, testEffect } from "./support.ts"

const bridgePath = join(tmpdir(), `nudge-bundled-helper-${crypto.randomUUID()}`, "helper.mjs")

beforeAll(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(dirname(bridgePath), { mode: 0o700 }))
      const result = yield* Effect.tryPromise(() =>
        Bun.build({
          entrypoints: [join(import.meta.dir, "../src/codex/desktop-helper.ts")],
          target: "node",
          format: "esm",
          minify: true
        })
      )
      if (!result.success) throw new AggregateError(result.logs, "cannot bundle Desktop helper")
      const output = result.outputs[0]
      if (output === undefined) throw new Error("missing Desktop helper bundle")
      yield* Effect.tryPromise(() => Bun.write(bridgePath, output))
    })
  )
)
afterAll(() =>
  Effect.runPromise(
    Effect.tryPromise(() => rm(dirname(bridgePath), { recursive: true, force: true }))
  )
)

testEffect(
  "the helper bundle imports only Node built-ins and retains its license notices",
  Effect.gen(function* () {
    const source = yield* Effect.tryPromise(() => Bun.file(bridgePath).text())
    const imports = new Bun.Transpiler({ loader: "js" }).scanImports(source)
    expect(imports.filter((entry) => !entry.path.startsWith("node:"))).toEqual([])
    for (const path of [
      "LICENSE",
      "node_modules/effect/LICENSE",
      "node_modules/@effect/platform-bun/LICENSE",
      "node_modules/@effect/platform-node-shared/LICENSE"
    ]) {
      const license = yield* Effect.tryPromise(() =>
        Bun.file(join(import.meta.dir, "..", path)).text()
      )
      for (const paragraph of license.trim().split("\n\n")) expect(source).toContain(paragraph)
    }
    expect(source).toContain(
      "Licenses for Nudge and the JavaScript dependencies bundled in Nudge's Codex Desktop helper."
    )
    expect(source).toContain("Copyright Node.js contributors. All rights reserved.")
    expect(source).toContain(
      "Copyright Joyent, Inc. and other Node contributors. All rights reserved."
    )
  })
)

testEffect(
  "the Desktop MCP shim proxies normal traffic and delivers external messages",
  Effect.gen(function* () {
    const directory = yield* temporaryDirectory(join(tmpdir(), "nudge-app-bridge-"))
    const socketPath = join(directory, "bridge.sock")
    const nativeServerPath = join(directory, "fake-native-server.mjs")
    const callsPath = join(directory, "calls.jsonl")
    yield* buildFixture("native-server", nativeServerPath)
    yield* Effect.tryPromise(() => chmod(nativeServerPath, 0o600))
    const bridge = yield* spawnScoped(() =>
      Bun.spawn([process.execPath, bridgePath], {
        env: {
          ...environment,
          NUDGE_CODEX_APP_TOOLS_SERVER: nativeServerPath,
          NUDGE_CODEX_BRIDGE_SOCKET: socketPath,
          CODEX_APP_TOOLS_PIPE_PATH: "fixture-native-pipe",
          FAKE_NATIVE_CALLS_PATH: callsPath
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe"
      })
    )
    yield* waitForSocket(socketPath)
    bridge.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: "nudge:desktop-request",
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "fixture", version: "1" }
        }
      })}\n`
    )
    bridge.stdin.flush()
    const reader = bridge.stdout.getReader()
    const initialized = yield* readLine(reader)
    expect(JSON.parse(initialized)).toMatchObject({
      id: "nudge:desktop-request",
      result: { serverInfo: { name: "fixture" } }
    })
    yield* sendViaCodexBridge({
      socketPath,
      targetThreadId: "target-thread",
      sourceThreadId: "source-codex-thread",
      prompt: "<cross-session-message>hello</cross-session-message>",
      timeoutMs: 1000
    })
    const calls = (yield* Effect.tryPromise(() => Bun.file(callsPath).text()))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(calls).toHaveLength(2)
    expect(calls[1]).toMatchObject({
      method: "tools/call",
      params: {
        name: "send_message_to_thread",
        arguments: {
          threadId: "target-thread",
          prompt: "<cross-session-message>hello</cross-session-message>"
        },
        _meta: {
          "openai/threadId": "source-codex-thread"
        }
      }
    })
    reader.releaseLock()
  })
)

for (const signal of ["SIGTERM", "SIGKILL"] as const)
  testEffect(
    `a standby Desktop MCP shim takes bridge ownership after ${signal}`,
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory(join(tmpdir(), "nudge-app-bridge-takeover-"))
      const socketPath = join(directory, "bridge.sock")
      const nativeServerPath = join(directory, "fake-native-server.mjs")
      const ownerCallsPath = join(directory, "owner-calls.jsonl")
      const standbyCallsPath = join(directory, "standby-calls.jsonl")
      yield* buildFixture("native-takeover", nativeServerPath)
      const spawnBridge = (callsPath: string) =>
        Bun.spawn([process.execPath, bridgePath], {
          env: {
            ...environment,
            NUDGE_CODEX_APP_TOOLS_SERVER: nativeServerPath,
            NUDGE_CODEX_BRIDGE_SOCKET: socketPath,
            CODEX_APP_TOOLS_PIPE_PATH: "fixture-native-pipe",
            FAKE_NATIVE_CALLS_PATH: callsPath
          },
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe"
        })
      const owner = yield* spawnScoped(() => spawnBridge(ownerCallsPath))
      yield* waitForSocket(socketPath)
      const standby = yield* spawnScoped(() => spawnBridge(standbyCallsPath))
      const ownerReader = owner.stdout.getReader()
      const standbyReader = standby.stdout.getReader()
      for (const bridge of [owner, standby]) {
        bridge.stdin.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "fixture", version: "1" }
            }
          })}\n`
        )
        bridge.stdin.flush()
      }
      yield* Effect.all([readLine(ownerReader), readLine(standbyReader)], {
        concurrency: "unbounded"
      })
      const previous = yield* Effect.tryPromise(() => lstat(socketPath))
      owner.kill(signal)
      yield* Effect.tryPromise(() => owner.exited)
      yield* waitForSocket(socketPath, previous.ino)
      yield* sendViaCodexBridge({
        socketPath,
        targetThreadId: "target-thread",
        prompt: "delivered-after-takeover",
        timeoutMs: 1000
      })
      yield* waitForFileText(standbyCallsPath, "delivered-after-takeover\n")
      expect(yield* Effect.tryPromise(() => Bun.file(standbyCallsPath).text())).toBe(
        "delivered-after-takeover\n"
      )
      ownerReader.releaseLock()
      standbyReader.releaseLock()
    })
  )

for (const stopped of ["displaced", "winner"] as const)
  testEffect(
    `simultaneous stale-socket recoverers remain usable after the ${stopped} helper stops`,
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory(join(tmpdir(), "nudge-race-"))
      const socketPath = join(directory, "bridge.sock")
      const nativePath = join(directory, "native.mjs")
      const preloadPath = join(directory, "pause.mjs")
      yield* buildFixture("native-takeover", nativePath)
      yield* buildFixture("pause-publication", preloadPath)
      const spawnBridge = (name: string, paused = false) =>
        Bun.spawn(
          [
            Bun.env["NUDGE_TEST_NODE"] ?? "node",
            ...(paused ? ["--import", preloadPath] : []),
            bridgePath
          ],
          {
            env: {
              ...environment,
              NUDGE_CODEX_APP_TOOLS_SERVER: nativePath,
              NUDGE_CODEX_BRIDGE_SOCKET: socketPath,
              CODEX_APP_TOOLS_PIPE_PATH: "fixture",
              FAKE_NATIVE_CALLS_PATH: join(directory, name + ".calls"),
              FIXTURE_PUBLICATION_GATE: join(directory, name)
            },
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe"
          }
        )
      const owner = yield* spawnScoped(() => spawnBridge("owner"))
      yield* waitForSocket(socketPath)
      const stale = yield* Effect.tryPromise(() => lstat(socketPath))
      owner.kill("SIGKILL")
      yield* Effect.tryPromise(() => owner.exited)

      const displaced = yield* spawnScoped(() => spawnBridge("displaced", true))
      const winner = yield* spawnScoped(() => spawnBridge("winner", true))
      for (const helper of [displaced, winner]) {
        helper.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) + "\n")
        helper.stdin.flush()
        const reader = helper.stdout.getReader()
        expect(JSON.parse(yield* readLine(reader)).id).toBe(1)
        reader.releaseLock()
      }
      // Both processes have declared the same original endpoint stale. Release
      // one at a time to force a successful owner to be displaced by its peer.
      yield* waitForFileText(join(directory, "displaced.ready"), "ready")
      yield* waitForFileText(join(directory, "winner.ready"), "ready")
      yield* Effect.tryPromise(() => Bun.write(join(directory, "displaced.release"), "go"))
      yield* waitForSocket(socketPath, stale.ino)
      const first = yield* Effect.tryPromise(() => lstat(socketPath))
      yield* Effect.tryPromise(() => Bun.write(join(directory, "winner.release"), "go"))
      yield* waitForSocket(socketPath, first.ino)
      const published = yield* Effect.tryPromise(() => lstat(socketPath))
      yield* sendViaCodexBridge({
        socketPath,
        targetThreadId: "target",
        prompt: "before-stop",
        timeoutMs: 1000
      })
      yield* waitForFileText(join(directory, "winner.calls"), "before-stop\n")

      const helper = stopped === "displaced" ? displaced : winner
      helper.kill(stopped === "displaced" ? "SIGTERM" : "SIGKILL")
      yield* Effect.tryPromise(() => helper.exited)
      if (stopped === "displaced")
        expect((yield* Effect.tryPromise(() => lstat(socketPath))).ino).toBe(published.ino)
      else yield* waitForSocket(socketPath, published.ino)
      yield* sendViaCodexBridge({
        socketPath,
        targetThreadId: "target",
        prompt: "after-stop",
        timeoutMs: 1000
      })
      yield* waitForFileText(
        join(directory, stopped === "displaced" ? "winner.calls" : "displaced.calls"),
        stopped === "displaced" ? "before-stop\nafter-stop\n" : "after-stop\n"
      )
    }),
    10000
  )

testEffect(
  "the Desktop MCP shim backpressures a burst beyond its bounded delivery capacity",
  Effect.gen(function* () {
    const directory = yield* temporaryDirectory(join(tmpdir(), "nudge-app-bridge-burst-"))
    const socketPath = join(directory, "bridge.sock")
    const nativeServerPath = join(directory, "fake-native-server.mjs")
    const callsPath = join(directory, "calls.jsonl")
    yield* buildFixture("native-burst", nativeServerPath)
    const bridge = yield* spawnScoped(() =>
      Bun.spawn([process.execPath, bridgePath], {
        env: {
          ...environment,
          NUDGE_CODEX_APP_TOOLS_SERVER: nativeServerPath,
          NUDGE_CODEX_BRIDGE_SOCKET: socketPath,
          CODEX_APP_TOOLS_PIPE_PATH: "fixture-native-pipe",
          FAKE_NATIVE_CALLS_PATH: callsPath
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe"
      })
    )
    yield* waitForSocket(socketPath)
    bridge.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "fixture", version: "1" }
        }
      })}\n`
    )
    bridge.stdin.flush()
    const reader = bridge.stdout.getReader()
    const initialized = yield* readLine(reader)
    expect(JSON.parse(initialized)).toMatchObject({
      id: 1,
      result: { serverInfo: { name: "burst-fixture" } }
    })
    const prompts = Array.from({ length: 96 }, (_, index) => `burst-${index + 1}`)
    yield* Effect.all(
      prompts.map((prompt) =>
        sendViaCodexBridge({
          socketPath,
          targetThreadId: "target-thread",
          sourceThreadId: "source-codex-thread",
          prompt,
          timeoutMs: 5000
        })
      ),
      { concurrency: "unbounded" }
    )
    const calls = (yield* Effect.tryPromise(() => Bun.file(callsPath).text()))
      .trim()
      .split("\n")
      .map((line) => {
        const call = JSON.parse(line)
        return {
          event: String(call.event),
          prompt: String(call.prompt),
          inFlight: Number(call.inFlight)
        }
      })
    const starts = calls.filter((call) => call.event === "start")
    const finishes = calls.filter((call) => call.event === "finish")
    expect(starts).toHaveLength(96)
    expect(finishes).toHaveLength(96)
    expect(Math.max(...starts.map((call) => call.inFlight))).toBe(1)
    expect(new Set(starts.map((call) => call.prompt))).toEqual(new Set(prompts))
    expect(new Set(finishes.map((call) => call.prompt))).toEqual(new Set(prompts))
    reader.releaseLock()
  })
)

testEffect(
  "the Desktop MCP shim drops a queued delivery after its caller times out",
  Effect.gen(function* () {
    const directory = yield* temporaryDirectory(join(tmpdir(), "nudge-app-bridge-cancel-"))
    const socketPath = join(directory, "bridge.sock")
    const nativeServerPath = join(directory, "fake-native-server.mjs")
    const callsPath = join(directory, "calls.jsonl")
    yield* buildFixture("native-cancel", nativeServerPath)
    const bridge = yield* spawnScoped(() =>
      Bun.spawn([process.execPath, bridgePath], {
        env: {
          ...environment,
          NUDGE_CODEX_APP_TOOLS_SERVER: nativeServerPath,
          NUDGE_CODEX_BRIDGE_SOCKET: socketPath,
          CODEX_APP_TOOLS_PIPE_PATH: "fixture-native-pipe",
          FAKE_NATIVE_CALLS_PATH: callsPath
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe"
      })
    )
    yield* waitForSocket(socketPath)
    bridge.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "fixture", version: "1" }
        }
      })}\n`
    )
    bridge.stdin.flush()
    const reader = bridge.stdout.getReader()
    yield* readLine(reader)
    const active = yield* Effect.forkScoped(
      sendViaCodexBridge({
        socketPath,
        targetThreadId: "target-thread",
        prompt: "active",
        timeoutMs: 1000
      })
    )
    yield* waitForFileText(callsPath, "active\n")
    yield* Effect.map(
      Effect.flip(
        sendViaCodexBridge({
          socketPath,
          targetThreadId: "target-thread",
          prompt: "canceled-while-queued",
          timeoutMs: 25
        })
      ),
      (error) => expect(error).toMatchObject({ code: "request-timeout" })
    )
    yield* Fiber.join(active)
    yield* Effect.sleep(50)
    expect(yield* Effect.tryPromise(() => Bun.file(callsPath).text())).toBe("active\n")
    reader.releaseLock()
  })
)

testEffect(
  "the Desktop MCP shim drops a canceled delivery that was awaiting child readiness",
  Effect.gen(function* () {
    const directory = yield* temporaryDirectory(join(tmpdir(), "nudge-app-bridge-ready-cancel-"))
    const socketPath = join(directory, "bridge.sock")
    const nativeServerPath = join(directory, "fake-native-server.mjs")
    const callsPath = join(directory, "calls.jsonl")
    yield* buildFixture("native-slow-init", nativeServerPath)
    const bridge = yield* spawnScoped(() =>
      Bun.spawn([process.execPath, bridgePath], {
        env: {
          ...environment,
          NUDGE_CODEX_APP_TOOLS_SERVER: nativeServerPath,
          NUDGE_CODEX_BRIDGE_SOCKET: socketPath,
          CODEX_APP_TOOLS_PIPE_PATH: "fixture-native-pipe",
          FAKE_NATIVE_CALLS_PATH: callsPath
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe"
      })
    )
    yield* waitForSocket(socketPath)
    bridge.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "fixture", version: "1" }
        }
      })}\n`
    )
    bridge.stdin.flush()
    const reader = bridge.stdout.getReader()
    yield* Effect.map(
      Effect.flip(
        sendViaCodexBridge({
          socketPath,
          targetThreadId: "target-thread",
          prompt: "canceled-while-initializing",
          timeoutMs: 60
        })
      ),
      (error) => expect(error).toMatchObject({ code: "request-timeout" })
    )
    const initialized = yield* readLine(reader)
    expect(JSON.parse(initialized)).toMatchObject({
      id: 1,
      result: { serverInfo: { name: "slow-init-fixture" } }
    })
    yield* sendViaCodexBridge({
      socketPath,
      targetThreadId: "target-thread",
      prompt: "delivered-after-readiness",
      timeoutMs: 1000
    })
    yield* Effect.sleep(50)
    expect(yield* Effect.tryPromise(() => Bun.file(callsPath).text())).toBe(
      "delivered-after-readiness\n"
    )
    reader.releaseLock()
  })
)

testEffect(
  "the Desktop launch hook redirects the bundled entry through the shim",
  Effect.gen(function* () {
    const directory = yield* temporaryDirectory(join(tmpdir(), "nudge-app-redirect-"))
    const socketPath = join(directory, "bridge.sock")
    const nativeServerPath = join(directory, "fake-native-server.mjs")
    yield* buildFixture("native-redirect", nativeServerPath)
    const launched = yield* spawnScoped(() =>
      Bun.spawn([Bun.env["NUDGE_TEST_NODE"] ?? "node", nativeServerPath], {
        env: {
          ...environment,
          NODE_OPTIONS: `--import=${bridgePath}`,
          NUDGE_CODEX_APP_TOOLS_SERVER: nativeServerPath,
          NUDGE_CODEX_BRIDGE_SOCKET: socketPath,
          CODEX_APP_TOOLS_PIPE_PATH: "fixture-native-pipe"
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe"
      })
    )
    yield* waitForSocket(socketPath)
    launched.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "fixture", version: "1" }
        }
      })}\n`
    )
    launched.stdin.flush()
    const reader = launched.stdout.getReader()
    const initialized = yield* readLine(reader)
    expect(JSON.parse(initialized)).toMatchObject({
      id: 1,
      result: { serverInfo: { name: "redirected-fixture" } }
    })
    reader.releaseLock()
  })
)

testEffect(
  "the Desktop launch hook passes through when the bundled entry cannot be resolved",
  Effect.gen(function* () {
    const directory = yield* temporaryDirectory(join(tmpdir(), "nudge-app-unresolved-"))
    const missingPath = join(directory, "missing-server.mjs")
    const hostPath = join(directory, "host-entry.mjs")
    yield* buildFixture("host-entry", hostPath)
    const launched = yield* spawnScoped(() =>
      Bun.spawn([Bun.env["NUDGE_TEST_NODE"] ?? "node", hostPath], {
        env: {
          ...environment,
          NODE_OPTIONS: `--import=${bridgePath}`,
          NUDGE_CODEX_APP_TOOLS_SERVER: missingPath,
          NUDGE_CODEX_BRIDGE_SOCKET: join(directory, "bridge.sock"),
          CODEX_APP_TOOLS_PIPE_PATH: "fixture-native-pipe"
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe"
      })
    )
    const [exitCode, stdout, stderr] = yield* Effect.all(
      [
        Effect.promise(() => launched.exited),
        Effect.tryPromise(() => Bun.readableStreamToText(launched.stdout)),
        Effect.tryPromise(() => Bun.readableStreamToText(launched.stderr))
      ],
      { concurrency: "unbounded" }
    )
    expect(stdout).toContain("host-entry-ran")
    expect(exitCode).toBe(0)
    const reported = stderr
      .split("\n")
      .filter((line) => line.includes("Nudge helper: cannot resolve"))
    expect(reported).toHaveLength(1)
    expect(reported[0]).toContain(
      `Nudge helper: cannot resolve Codex Desktop's App Tools server at ${missingPath}: `
    )
    expect(reported[0]).toContain("ENOENT")
  })
)

testEffect(
  "the Desktop MCP shim warns once for each Codex bridge failure",
  Effect.gen(function* () {
    const directory = yield* temporaryDirectory(join(tmpdir(), "nudge-warn-once-"))
    const bridgeDirectory = join(directory, "bridge")
    const socketPath = join(bridgeDirectory, "bridge.sock")
    yield* Effect.tryPromise(() => mkdir(bridgeDirectory, { mode: 0o700 }))
    yield* Effect.addFinalizer(() => Effect.promise(() => chmod(bridgeDirectory, 0o700)))
    yield* Effect.tryPromise(() => Bun.write(socketPath, "not a socket"))
    const nativePath = join(directory, "native.mjs")
    yield* buildFixture("native-takeover", nativePath)
    const helper = yield* spawnScoped(() =>
      Bun.spawn([Bun.env["NUDGE_TEST_NODE"] ?? "node", bridgePath], {
        env: {
          ...environment,
          NUDGE_CODEX_APP_TOOLS_SERVER: nativePath,
          NUDGE_CODEX_BRIDGE_SOCKET: socketPath,
          CODEX_APP_TOOLS_PIPE_PATH: "fixture",
          FAKE_NATIVE_CALLS_PATH: join(directory, "calls")
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe"
      })
    )
    const warnings = yield* collectWarnings(helper.stderr)
    yield* Effect.gen(function* () {
      while (warnings().length === 0) yield* Effect.sleep(25)
    }).pipe(Effect.timeout(5000))
    yield* Effect.sleep(1500)
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toContain(`Codex bridge path exists and is not a socket: ${socketPath}`)

    yield* Effect.tryPromise(() => rm(socketPath))
    yield* waitForSocket(socketPath)

    yield* Effect.tryPromise(() => chmod(bridgeDirectory, 0o600))
    yield* Effect.gen(function* () {
      while (warnings().length < 2) yield* Effect.sleep(25)
    }).pipe(Effect.timeout(5000))
    yield* Effect.sleep(750)
    const reported = warnings()
    expect(reported).toHaveLength(2)
    expect(reported[1]).toContain("EACCES")
    expect(reported[1]).not.toBe(reported[0])
  }),
  15000
)

const collectWarnings = Effect.fn("collectWarnings")(function* (
  stderr: ReadableStream<Uint8Array>
) {
  const reader = yield* Effect.acquireRelease(
    Effect.sync(() => stderr.getReader()),
    (stream) => Effect.promise(() => stream.cancel().catch(() => undefined))
  )
  let body = ""
  yield* Effect.forkScoped(
    Effect.gen(function* () {
      const decoder = new TextDecoder()
      for (;;) {
        const chunk = yield* Effect.tryPromise(() => reader.read())
        if (chunk.done) return
        body += decoder.decode(chunk.value, { stream: true })
      }
    }).pipe(Effect.catch(() => Effect.void))
  )
  return () =>
    body.split("\n").filter((line) => line.startsWith("warning: Codex bridge unavailable:"))
})

testEffect(
  "the bridge owner never connects to the socket it published",
  Effect.gen(function* () {
    const directory = yield* temporaryDirectory(join(tmpdir(), "nudge-self-probe-"))
    const socketPath = join(directory, "bridge.sock")
    const nativePath = join(directory, "native.mjs")
    const wrapperPath = join(directory, "count-connections.mjs")
    const observed = join(directory, "accepted")
    yield* buildFixture("native-takeover", nativePath)
    yield* buildFixture("count-connections", wrapperPath)
    yield* spawnScoped(() =>
      Bun.spawn([Bun.env["NUDGE_TEST_NODE"] ?? "node", wrapperPath], {
        env: {
          ...environment,
          NUDGE_CODEX_APP_TOOLS_SERVER: nativePath,
          NUDGE_CODEX_BRIDGE_SOCKET: socketPath,
          CODEX_APP_TOOLS_PIPE_PATH: "fixture",
          FAKE_NATIVE_CALLS_PATH: join(directory, "calls"),
          FIXTURE_BRIDGE_PATH: bridgePath,
          OBSERVED_PATH: observed
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe"
      })
    )
    yield* waitForSocket(socketPath)
    yield* Effect.sleep(1500)
    expect(yield* Effect.tryPromise(() => Bun.file(observed).text())).toBe("0")
    yield* Effect.callback<void, Error>((resume) => {
      const socket = createConnection(socketPath)
      socket.once("connect", () => {
        socket.destroy()
        resume(Effect.void)
      })
      socket.once("error", (cause: Error) => resume(Effect.fail(cause)))
      return Effect.sync(() => socket.destroy())
    })
    yield* waitForFileText(observed, "1")
  }),
  8000
)

const waitForSocket = Effect.fn("waitForSocket")(function* (path: string, previousInode?: number) {
  yield* Effect.gen(function* () {
    for (;;) {
      const ready = yield* Effect.tryPromise({
        try: () => lstat(path),
        catch: (cause) => cause
      }).pipe(
        Effect.map(
          (stat) => stat.isSocket() && (stat.mode & 0o077) === 0 && stat.ino !== previousInode
        ),
        Effect.catch(() => Effect.succeed(false))
      )
      if (ready) return
      yield* Effect.sleep(10)
    }
  }).pipe(Effect.timeout(3000))
})

const waitForFileText = Effect.fn("waitForFileText")(function* (path: string, expected: string) {
  yield* Effect.gen(function* () {
    for (;;) {
      const ready = yield* Effect.tryPromise(() => Bun.file(path).text()).pipe(
        Effect.map((body) => body === expected),
        Effect.catch(() => Effect.succeed(false))
      )
      if (ready) return
      yield* Effect.sleep(10)
    }
  }).pipe(Effect.timeout(1000))
})

const readLine = Effect.fn("readLine")(function* (reader: {
  read: () => Promise<{
    done: boolean
    value: Uint8Array | undefined
  }>
}) {
  let body = ""
  const decoder = new TextDecoder()
  while (!body.includes("\n")) {
    const next = yield* Effect.tryPromise(() => reader.read())
    if (next.done) throw new Error("bridge stdout closed before a complete line")
    body += decoder.decode(next.value, { stream: true })
  }
  return body.slice(0, body.indexOf("\n"))
})

testEffect(
  "bridge sockets are private before chmod and preserve the inherited umask",
  Effect.gen(function* () {
    for (const runtime of [process.execPath, Bun.env["NUDGE_TEST_NODE"] ?? "node"]) {
      const directory = yield* temporaryDirectory(join(tmpdir(), "nudge-bind-mode-"))
      const socketPath = join(directory, "bridge.sock")
      const observedPath = join(directory, "bind.json")
      const wrapperPath = join(directory, "wrapper.mjs")
      const nativePath = join(directory, "native.mjs")
      yield* buildFixture("stdin-holder", nativePath)
      yield* buildFixture("observe-bind", wrapperPath)
      yield* spawnScoped(() =>
        Bun.spawn([runtime, wrapperPath], {
          env: {
            ...environment,
            NUDGE_CODEX_APP_TOOLS_SERVER: nativePath,
            NUDGE_CODEX_BRIDGE_SOCKET: socketPath,
            OBSERVED_PATH: observedPath,
            FIXTURE_BRIDGE_PATH: bridgePath,
            CODEX_APP_TOOLS_PIPE_PATH: "fixture"
          },
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe"
        })
      )
      for (
        let attempt = 0;
        attempt < 100 && !(yield* Effect.tryPromise(() => Bun.file(observedPath).exists()));
        attempt++
      )
        yield* Effect.sleep(20)
      expect(yield* Effect.tryPromise(() => Bun.file(observedPath).json())).toEqual({
        mode: 0,
        mask: 0o022
      })
    }
  })
)

const buildFixture = Effect.fn("buildFixture")(function* (name: string, outfile: string) {
  const result = yield* Effect.tryPromise(() =>
    Bun.build({
      entrypoints: [
        join(
          import.meta.dir,
          "fixtures",
          name === "idle" || name === "stdout-holder" ? "process" : "desktop",
          `${name}.ts`
        )
      ],
      target: "node",
      format: "esm"
    })
  )
  if (!result.success) throw new AggregateError(result.logs, `cannot build ${name}`)
  const output = result.outputs[0]
  if (output === undefined) throw new Error(`no output for ${name}`)
  yield* Effect.tryPromise(() => Bun.write(outfile, output))
})

function sendViaCodexBridge(options: Parameters<typeof sendEffect>[0]) {
  return sendEffect(options)
}

testEffect(
  "helper shutdown closes in-flight sockets and terminates its child",
  Effect.gen(function* () {
    for (const mode of ["SIGTERM", "SIGKILL", "child-exit", "stdin-end", "descendant"]) {
      const directory = yield* temporaryDirectory(join(tmpdir(), "nudge-lifecycle-"))
      const socketPath = join(directory, "bridge.sock")
      const nativePath = join(directory, "native.mjs")
      const callsPath = join(directory, "calls")
      yield* buildFixture("native-lifecycle", nativePath)
      const descendantPath = join(directory, "descendant.mjs")
      yield* buildFixture("idle", descendantPath)
      const helper = yield* spawnScoped(() =>
        Bun.spawn([Bun.env["NUDGE_TEST_NODE"] ?? "node", bridgePath], {
          env: {
            ...environment,
            NUDGE_CODEX_APP_TOOLS_SERVER: nativePath,
            NUDGE_CODEX_BRIDGE_SOCKET: socketPath,
            CODEX_APP_TOOLS_PIPE_PATH: "fixture",
            FAKE_NATIVE_CALLS_PATH: callsPath,
            FIXTURE_IGNORE_TERM: mode === "SIGKILL" ? "1" : "0",
            FIXTURE_DESCENDANT_PATH: mode === "descendant" ? descendantPath : "",
            FIXTURE_EXIT_ON_CALL: mode === "child-exit" ? "1" : "0"
          },
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          timeout: 5000
        })
      )
      yield* Effect.gen(function* () {
        yield* waitForSocket(socketPath)
        helper.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) + "\n")
        helper.stdin.flush()
        const reader = helper.stdout.getReader()
        expect(JSON.parse(yield* readLine(reader)).id).toBe(1)
        const childPid = Number(
          (yield* Effect.tryPromise(() => Bun.file(callsPath).text())).split("\n")[0]
        )
        if (mode === "stdin-end" || mode === "descendant") {
          const stoppedAt = Date.now()
          helper.stdin.end()
          expect(yield* Effect.tryPromise(() => helper.exited)).toBe(0)
          expect(Date.now() - stoppedAt).toBeLessThan(2000)
        } else {
          const response = yield* Effect.forkScoped(
            sendViaCodexBridge({
              socketPath,
              targetThreadId: "target",
              prompt: "wait",
              timeoutMs: 4000
            }).pipe(
              Effect.match({
                onSuccess: () => "unexpected delivery",
                onFailure: (cause: unknown) =>
                  cause instanceof Error ? cause.message : String(cause)
              })
            )
          )
          yield* waitForFileText(callsPath, `${childPid}\ndispatched\n`)
          if (mode !== "child-exit") helper.kill("SIGTERM")
          expect(yield* Fiber.join(response)).toContain("Codex bridge is shutting down")
          expect(yield* Effect.tryPromise(() => helper.exited)).toBe(
            mode === "child-exit" ? 1 : 143
          )
          if (mode === "SIGKILL")
            expect(yield* Effect.tryPromise(() => Bun.file(callsPath).text())).toContain("SIGTERM")
          if (mode === "child-exit")
            expect(
              yield* Effect.tryPromise(() => Bun.readableStreamToText(helper.stderr))
            ).toContain("exited with code 42")
        }
        // Publication deliberately leaves a stale hard link. Shutdown must close
        // its listener and clean its private bind path, without unlinking a peer.
        const refused = yield* Effect.callback<NodeJS.ErrnoException, Error>((resume) => {
          const socket = createConnection(socketPath)
          socket.once("connect", () => resume(Effect.fail(new Error("closed helper accepted"))))
          socket.once("error", (error: NodeJS.ErrnoException) => resume(Effect.succeed(error)))
          return Effect.sync(() => socket.destroy())
        })
        expect(refused.code).toBe("ECONNREFUSED")
        const entries = yield* Effect.tryPromise(() => readdir(directory, { withFileTypes: true }))
        expect(entries.filter((entry) => entry.isDirectory())).toEqual([])
        expect(() => process.kill(childPid, 0)).toThrow()
        reader.releaseLock()
      }).pipe(
        Effect.ensuring(
          Effect.orDie(
            Effect.gen(function* () {
              if (helper.exitCode === null) helper.kill("SIGKILL")
              yield* Effect.tryPromise(() => helper.exited)
              if (
                mode === "descendant" &&
                (yield* Effect.tryPromise(() => Bun.file(callsPath + ".descendant").exists()))
              ) {
                process.kill(
                  Number(
                    yield* Effect.tryPromise(() => Bun.file(callsPath + ".descendant").text())
                  ),
                  "SIGKILL"
                )
              }
            })
          )
        )
      )
    }
  }),
  15000
)

testEffect(
  "a late confirmation for a disconnected caller stays out of Desktop traffic",
  Effect.gen(function* () {
    const directory = yield* temporaryDirectory(join(tmpdir(), "nudge-late-reply-"))
    const socketPath = join(directory, "bridge.sock")
    const nativePath = join(directory, "native.mjs")
    const callsPath = join(directory, "calls")
    yield* buildFixture("native-cancel", nativePath)
    const helper = yield* spawnScoped(() =>
      Bun.spawn([Bun.env["NUDGE_TEST_NODE"] ?? "node", bridgePath], {
        env: {
          ...environment,
          NUDGE_CODEX_APP_TOOLS_SERVER: nativePath,
          NUDGE_CODEX_BRIDGE_SOCKET: socketPath,
          CODEX_APP_TOOLS_PIPE_PATH: "fixture",
          FAKE_NATIVE_CALLS_PATH: callsPath
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000
      })
    )
    yield* waitForSocket(socketPath)
    const reader = helper.stdout.getReader()
    helper.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) + "\n")
    helper.stdin.flush()
    expect(JSON.parse(yield* readLine(reader)).id).toBe(1)
    const canceled = yield* Effect.forkScoped(
      sendEffect({ socketPath, targetThreadId: "target", prompt: "first", timeoutMs: 2000 })
    )
    yield* waitForFileText(callsPath, "first\n")
    yield* Fiber.interrupt(canceled)
    yield* Fiber.await(canceled)
    yield* sendViaCodexBridge({
      socketPath,
      targetThreadId: "target",
      prompt: "second",
      timeoutMs: 2000
    })
    helper.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize" }) + "\n")
    helper.stdin.flush()
    expect(JSON.parse(yield* readLine(reader)).id).toBe(2)
    expect(yield* Effect.tryPromise(() => Bun.file(callsPath).text())).toBe("first\nsecond\n")
    reader.releaseLock()
  })
)

for (const mode of ["timeout", "denied", "replacement"]) {
  testEffect(
    `a ${mode} probe does not remove another bridge socket`,
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory(join(tmpdir(), "nudge-probe-"))
      const socketPath = join(directory, "bridge.sock")
      const observed = join(directory, "observed")
      const nativePath = join(directory, "native.mjs")
      const fixturePath = join(directory, "probe.mjs")
      yield* buildFixture("native-takeover", nativePath)
      yield* buildFixture("probe", fixturePath)
      const sockets =
        mode === "replacement" ? [socketPath, socketPath + ".replacement"] : [socketPath]
      for (const path of sockets) {
        yield* Effect.acquireRelease(
          Effect.sync(() => Bun.listen({ unix: path, socket: { data() {} } })),
          (server) => Effect.sync(() => server.stop(true))
        )
      }
      const expected = yield* Effect.tryPromise(() => lstat(sockets.at(-1)!))
      yield* spawnScoped(() =>
        Bun.spawn([Bun.env["NUDGE_TEST_NODE"] ?? "node", fixturePath], {
          env: {
            ...environment,
            NUDGE_CODEX_APP_TOOLS_SERVER: nativePath,
            NUDGE_CODEX_BRIDGE_SOCKET: socketPath,
            CODEX_APP_TOOLS_PIPE_PATH: "fixture",
            FAKE_NATIVE_CALLS_PATH: join(directory, "calls"),
            FIXTURE_BRIDGE_PATH: bridgePath,
            OBSERVED_PATH: observed,
            PROBE_MODE: mode
          },
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          timeout: 5000
        })
      )
      yield* waitForFileText(observed, "retried")
      const actual = yield* Effect.tryPromise(() => lstat(socketPath))
      expect(actual.ino).toBe(expected.ino)
      expect(actual.dev).toBe(expected.dev)
    })
  )
}

for (const direction of ["input", "output"] as const) {
  testEffect(
    `the Node helper bounds ${direction} buffering and drains every frame`,
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory(join(tmpdir(), "nudge-backpressure-"))
      const nativePath = join(directory, "native.mjs")
      yield* buildFixture("native-backpressure", nativePath)
      const readerPath = join(directory, "reader.mjs")
      if (direction === "output") yield* buildFixture("backpressure-reader", readerPath)
      const helper = yield* spawnScoped(() =>
        Bun.spawn(
          [Bun.env["NUDGE_TEST_NODE"] ?? "node", direction === "output" ? readerPath : bridgePath],
          {
            env: {
              ...environment,
              NUDGE_CODEX_APP_TOOLS_SERVER: nativePath,
              FIXTURE_DIRECTORY: directory,
              FIXTURE_HELPER_PATH: bridgePath,
              FIXTURE_DIRECTION: direction
            },
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe"
          }
        )
      )
      yield* waitForFileText(join(directory, "ready"), "ready")
      const count = 2048
      const data = "x".repeat(8192)
      if (direction === "input") {
        const frames = Array.from(
          { length: count },
          (_, id) => JSON.stringify({ jsonrpc: "2.0", id, data }) + "\n"
        ).join("")
        let completed = false
        const writer = yield* Effect.forkScoped(
          Effect.gen(function* () {
            yield* Effect.tryPromise(() => Promise.resolve(helper.stdin.write(frames)))
            yield* Effect.tryPromise(() => Promise.resolve(helper.stdin.flush()))
            completed = true
          })
        )
        yield* Effect.sleep(300)
        expect(completed).toBe(false)
        yield* Effect.tryPromise(() => Bun.write(join(directory, "release"), "release"))
        yield* Fiber.join(writer)
      } else {
        yield* Effect.sleep(300)
        expect(yield* Effect.tryPromise(() => Bun.file(join(directory, "done")).exists())).toBe(
          false
        )
        yield* Effect.tryPromise(() => Bun.write(join(directory, "release"), "release"))
        const reader = yield* Effect.acquireRelease(
          Effect.sync(() => helper.stdout.getReader()),
          (stream) => Effect.promise(() => stream.cancel())
        )
        let received = 0
        let buffer = ""
        const decoder = new TextDecoder()
        while (received < count) {
          const chunk = yield* Effect.tryPromise(() => reader.read())
          expect(chunk.done).toBe(false)
          buffer += decoder.decode(chunk.value, { stream: true })
          for (;;) {
            const newline = buffer.indexOf("\n")
            if (newline === -1) break
            const message = JSON.parse(buffer.slice(0, newline))
            buffer = buffer.slice(newline + 1)
            expect(message).toEqual({ jsonrpc: "2.0", id: received++, data })
          }
        }
        expect(received).toBe(count)
        expect(buffer).toBe("")
      }
      yield* waitForFileText(join(directory, "done"), "done")
    }),
    10000
  )
}
