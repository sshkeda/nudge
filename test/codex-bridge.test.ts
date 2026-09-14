import { expect } from "bun:test"
import { chmod, mkdir } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect, Fiber, Deferred, FiberSet } from "effect"

import { sendViaCodexBridge as sendEffect } from "../src/codex/bridge.ts"
import { temporaryDirectory, listen, testEffect } from "./support.ts"

type BridgeRequestFixture = {
  readonly id: string
  readonly targetThreadId: string
  readonly sourceThreadId?: string
  readonly prompt: string
  readonly version: number
}

testEffect(
  "sends one correlated delivery request through a private bridge socket",
  Effect.gen(function* () {
    const directory = yield* temporaryDirectory(join(tmpdir(), "nudge-bridge-client-"))
    const socketPath = join(directory, "bridge.sock")
    let received: BridgeRequestFixture | undefined
    const server = createServer((socket) => {
      let body = ""
      socket.setEncoding("utf8")
      socket.on("data", (chunk) => {
        body += chunk
        if (!body.includes("\n")) return
        // SAFETY: this fixture owns the only writer and asserts every field below.
        const request = JSON.parse(body.trim()) as BridgeRequestFixture
        received = request
        socket.end(
          `${JSON.stringify({
            version: 1,
            id: request.id,
            status: "delivered",
            targetThreadId: request.targetThreadId
          })}\n`
        )
      })
    })
    yield* listen(server, socketPath)
    yield* Effect.tryPromise(() => chmod(socketPath, 0o600))
    yield* sendViaCodexBridge({
      socketPath,
      targetThreadId: "target-thread",
      sourceThreadId: "source-thread",
      prompt: "hello stored task",
      timeoutMs: 500
    })
    expect(received).toMatchObject({
      version: 1,
      targetThreadId: "target-thread",
      sourceThreadId: "source-thread",
      prompt: "hello stored task"
    })
  })
)

testEffect(
  "preserves an error returned by the bridge",
  Effect.gen(function* () {
    const directory = yield* temporaryDirectory(join(tmpdir(), "nudge-bridge-refusal-"))
    const socketPath = join(directory, "bridge.sock")
    const server = createServer((socket) => {
      socket.once("data", () => {
        socket.end(
          `${JSON.stringify({
            version: 1,
            status: "error",
            error: "destination task was archived"
          })}\n`
        )
      })
    })
    yield* listen(server, socketPath)
    yield* Effect.tryPromise(() => chmod(socketPath, 0o600))
    yield* Effect.map(
      Effect.flip(
        sendViaCodexBridge({
          socketPath,
          targetThreadId: "target-thread",
          prompt: "hello",
          timeoutMs: 500
        })
      ),
      (error) =>
        expect(error).toMatchObject({
          message: "destination task was archived",
          code: "bridge-error"
        })
    )
  })
)

testEffect(
  "native socket writes survive backpressure and decode split UTF-8 responses",
  Effect.gen(function* () {
    const directory = yield* temporaryDirectory(join(tmpdir(), "nudge-bridge-backpressure-"))
    const socketPath = join(directory, "bridge.sock")
    const prompt = "🦊".repeat(500000)
    let receivedPrompt = ""
    const run = yield* FiberSet.makeRuntime<never>()
    const server = createServer((socket) => {
      socket.pause()
      run(
        Effect.andThen(
          Effect.sleep(50),
          Effect.sync(() => socket.resume())
        )
      )
      let body = ""
      socket.setEncoding("utf8")
      socket.on("data", (chunk) => {
        body += chunk
        if (!body.endsWith("\n")) return
        const request: BridgeRequestFixture = JSON.parse(body)
        receivedPrompt = request.prompt
        const response = Buffer.from(
          JSON.stringify({
            version: 1,
            id: request.id,
            status: "delivered",
            targetThreadId: request.targetThreadId
          })
        )
        const split = response.indexOf(Buffer.from("🦊")) + 1
        socket.write(response.subarray(0, split))
        run(
          Effect.andThen(
            Effect.sleep(10),
            Effect.sync(() => socket.end(response.subarray(split)))
          )
        )
      })
    })
    yield* listen(server, socketPath)
    yield* Effect.tryPromise(() => chmod(socketPath, 0o600))
    yield* sendViaCodexBridge({
      socketPath,
      targetThreadId: "target-🦊",
      prompt,
      timeoutMs: 2000
    })
    expect(receivedPrompt).toBe(prompt)
  })
)

