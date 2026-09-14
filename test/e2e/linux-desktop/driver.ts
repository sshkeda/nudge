#!/usr/bin/env bun

import { readdir, readlink, stat } from "node:fs/promises"
import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"

import { BunHttpClient } from "@effect/platform-bun"
import { Cause, Effect, Exit, Schema, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"

import { waitUntil } from "./commands.ts"
import { spawnScoped, StdioJsonRpc } from "./process"

const JournalSchema = Schema.Array(
  Schema.Struct({
    method: Schema.String,
    path: Schema.String,
    headers: Schema.Record(Schema.String, Schema.String),
    response: Schema.optional(
      Schema.Struct({
        status: Schema.Int,
        fixture: Schema.optional(
          Schema.Struct({
            match: Schema.optional(
              Schema.Struct({
                userMessage: Schema.optional(Schema.String),
                toolResultContains: Schema.optional(Schema.String)
              })
            )
          })
        )
      })
    )
  })
)

const ListSchema = Schema.Struct({
  targets: Schema.Array(
    Schema.Struct({ provider: Schema.String, id: Schema.String, name: Schema.String })
  )
})

const SendSchema = Schema.Struct({ status: Schema.String, delivery: Schema.String })

const InitializeResultSchema = Schema.Struct({ codexHome: Schema.String })

const ThreadStartResultSchema = Schema.Struct({
  modelProvider: Schema.String,
  thread: Schema.Struct({ id: Schema.String, path: Schema.String })
})

const TurnStartResultSchema = Schema.Struct({ turn: Schema.Struct({ id: Schema.String }) })

const McpInitializeResultSchema = Schema.Struct({
  serverInfo: Schema.Struct({ name: Schema.String, version: Schema.String })
})

const ToolsListResultSchema = Schema.Struct({
  tools: Schema.Array(Schema.Struct({ name: Schema.String }))
})

const EmptyResultSchema = Schema.Struct({})

const RolloutLineSchema = Schema.Struct({
  type: Schema.optional(Schema.String),
  payload: Schema.optional(
    Schema.Struct({
      type: Schema.optional(Schema.String),
      name: Schema.optional(Schema.String),
      role: Schema.optional(Schema.String),
      output: Schema.optional(Schema.String),
      content: Schema.optional(
        Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }))
      )
    })
  )
})

const environment = (name: string): string => {
  const value = Bun.env[name]
  if (value === undefined || value === "") throw new Error(`missing ${name}`)
  return value
}

const payload = environment("E2E_PAYLOAD")
const marker = environment("E2E_MARKER")
const aimockPort = environment("E2E_AIMOCK_PORT")
const workspace = environment("E2E_WORKSPACE")
const resources = environment("E2E_RESOURCES")
const stateDirectory = environment("E2E_STATE_DIR")
const out = environment("E2E_OUT")
const codexHome = environment("CODEX_HOME")

const appToolsDirectory = join(resources, "plugins/openai-bundled/plugins/codex-app-tools")
const appToolsLauncher = join(appToolsDirectory, "scripts/launch_codex_app_tools_mcp")
const nudge = "nudge"
const bridgePath = join(stateDirectory, "codex", "desktop-bridge.sock")
const sessionIndex = join(codexHome, "session_index.jsonl")

type EvidenceValue = string | number | boolean | readonly string[]
const evidence: Record<string, EvidenceValue> = {}

function log(message: string): void {
  process.stdout.write(`driver:     ${message}\n`)
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`)
}

const journal = Effect.fn("journal")(function* () {
  const client = HttpClient.withScope(yield* HttpClient.HttpClient)
  const response = yield* client.get(`http://127.0.0.1:${aimockPort}/__aimock/journal`)
  assert(
    response.status >= 200 && response.status < 300,
    `aimock journal returned ${response.status}`
  )
  return yield* HttpClientResponse.schemaBodyJson(JournalSchema)(response)
}, Effect.scoped)

const bridgeIsListening = Effect.fn("bridgeIsListening")(function* (path: string) {
  const stats = yield* Effect.tryPromise(() => stat(path)).pipe(
    Effect.catch(() => Effect.succeed(null))
  )
  if (stats === null || !stats.isSocket()) return false
  return yield* Effect.callback<boolean>((resume) => {
    let connection: Bun.Socket | undefined
    let closed = false
    void Bun.connect<undefined>({
      unix: path,
      socket: {
        open(socket) {
          connection = socket
          socket.end()
          if (!closed) resume(Effect.succeed(true))
        },
        data() {},
        error() {
          resume(Effect.succeed(false))
        }
      }
    }).catch(() => resume(Effect.succeed(false)))
    return Effect.sync(() => {
      closed = true
      connection?.terminate()
    })
  })
})

const assertLinuxDesktopBridge = Effect.fn("assertDesktopBridge")(function* () {
  const sockets = yield* Effect.tryPromise(() => Bun.file("/proc/net/unix").text())
  const published = yield* Effect.tryPromise(() => stat(bridgePath))
  let inode: string | undefined
  for (const line of sockets.split("\n")) {
    const fields = line.trim().split(/\s+/)
    if (fields[3] !== "00010000" || fields.length < 8) continue
    const bound = yield* Effect.tryPromise(() => stat(fields.slice(7).join(" "))).pipe(
      Effect.catch(() => Effect.succeed(null))
    )
    if (bound?.dev === published.dev && bound.ino === published.ino) {
      inode = fields[6]
      break
    }
  }
  assert(inode !== undefined, "bridge socket is absent from the kernel socket table")
  const processes = (yield* Effect.tryPromise(() => readdir("/proc"))).filter((name) =>
    /^\d+$/.test(name)
  )
  const parentOf = Effect.fn("parentOf")(function* (pid: string) {
    const status = yield* Effect.tryPromise(() => Bun.file(`/proc/${pid}/status`).text())
    const parent = /^PPid:\s+(\d+)/m.exec(status)?.[1]
    assert(parent !== undefined, `missing parent for ${pid}`)
    return parent
  })
  for (const pid of processes) {
    const fds = yield* Effect.tryPromise(() => readdir(`/proc/${pid}/fd`)).pipe(
      Effect.catch(() => Effect.succeed([]))
    )
    const links = yield* Effect.forEach(
      fds,
      (fd) =>
        Effect.tryPromise(() => readlink(`/proc/${pid}/fd/${fd}`)).pipe(
          Effect.catch(() => Effect.succeed(""))
        ),
      { concurrency: "unbounded" }
    )
    if (!links.includes(`socket:[${inode}]`)) continue
    const executable = yield* Effect.tryPromise(() => readlink(`/proc/${pid}/exe`))
    assert(
      executable === join(resources, "cua_node/bin/node"),
      `bridge uses unexpected runtime: ${executable}`
    )
    const env = (yield* Effect.tryPromise(() => Bun.file(`/proc/${pid}/environ`).text())).split(
      "\0"
    )
    const helperOptions = env.find((value) => value.startsWith("NODE_OPTIONS="))
    assert(
      helperOptions === 'NODE_OPTIONS=--import="/repo/dist/codex-desktop-helper.mjs"',
      `bridge did not inherit the README NODE_OPTIONS: ${helperOptions}`
    )
    evidence["bridgeNodeOptions"] = helperOptions
    const backend = yield* parentOf(pid)
    assert(
      (yield* Effect.tryPromise(() => readlink(`/proc/${backend}/exe`))) ===
        join(resources, "codex"),
      "bridge was not started by Desktop's backend"
    )
    const desktop = yield* parentOf(backend)
    assert(
      (yield* Effect.tryPromise(() => readlink(`/proc/${desktop}/exe`))) ===
        "/usr/lib/chatgpt/ChatGPT",
      "backend was not started by Desktop"
    )
    const child = (yield* Effect.forEach(
      processes,
      (candidate) =>
        Effect.gen(function* () {
          if ((yield* parentOf(candidate)) !== pid) return null
          const exe = yield* Effect.tryPromise(() => readlink(`/proc/${candidate}/exe`))
          const args = (yield* Effect.tryPromise(() =>
            Bun.file(`/proc/${candidate}/cmdline`).text()
          )).split("\0")
          return exe === executable && args.includes(join(appToolsDirectory, "server.mjs"))
            ? candidate
            : null
        }).pipe(Effect.catch(() => Effect.succeed(null))),
      { concurrency: "unbounded" }
    )).find((candidate) => candidate !== null)
    assert(child !== undefined, "bridge did not launch Desktop's bundled app-tools server")
    evidence["desktopPid"] = desktop
    evidence["desktopBackendPid"] = backend
    evidence["bridgePid"] = pid
    evidence["bundledServerPid"] = child
    log(
      `startup:    Desktop ${desktop} -> backend ${backend} -> bridge ${pid} -> bundled server ${child}`
    )
    return
  }
  return yield* Effect.fail(new Error("no process owns the bridge socket"))
})