testEffect(
  "native socket timeouts close the connection",
  Effect.gen(function* () {
    const directory = yield* temporaryDirectory(join(tmpdir(), "nudge-bridge-timeout-"))
    const socketPath = join(directory, "bridge.sock")
    const disconnected = yield* Deferred.make<void>()
    const server = createServer((socket) => {
      socket.resume()
      socket.once("close", () => Deferred.doneUnsafe(disconnected, Effect.void))
    })
    yield* listen(server, socketPath)
    yield* Effect.tryPromise(() => chmod(socketPath, 0o600))
    yield* Effect.map(
      Effect.flip(
        sendViaCodexBridge({
          socketPath,
          targetThreadId: "target",
          prompt: "hello",
          timeoutMs: 100
        })
      ),
      (error) =>
        expect(() => {
          throw error
        }).toThrow("delivery outcome is unknown")
    )
    yield* Deferred.await(disconnected)
  }),
  2000
)

testEffect(
  "interrupting delivery closes the connection without waiting for its timeout",
  Effect.gen(function* () {
    const directory = yield* temporaryDirectory(join(tmpdir(), "nudge-bridge-interrupt-"))
    const socketPath = join(directory, "bridge.sock")
    const received = yield* Deferred.make<void>()
    const disconnected = yield* Deferred.make<void>()
    const server = createServer((socket) => {
      socket.once("data", () => Deferred.doneUnsafe(received, Effect.void))
      socket.once("close", () => Deferred.doneUnsafe(disconnected, Effect.void))
    })
    yield* listen(server, socketPath)
    yield* Effect.tryPromise(() => chmod(socketPath, 0o600))
    const fiber = yield* Effect.forkScoped(
      sendEffect({
        socketPath,
        targetThreadId: "target",
        prompt: "hello",
        timeoutMs: 180000
      })
    )
    yield* Deferred.await(received)
    yield* Fiber.interrupt(fiber)
    yield* Deferred.await(disconnected)
  }),
  2000
)

function sendViaCodexBridge(options: Parameters<typeof sendEffect>[0]) {
  return sendEffect(options)
}

testEffect(
  "bridge socket failures distinguish a missing socket from an unreadable one",
  Effect.gen(function* () {
    const directory = yield* temporaryDirectory(join(tmpdir(), "nudge-bridge-access-"))
    const missing = join(directory, "missing.sock")
    const absent = yield* Effect.flip(
      sendEffect({ targetThreadId: "t", prompt: "p", timeoutMs: 1000, socketPath: missing })
    )
    expect(absent.message).toBe(`no Codex bridge socket at ${missing}`)

    const sealed = join(directory, "sealed")
    yield* Effect.tryPromise(() => mkdir(sealed, { mode: 0o700 }))
    const socketPath = join(sealed, "bridge.sock")
    yield* listen(createServer(), socketPath)
    yield* Effect.acquireRelease(
      Effect.tryPromise(() => chmod(sealed, 0o000)),
      () => Effect.promise(() => chmod(sealed, 0o700))
    )
    const unreadable = yield* Effect.flip(
      sendEffect({ targetThreadId: "t", prompt: "p", timeoutMs: 1000, socketPath })
    )
    expect(unreadable.message).toStartWith(`cannot inspect Codex bridge socket at ${socketPath}: `)
    expect(unreadable.message).not.toContain("no Codex bridge socket")
  })
)