const assertDesktopBridge = Effect.fn("assertDesktopBridge")(function* () {
  if (process.platform !== "darwin") return yield* assertLinuxDesktopBridge()
  const run = (...args: string[]) => {
    const result = Bun.spawnSync(args)
    assert(result.exitCode === 0, `${args[0]} failed: ${result.stderr}`)
    return result.stdout.toString()
  }
  const processes = run("/bin/ps", "-axo", "pid=,ppid=,command=")
  const sockets = run("/usr/sbin/lsof", "-n", "-U", "-Fpcn")
  yield* Effect.tryPromise(() => Bun.write(join(out, "macos-processes.txt"), processes))
  yield* Effect.tryPromise(() => Bun.write(join(out, "macos-unix-sockets.txt"), sockets))
  const published = yield* Effect.tryPromise(() => stat(bridgePath))
  let owner = ""
  let pid = ""
  for (const line of sockets.split("\n")) {
    if (line.startsWith("p")) pid = line.slice(1)
    if (line.startsWith("n/")) {
      const bound = yield* Effect.tryPromise(() => stat(line.slice(1))).pipe(
        Effect.catch(() => Effect.succeed(null))
      )
      if (bound?.dev === published.dev && bound.ino === published.ino) owner = pid
    }
  }
  assert(owner !== "", "lsof did not find the bridge socket owner")
  const rows = processes
    .trim()
    .split("\n")
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)
      assert(match !== null, `invalid ps row: ${line}`)
      return { pid: match[1]!, parent: match[2]!, command: match[3]! }
    })
  const helper = rows.find((row) => row.pid === owner)
  assert(helper !== undefined, "bridge owner is missing from ps")
  const runtime = join(resources, "cua_node/bin/node")
  assert(helper.command.startsWith(runtime), `unexpected helper runtime: ${helper.command}`)
  const backend = rows.find((row) => row.pid === helper.parent)
  assert(
    backend?.command.startsWith(join(resources, "codex")) === true,
    "helper parent is not bundled backend"
  )
  const desktop = rows.find((row) => row.pid === backend!.parent)
  assert(
    desktop?.command.startsWith(environment("E2E_DESKTOP_EXECUTABLE")) === true,
    "backend parent is not Desktop"
  )
  const server = rows.find((row) => row.parent === owner && row.command.startsWith(runtime))
  assert(server !== undefined, "helper did not start its native server")
  const serverPath = server.command.slice(runtime.length).trim().split(" ")[0]!
  assert(serverPath === join(appToolsDirectory, "server.mjs"), "unexpected native server path")
  const hash = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
  const serverHash = hash(yield* Effect.tryPromise(() => Bun.file(serverPath).bytes()))
  assert(
    serverHash ===
      hash(yield* Effect.tryPromise(() => Bun.file(join(appToolsDirectory, "server.mjs")).bytes())),
    "native server differs from signed app bundle"
  )
  evidence["nativeServerPath"] = serverPath
  evidence["nativeServerSha256"] = serverHash
  const env = run("/bin/ps", "eww", "-p", owner, "-o", "command=")
  const expected = `NODE_OPTIONS=--import="${environment("E2E_REPO")}/dist/codex-desktop-helper.mjs"`
  assert(
    env.includes(expected + " ") || env.endsWith(expected + "\n"),
    "helper did not inherit exact README NODE_OPTIONS"
  )
  yield* Effect.tryPromise(() => Bun.write(join(out, "macos-helper-environment.txt"), env))
  evidence["bridgeNodeOptions"] = expected
  evidence["desktopPid"] = desktop!.pid
  evidence["desktopBackendPid"] = backend!.pid
  evidence["bridgePid"] = owner
  evidence["bundledServerPid"] = server.pid
  log(
    `startup: Desktop ${desktop!.pid} -> backend ${backend!.pid} -> bridge ${owner} -> bundled server ${server.pid}`
  )
})

function rolloutLine(line: string): Schema.Schema.Type<typeof RolloutLineSchema> | null {
  try {
    return Schema.decodeUnknownSync(RolloutLineSchema)(JSON.parse(line))
  } catch {
    return null
  }
}

function isPayloadDelivery(line: string): boolean {
  const event = rolloutLine(line)
  return (
    event?.type === "response_item" &&
    event.payload?.type === "function_call_output" &&
    event.payload.name === "send_message_to_thread" &&
    event.payload.output?.includes(
      `<input>Message from Codex task "nudge e2e source" (${evidence["sourceThreadId"]}) via nudge CLI:\n\n${payload}</input>`
    ) === true
  )
}

function isMarkerAnswer(line: string): boolean {
  const event = rolloutLine(line)
  return (
    event?.type === "response_item" &&
    event.payload?.role === "assistant" &&
    event.payload.content?.some((part) => part.type === "output_text" && part.text === marker) ===
      true
  )
}

const rolloutFiles = Effect.fn("rolloutFiles")(function* () {
  return yield* Stream.fromAsyncIterable(
    new Bun.Glob("**/*.jsonl").scan({ cwd: join(codexHome, "sessions"), absolute: true }),
    (cause) => cause
  ).pipe(Stream.runCollect)
})

const bootstrapSource = Effect.gen(function* () {
  const bootstrap = yield* spawnScoped(() =>
    Bun.spawn([join(resources, "codex"), "app-server"], {
      cwd: workspace,
      env: { ...process.env, RUST_LOG: "error" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe"
    })
  )

  yield* Stream.runDrain(
    Stream.fromReadableStream({ evaluate: () => bootstrap.stderr, onError: (cause) => cause })
  ).pipe(Effect.forkScoped)
  const codex = yield* StdioJsonRpc.make(bootstrap)
  const initialized = yield* codex.request(
    "initialize",
    { clientInfo: { name: "nudge-linux-e2e", version: "1.0.0" } },
    InitializeResultSchema
  )
  yield* codex.notify("initialized")
  assert(initialized.codexHome === codexHome, `unexpected CODEX_HOME ${initialized.codexHome}`)

  const started = yield* codex.request(
    "thread/start",
    {
      cwd: workspace,
      model: "mock-model",
      modelProvider: "aimock"
    },
    ThreadStartResultSchema
  )
  assert(started.modelProvider === "aimock", `thread is not on aimock: ${started.modelProvider}`)
  yield* codex.request(
    "thread/name/set",
    {
      threadId: started.thread.id,
      name: process.argv[2] === "--bootstrap-target" ? "nudge e2e destination" : "nudge e2e source"
    },
    EmptyResultSchema
  )
  yield* waitUntil(
    `Codex to index nudge e2e source`,
    Effect.gen(function* () {
      const body = yield* Effect.tryPromise(() => Bun.file(sessionIndex).text()).pipe(
        Effect.catch(() => Effect.succeed(""))
      )
      return body.includes(started.thread.id) ? true : null
    }),
    30_000
  )
  yield* codex.request(
    "turn/start",
    { threadId: started.thread.id, input: [{ type: "text", text: "BOOTSTRAP-TURN" }] },
    TurnStartResultSchema
  )
  yield* codex.waitForNotification("turn/completed").pipe(Effect.timeout("120 seconds"))
  yield* waitUntil(
    `the rollout file of nudge e2e source`,
    Effect.tryPromise(() => Bun.file(started.thread.path).exists()).pipe(
      Effect.map((exists) => (exists ? true : null))
    ),
    30_000
  )
  log(`thread:     ${started.thread.id} nudge e2e source`)
  const source = started.thread
  yield* Effect.tryPromise(() => Promise.resolve(bootstrap.stdin.end()))
  const bootstrapExit = yield* Effect.promise(() => bootstrap.exited).pipe(Effect.timeout(10_000))
  assert(bootstrapExit === 0, `bootstrap exited with code ${bootstrapExit}`)

  yield* Effect.tryPromise(() =>
    Bun.write(
      join(out, process.argv[2] === "--bootstrap-target" ? "target.json" : "source.json"),
      JSON.stringify(source)
    )
  )
})

const main = Effect.gen(function* () {
  assert(
    Bun.which(nudge) === join(environment("HOME"), ".bun/bin/nudge"),
    "nudge is not installed on PATH"
  )
  assert(
    yield* Effect.tryPromise(() => Bun.file(join(appToolsDirectory, "server.mjs")).exists()),
    "missing Desktop server.mjs"
  )
  const pipePath =
    process.platform === "darwin" ? "macOS signed Desktop connection" : environment("E2E_PIPE_PATH")
  log(`payload:    ${payload}`)
  if (process.platform !== "darwin") log(`transport:  ${pipePath}`)

  const source = Schema.decodeUnknownSync(ThreadStartResultSchema.fields.thread)(
    JSON.parse(yield* Effect.tryPromise(() => Bun.file(join(out, "source.json")).text()))
  )
  evidence["sourceThreadId"] = source.id
  const baseline = process.argv[2] === "--baseline"
  let appToolsErrors = ""
  const { target, appToolsClient } = yield* Effect.gen(function* () {
    if (process.platform === "darwin") {
      const macTarget = Schema.decodeUnknownSync(ThreadStartResultSchema.fields.thread)(
        JSON.parse(yield* Effect.tryPromise(() => Bun.file(join(out, "target.json")).text()))
      )
      const opened = Bun.spawnSync(["/usr/bin/open", `codex://threads/${macTarget.id}`])
      assert(opened.exitCode === 0, "Desktop task deep link failed")
      yield* waitUntil(
        "Desktop renderer to resume the target",
        Effect.tryPromise(() =>
          Bun.file(join(out, `${baseline ? "baseline" : "installed"}-desktop.log`)).text()
        ).pipe(
          Effect.map((text) =>
            text
              .split("\n")
              .some(
                (line) =>
                  line.includes("maybe_resume_success") &&
                  line.includes(`conversationId=${macTarget.id}`)
              )
              ? true
              : null
          )
        ),
        90_000
      )

      return { target: macTarget, appToolsClient: null }
    }
    const appTools = yield* spawnScoped(() =>
      Bun.spawn([appToolsLauncher, "./server.mjs"], {
        cwd: appToolsDirectory,
        env: {
          ...process.env,
          CODEX_APP_TOOLS_PIPE_PATH: pipePath,
          CODEX_ELECTRON_RESOURCES_PATH: resources,
          CODEX_MCP_NODE_PATH: join(resources, "cua_node", "bin", "node")
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe"
      })
    )

    yield* Stream.runForEach(
      Stream.fromReadableStream({ evaluate: () => appTools.stderr, onError: (cause) => cause }),
      (chunk) =>
        Effect.sync(() => {
          appToolsErrors += new TextDecoder().decode(chunk)
        })
    ).pipe(Effect.forkScoped)
    const setupClient = yield* StdioJsonRpc.make(appTools)
    const mcp = yield* setupClient.request(
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "nudge-linux-e2e", version: "1.0.0" }
      },
      McpInitializeResultSchema
    )
    yield* setupClient.notify("notifications/initialized")
    assert(
      mcp.serverInfo.name === "codex-app-tools",
      `unexpected MCP server ${mcp.serverInfo.name}`
    )
    log(
      `app-tools:  ${mcp.serverInfo.name} ${mcp.serverInfo.version} (Desktop's bundle, test setup client)`
    )
    evidence["appToolsServer"] = `${mcp.serverInfo.name} ${mcp.serverInfo.version}`

    const toolsFrame = yield* setupClient.call("tools/list", {})
    assert(
      toolsFrame.error === undefined,
      `tools/list failed: ${JSON.stringify(toolsFrame.error)}\nshim stderr:\n${appToolsErrors}`
    )
    yield* Effect.tryPromise(() =>
      Bun.write(join(out, "desktop-tools.json"), `${JSON.stringify(toolsFrame.result, null, 2)}\n`)
    )
    const tools = Schema.decodeUnknownSync(ToolsListResultSchema)(toolsFrame.result)
    const toolNames = tools.tools.map((tool) => tool.name)
    evidence["desktopTools"] = toolNames
    log(`desktop:    tools/list answered by the live app: ${toolNames.length} tool(s)`)
    assert(
      toolNames.includes("send_message_to_thread"),
      `Desktop did not offer send_message_to_thread: ${JSON.stringify(toolNames)}`
    )

    const destination = yield* Effect.gen(function* () {
      if (!baseline) {
        return Schema.decodeUnknownSync(ThreadStartResultSchema.fields.thread)(
          JSON.parse(yield* Effect.tryPromise(() => Bun.file(join(out, "target.json")).text()))
        )
      }
      const created = yield* setupClient.call("tools/call", {
        name: "create_thread",
        arguments: {
          prompt: "CREATE-THREAD-PROBE",
          title: "nudge e2e destination",
          target: { type: "projectless" }
        },
        _meta: {
          "openai/threadId": source.id,
          "openai/toolCallId": "nudge-e2e-create",
          "openai/turnId": "nudge-e2e-create"
        }
      })
      const createdJson = JSON.stringify(
        created.error === undefined ? created.result : { error: created.error },
        null,
        2
      )
      evidence["createThread"] = createdJson
      yield* Effect.tryPromise(() =>
        Bun.write(join(out, "create-thread-result.json"), `${createdJson}\n`)
      )
      const result = Schema.decodeUnknownSync(
        Schema.Struct({
          isError: Schema.optional(Schema.Boolean),
          content: Schema.Array(
            Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })
          )
        })
      )(created.result)
      assert(
        created.error === undefined && result.isError !== true,
        `Desktop create_thread failed: ${createdJson}`
      )
      let createdId: string | undefined
      for (const item of result.content) {
        if (item.type !== "text" || item.text === undefined) continue
        try {
          createdId = Schema.decodeUnknownSync(Schema.Struct({ threadId: Schema.String }))(
            JSON.parse(item.text)
          ).threadId
          break
        } catch {}
      }
      assert(
        createdId !== undefined && createdId !== source.id,
        "Desktop create_thread returned no destination ID"
      )
      const destinationId = createdId
      const createdTarget = yield* waitUntil(
        `Desktop's new thread ${destinationId} on disk`,
        Effect.gen(function* () {
          const body = yield* Effect.tryPromise(() => Bun.file(sessionIndex).text()).pipe(
            Effect.catch(() => Effect.succeed(""))
          )
          if (!body.includes(destinationId)) return null
          for (const file of yield* rolloutFiles()) {
            if (file.includes(destinationId)) return { id: destinationId, path: file }
          }
          return null
        }),
        60_000
      )
      yield* Effect.tryPromise(() =>
        Bun.write(join(out, "target.json"), JSON.stringify(createdTarget))
      )
      return createdTarget
    })
    return { target: destination, appToolsClient: setupClient }
  })
  evidence["targetThreadId"] = target.id
  evidence["targetRollout"] = target.path
  evidence["targetCreatedBy"] =
    process.platform === "darwin"
      ? "bundled app-server thread/start, opened with Desktop deep link"
      : "Desktop create_thread"
  log(`target:     ${target.id} (${evidence["targetCreatedBy"]})`)

  const nudgeEnvironment = {
    PATH: Bun.env["PATH"] ?? "",
    HOME: Bun.env["HOME"] ?? "",
    CLAUDE_CONFIG_DIR: join(workspace, "..", "claude-config"),
    CODEX_THREAD_ID: source.id
  } satisfies Record<string, string>

  const listed = Bun.spawnSync([nudge, "list", "--json"], { env: nudgeEnvironment })
  assert(listed.exitCode === 0, `nudge list failed: ${listed.stderr.toString()}`)
  const targets = Schema.decodeUnknownSync(ListSchema)(
    JSON.parse(listed.stdout.toString())
  ).targets.filter((entry) => entry.provider === "codex")
  const ids = targets.map((entry) => entry.id)
  const known = new Set([source.id, target.id])
  assert(
    ids.includes(source.id) && ids.includes(target.id) && ids.every((id) => known.has(id)),
    `nudge should see only this run's isolated threads, saw ${JSON.stringify(targets)}`
  )
  log(
    `nudge list: ${ids.length} Codex target(s) from session_index.jsonl + state_*.sqlite, including ${target.id}`
  )

  if (appToolsClient !== null) {
    const phase = baseline ? "baseline" : "installed"
    const startupMessage = `nudge-helper-startup-${phase}`
    const started = yield* appToolsClient.call("tools/call", {
      name: "send_message_to_thread",
      arguments: { threadId: target.id, prompt: startupMessage },
      _meta: {
        "openai/threadId": source.id,
        "openai/toolCallId": `nudge-e2e-startup-${phase}`,
        "openai/turnId": `nudge-e2e-startup-${phase}`
      }
    })
    const result = Schema.decodeUnknownSync(
      Schema.Struct({ isError: Schema.optional(Schema.Boolean) })
    )(started.result)
    assert(started.error === undefined && result.isError !== true, "Desktop startup turn failed")
    yield* waitUntil(
      "the startup turn in the target task",
      Effect.tryPromise(() => Bun.file(target.path).text()).pipe(
        Effect.map((body) => (body.includes(startupMessage) ? true : null))
      ),
      30_000
    )
    yield* waitUntil(
      "the target task's App Tools to be ready",
      Effect.tryPromise(() => Bun.file(join(out, `${phase}-chatgpt.log`)).text()).pipe(
        Effect.map((body) =>
          body
            .split("\n")
            .some(
              (line) =>
                line.includes("mcp_server_startup_status_updated") &&
                line.includes("server=codex_app status=ready") &&
                line.includes(`threadId=${target.id}`)
            )
            ? true
            : null
        )
      ),
      30_000
    )
    evidence["desktopMcpReady"] = true
    evidence["helperTrigger"] = "Desktop turn in the target task"
  }

  if (process.platform === "darwin") {
    const phase = baseline ? "baseline" : "installed"
    const capture = `${phase}-open-task`
    const startupMessage = `nudge-helper-startup-${phase}`
    yield* Effect.tryPromise(() => Bun.write(join(out, "capture-request"), capture))
    yield* waitUntil(
      "a GUI turn in the resumed task",
      Effect.tryPromise(() => Bun.file(join(out, `${capture}.png`)).exists()).pipe(
        Effect.map((exists) => (exists ? true : null))
      ),
      60_000
    )
    yield* waitUntil(
      "the GUI startup message in the same task",
      Effect.tryPromise(() => Bun.file(target.path).text()).pipe(
        Effect.map((text) => (text.includes(startupMessage) ? true : null))
      ),
      30_000
    )
    yield* waitUntil(
      "Desktop to initialize and list app-tools",
      Effect.tryPromise(() => Bun.file(join(out, `${phase}-desktop.log`)).text()).pipe(
        Effect.map((text) =>
          text
            .split("\n")
            .some(
              (line) =>
                line.includes("mcp_server_startup_status_updated") &&
                line.includes("server=codex_app status=ready") &&
                line.includes(`threadId=${target.id}`)
            )
            ? true
            : null
        )
      ),
      30_000
    )
    evidence["desktopMcpReady"] = true
    evidence["helperTrigger"] = "GUI turn in the reopened task"
  }

  if (baseline) {
    const config = yield* Effect.tryPromise(() => Bun.file(join(codexHome, "config.toml")).text())
    assert(
      !config.includes("codex-desktop-helper") && !config.includes("NODE_OPTIONS"),
      "baseline has a helper configuration"
    )
    if (process.platform === "darwin") {
      const pid = yield* waitUntil(
        "baseline native App Tools server in its bundled directory",
        Effect.gen(function* () {
          const processes = Bun.spawnSync([
            "/bin/ps",
            "-axo",
            "pid=,ppid=,command="
          ]).stdout.toString()
          yield* Effect.tryPromise(() => Bun.write(join(out, "baseline-processes.txt"), processes))
          const native = processes
            .split("\n")
            .find((line) => line.trim().endsWith(`${resources}/cua_node/bin/node ./server.mjs`))
          if (native === undefined) return null
          const candidate = native.trim().split(/\s+/)[0]!
          const result = Bun.spawnSync([
            "/usr/sbin/lsof",
            "-a",
            "-p",
            candidate,
            "-d",
            "cwd",
            "-Fn"
          ])
          const cwd = result.stdout.toString()
          yield* Effect.tryPromise(() =>
            Bun.write(
              join(out, "baseline-native-cwd.txt"),
              `pid=${candidate} exit=${result.exitCode}\n${cwd}${result.stderr.toString()}`
            )
          )
          return result.exitCode === 0 && cwd.split("\n").includes(`n${appToolsDirectory}`)
            ? candidate
            : null
        }),
        10_000
      )
      const nativeEnvironment = Bun.spawnSync([
        "/bin/ps",
        "eww",
        "-p",
        pid,
        "-o",
        "command="
      ]).stdout.toString()
      assert(!nativeEnvironment.includes("NODE_OPTIONS="), "baseline server inherited NODE_OPTIONS")
      yield* Effect.tryPromise(() =>
        Bun.write(join(out, "baseline-native-environment.txt"), nativeEnvironment)
      )
      evidence["nativeServerPid"] = pid
      evidence["nativeServerWithoutNodeOptions"] = true
    }
    assert(!(yield* bridgeIsListening(bridgePath)), "baseline unexpectedly has a Nudge bridge")
    const rejected = Bun.spawnSync([nudge, "send", target.id, payload, "--json"], {
      env: nudgeEnvironment
    })
    const output = rejected.stdout.toString() + rejected.stderr.toString()
    assert(rejected.exitCode === 1, `uninstalled bridge did not fail: ${output}`)
    assert(output.includes("no Codex bridge socket"), `unexpected baseline failure: ${output}`)
    // Let a wrongly queued delivery surface before checking every transcript and model request.
    yield* Effect.sleep(2000)
    for (const file of yield* rolloutFiles()) {
      const body = yield* Effect.tryPromise(() => Bun.file(file).text())
      assert(!body.includes(payload), `baseline payload reached ${file}`)
    }
    assert(
      !JSON.stringify(yield* journal()).includes(payload),
      "baseline payload reached the model"
    )
    evidence["withoutHelperExitCode"] = rejected.exitCode
    evidence["withoutHelperError"] = output
    log(
      "PASS: real Desktop without the README helper rejects nudge send; no transcript or model delivery"
    )
    return
  }

  evidence["resumedAfterRestart"] = target.id
  log(`desktop:    resumed the same task after restart: ${target.id}`)

  yield* waitUntil(
    "Desktop to start Nudge's installed bridge",
    bridgeIsListening(bridgePath).pipe(Effect.map((listening) => (listening ? true : null))),
    30_000
  )
  const readme = yield* Effect.tryPromise(() =>
    Bun.file(join(import.meta.dir, "../../../README.md")).text()
  )
  const recipe = readme.split("```toml\n")[1]?.split("```")[0]
  assert(recipe !== undefined, "README has no Codex config")
  const expectedConfig = recipe
    .replaceAll("/path/to/nudge", join(import.meta.dir, "../../.."))
    .replaceAll("/Applications/ChatGPT.app/Contents/Resources", resources)
  const configSchema = Schema.Struct({
    mcp_servers: Schema.Struct({ codex_app: Schema.Record(Schema.String, Schema.Unknown) })
  })
  const decodeConfig = (text: string) =>
    Schema.decodeUnknownSync(configSchema)(Bun.TOML.parse(text)).mcp_servers.codex_app
  const activeConfig = yield* Effect.tryPromise(() =>
    Bun.file(join(codexHome, "config.toml")).text()
  )
  assert(
    isDeepStrictEqual(decodeConfig(activeConfig), decodeConfig(expectedConfig)),
    "Desktop's installed codex_app config differs from the README recipe"
  )
  evidence["readmeConfigMatches"] = true
  yield* assertDesktopBridge()
  log(`bridge:     ${bridgePath} (started automatically)`)

  const before = (yield* journal()).length
  const send = yield* spawnScoped(() =>
    Bun.spawn([nudge, "send", target.id, payload, "--json"], {
      env: nudgeEnvironment,
      stdout: "pipe",
      stderr: "pipe"
    })
  )

  const [sendCode, sendOut, sendError] = yield* Effect.all(
    [
      Effect.promise(() => send.exited),
      Stream.fromReadableStream({ evaluate: () => send.stdout, onError: (cause) => cause }).pipe(
        Stream.decodeText(),
        Stream.mkString
      ),
      Stream.fromReadableStream({ evaluate: () => send.stderr, onError: (cause) => cause }).pipe(
        Stream.decodeText(),
        Stream.mkString
      )
    ],
    { concurrency: "unbounded" }
  )
  assert(
    sendCode === 0,
    `nudge send failed: ${sendError || sendOut}\nshim stderr:\n${appToolsErrors}`
  )
  const receipt = Schema.decodeUnknownSync(SendSchema)(JSON.parse(sendOut))
  assert(receipt.status === "delivered", `unexpected receipt: ${sendOut}`)
  log(`nudge send: status=${receipt.status} delivery=${receipt.delivery}`)
  evidence["receipt"] = `${receipt.status}/${receipt.delivery}`

  const transcript = yield* waitUntil(
    "the payload and the mock's answer in the destination rollout",
    Effect.gen(function* () {
      const body = yield* Effect.tryPromise(() => Bun.file(target.path).text()).pipe(
        Effect.catch(() => Effect.succeed(""))
      )
      const rows = body.trim().split("\n")
      return rows.some(isPayloadDelivery) && rows.some(isMarkerAnswer) ? body : null
    }),
    180_000
  )
  const lines = transcript.trim().split("\n")
  const deliveries = lines.filter(isPayloadDelivery)
  const answers = lines.filter(isMarkerAnswer)
  assert(
    deliveries.length === 1,
    `expected exactly one payload turn input, saw ${deliveries.length}`
  )
  assert(answers.length === 1, "expected exactly one scripted assistant answer")
  assert(
    rolloutLine(deliveries[0]!)?.payload?.output?.includes(
      `<source_thread_id>${source.id}</source_thread_id>`
    ) === true,
    "the delivered item does not name the source thread"
  )
  assert(lines.indexOf(deliveries[0]!) < lines.indexOf(answers[0]!), "answer preceded delivery")
  log(`transcript: ${target.path}`)
  log(`transcript: 1 turn input carries the payload, ${answers.length} assistant item(s) answer it`)
  evidence["deliveryLine"] = deliveries[0]?.slice(0, 800) ?? ""
  evidence["answerLine"] = answers[0]?.slice(0, 800) ?? ""

  const everywhere = yield* Effect.forEach(
    yield* rolloutFiles(),
    (file) =>
      Effect.gen(function* () {
        const body = yield* Effect.tryPromise(() => Bun.file(file).text()).pipe(
          Effect.catch(() => Effect.succeed(""))
        )
        return body.split("\n").filter(isPayloadDelivery).length
      }),
    { concurrency: "unbounded" }
  )
  const total = everywhere.reduce((sum, count) => sum + count, 0)
  assert(total === 1, `the payload entered a thread ${total} times across CODEX_HOME`)
  log(`transcript: exactly 1 payload turn input in all of CODEX_HOME`)

  const entries = yield* journal()
  const carrying = entries.filter(
    (entry) =>
      entry.response?.fixture?.match?.toolResultContains === payload ||
      entry.response?.fixture?.match?.userMessage === payload
  )
  assert(
    carrying.length === 1,
    `exactly one model request should carry the payload, saw ${carrying.length}`
  )
  const offHost = entries.filter((entry) => !(entry.headers["host"] ?? "").startsWith("127.0.0.1"))
  assert(offHost.length === 0, `mock saw a non-loopback host: ${JSON.stringify(offHost)}`)
  log(`aimock:     ${entries.length - before} request(s) during the send, 1 carrying the payload`)
  log(`aimock:     all ${entries.length} request(s) arrived on 127.0.0.1:${aimockPort}`)
  evidence["aimockRequests"] = entries.length
  evidence["aimockRequestsDuringSend"] = entries.length - before

  log("")
  log("PASS: nudge send -> Nudge bridge -> Nudge shim -> Desktop's server.mjs ->")
  log("      Desktop's tools pipe -> Electron main -> Desktop's app-server -> real turn")
})

const exitCode = await Effect.runPromise(
  Effect.gen(function* () {
    const result = yield* Effect.scoped(
      process.argv[2]?.startsWith("--bootstrap") ? bootstrapSource : main
    ).pipe(Effect.provide(BunHttpClient.layer), Effect.exit)
    const status = Exit.isSuccess(result) ? 0 : 1
    evidence["outcome"] = status === 0 ? "PASS" : "FAIL"
    if (Exit.isFailure(result)) {
      const failure = Cause.pretty(result.cause)
      evidence["error"] = failure
      process.stderr.write(`\nFAIL: ${failure}\n`)
    }
    yield* Effect.tryPromise(() =>
      Bun.write(
        join(
          out,
          process.argv[2]?.startsWith("--bootstrap")
            ? "bootstrap-evidence.json"
            : process.argv[2] === "--baseline"
              ? "baseline-evidence.json"
              : "evidence.json"
        ),
        `${JSON.stringify(evidence, null, 2)}\n`
      )
    ).pipe(Effect.catch(() => Effect.void))
    return status
  })
)
process.exit(exitCode)
