import { expect } from "bun:test"
import { chmod, lstat, mkdir, readlink } from "node:fs/promises"
import { type Socket, createConnection, createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect, Deferred } from "effect"

import {
  openDatabase,
  serveScoped,
  spawnScoped,
  temporaryDirectory,
  testEffect,
  runCli,
  listen,
  mainPath,
  environment,
  type BridgeRequestFixture
} from "./support.ts"

testEffect(
  "the compact CLI sends through Claude's authenticated native inbox",
  Effect.gen(function* () {
    const directory = yield* temporaryDirectory(join(tmpdir(), "nudge-native-"))
    const sessionsDirectory = join(directory, "sessions")
    const projectsDirectory = join(directory, "projects")
    const socketDirectory = join(directory, "socket")
    const socketPath = join(socketDirectory, "inbox.sock")
    const index = join(directory, "session-index.jsonl")
    const peerToken = "1".repeat(32)
    const { procStart, pidDomain } = yield* processIdentity(process.pid)
    yield* Effect.tryPromise(() => mkdir(sessionsDirectory, { mode: 0o700 }))
    yield* Effect.tryPromise(() =>
      mkdir(join(projectsDirectory, "test-project"), { recursive: true })
    )
    yield* Effect.tryPromise(() => mkdir(socketDirectory, { mode: 0o700 }))
    yield* Effect.tryPromise(() => Bun.write(index, ""))
    yield* Effect.tryPromise(() =>
      Bun.write(
        join(sessionsDirectory, `${process.pid}.json`),
        JSON.stringify({
          pid: process.pid,
          sessionId: "11111111-1111-4111-8111-111111111111",
          startedAt: Date.now(),
          procStart,
          peerProtocol: 1,
          messagingSocketPath: socketPath,
          name: "Claude Test"
        })
      )
    )
    const keyPath = join(sessionsDirectory, `${process.pid}.${"a".repeat(64)}.key`)
    yield* Effect.tryPromise(() =>
      Bun.write(keyPath, JSON.stringify({ peerToken, procStart, pidDomain }))
    )
    yield* Effect.tryPromise(() => chmod(keyPath, 0o600))
    yield* Effect.tryPromise(() =>
      Bun.write(
        join(projectsDirectory, "test-project", "11111111-1111-4111-8111-111111111111.jsonl"),
        [
          {
            type: "custom-title",
            customTitle: "Implementation",
            sessionId: "11111111-1111-4111-8111-111111111111"
          },
          {
            type: "assistant",
            timestamp: "2026-09-09T21:00:00Z",
            effort: "medium",
            message: { model: "claude-test" }
          },
          {
            type: "assistant",
            timestamp: "2026-09-09T21:01:00Z",
            message: { model: "<synthetic>" }
          },
          { type: "user", timestamp: "2026-09-09T21:02:00Z", message: { content: "hello" } }
        ]
          .map((row) => JSON.stringify(row))
          .join("\n") + "\n"
      )
    )
    let received = yield* Deferred.make<string>()
    let receiptStatuses: {
      status: string
      status_detail?: string
      orig_msg_id?: string
    }[] = []
    const server = createServer((socket) => {
      let body = ""
      socket.setEncoding("utf8")
      socket.on("data", (chunk) => {
        body += chunk
      })
      socket.on("end", () => {
        Deferred.doneUnsafe(received, Effect.succeed(body))
        if (receiptStatuses.length === 0) return
        const frame = JSON.parse(body.trim().split("\n")[1]!)
        const replyPath = String(frame.from).replace(/^uds:/, "")
        const reply = createConnection(replyPath)
        reply.once("connect", () => {
          reply.end(
            receiptStatuses
              .map(
                (receipt) =>
                  JSON.stringify({
                    type: "control",
                    action: "peer_message_status",
                    reason: "fixture policy",
                    orig_msg_id: frame.msg_id,
                    ...receipt
                  }) + "\n"
              )
              .join("")
          )
        })
      })
    })
    yield* listen(server, socketPath)
    yield* Effect.tryPromise(() => chmod(socketPath, 0o600))
    const result = yield* runCli(["send", "Implementation", "hello from Codex", "--json"], {
      NUDGE_CLAUDE_SESSIONS_DIR: sessionsDirectory,
      NUDGE_CLAUDE_PROJECTS_DIR: projectsDirectory,
      NUDGE_CODEX_SESSION_INDEX: index
    })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    const output = JSON.parse(result.stdout)
    expect(output).toMatchObject({
      action: "send",
      provider: "claude",
      status: "sent",
      target: {
        id: "11111111-1111-4111-8111-111111111111",
        name: "Implementation"
      }
    })
    expect(output.messageId).toMatch(/^[0-9a-f-]{36}$/)
    const lines = (yield* Deferred.await(received))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(lines[0]).toEqual({ type: "auth", token: peerToken })
    expect(lines[1]).toMatchObject({
      msgV: 1,
      msg_id: output.messageId,
      type: "user",
      priority: "next"
    })
    expect(lines[1].message.role).toBe("user")
    expect(lines[1].message.content).toStartWith(
      '<cross-session-message from-session="11111111-1111-4111-8111-111111111111" from-name="Implementation">\n'
    )
    expect(lines[1].message.content).toBe(
      '<cross-session-message from-session="11111111-1111-4111-8111-111111111111" from-name="Implementation">\nMessage from Claude session "Implementation" (11111111-1111-4111-8111-111111111111) via nudge CLI:\n\nhello from Codex\n</cross-session-message>'
    )
    expect(lines[1].from).toMatch(/^uds:.+\/[0-9a-f]{8}\.sock$/)
    received = yield* Deferred.make<string>()
    const interrupted = yield* spawnScoped(() =>
      Bun.spawn([process.execPath, mainPath, "send", "Implementation", "interrupt me"], {
        env: {
          ...environment,
          NUDGE_CLAUDE_SESSIONS_DIR: sessionsDirectory,
          NUDGE_CLAUDE_PROJECTS_DIR: projectsDirectory,
          NUDGE_CODEX_SESSION_INDEX: index
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 2000
      })
    )
    const body = yield* Effect.raceAll([
      Deferred.await(received),
      Effect.promise(() => interrupted.exited).pipe(
        Effect.andThen(Effect.fail(new Error("CLI exited before sending")))
      )
    ])
    const frame = JSON.parse(body.trim().split("\n")[1]!)
    const receiptPath = String(frame.from).replace(/^uds:/, "")
    expect(
      (yield* Effect.tryPromise({
        try: () => lstat(receiptPath),
        catch: (cause) => cause
      })).isSocket()
    ).toBe(true)
    interrupted.kill("SIGINT")
    expect(yield* Effect.tryPromise(() => interrupted.exited)).toBe(130)
    yield* Effect.map(
      Effect.flip(Effect.tryPromise({ try: () => lstat(receiptPath), catch: (cause) => cause })),
      (error) => expect(error).toMatchObject({ code: "ENOENT" })
    )
    expect(yield* Effect.tryPromise(() => Bun.readableStreamToText(interrupted.stdout))).toBe("")
    expect(yield* Effect.tryPromise(() => Bun.readableStreamToText(interrupted.stderr))).toBe("")
    for (const fixture of [
      { wire: [{ status: "held" }], status: "held", exit: 3 },
      { wire: [{ status: "refused" }], status: "refused", exit: 1 },
      { wire: [{ status: "expired", status_detail: "refused" }], status: "refused", exit: 1 },
      { wire: [{ status: "dropped" }], status: "dropped", exit: 1 },
      { wire: [{ status: "denied" }], status: "denied", exit: 1 },
      { wire: [{ status: "expired" }], status: "expired", exit: 1 },
      { wire: [{ status: "held" }, { status: "delivered" }], status: "delivered", exit: 0 },
      {
        wire: [{ status: "refused", orig_msg_id: "another-message" }, { status: "delivered" }],
        status: "delivered",
        exit: 0
      }
    ]) {
      received = yield* Deferred.make<string>()
      receiptStatuses = fixture.wire
      const receiptResult = yield* runCli(["send", "Implementation", "receipt test", "--json"], {
        NUDGE_CLAUDE_SESSIONS_DIR: sessionsDirectory,
        NUDGE_CLAUDE_PROJECTS_DIR: projectsDirectory,
        NUDGE_CODEX_SESSION_INDEX: index
      })
      expect(receiptResult.exitCode).toBe(fixture.exit)
      expect(receiptResult.stderr).toBe("")
      expect(JSON.parse(receiptResult.stdout)).toMatchObject({
        status: fixture.status,
        reason: "fixture policy"
      })
      expect(yield* Deferred.await(received)).toContain("receipt test")
    }
    receiptStatuses = [{ status: "held" }]
    const held = yield* runCli(["send", "Implementation", "held message"], {
      NUDGE_CLAUDE_SESSIONS_DIR: sessionsDirectory,
      NUDGE_CLAUDE_PROJECTS_DIR: projectsDirectory,
      NUDGE_CODEX_SESSION_INDEX: index
    })
    expect(held.exitCode).toBe(3)
    expect(held.stdout).toBe("")
    expect(held.stderr).toBe(
      'warning: message to Claude session "Implementation" (11111111-1111-4111-8111-111111111111) is held: fixture policy\nhint: Do not resend while delivery is pending\n'
    )
    const listed = yield* runCli(["list", "--json"], {
      NUDGE_CLAUDE_SESSIONS_DIR: sessionsDirectory,
      NUDGE_CLAUDE_PROJECTS_DIR: projectsDirectory,
      NUDGE_CODEX_SESSION_INDEX: index
    })
    const listedClaude = JSON.parse(listed.stdout).targets[0]
    expect(listedClaude.name).toBe("Implementation")
    expect(listedClaude).toMatchObject({
      lastModel: "claude-test",
      lastEffort: "medium",
      lastActiveAt: "2026-09-09T21:02:00.000Z",
      archived: false
    })
    expect(listedClaude.socketPath).toBeUndefined()
    expect(listedClaude.keyPath).toBeUndefined()
    expect(listedClaude.bridgeSessionId).toBeUndefined()
    // Both files can agree after a crashed session's PID has been reused.
    const registryPath = join(sessionsDirectory, `${process.pid}.json`)
    const registry = yield* Effect.tryPromise(() => Bun.file(registryPath).json())
    for (const identity of [
      { procStart: "obsolete process generation", pidDomain },
      { procStart, pidDomain: "another PID namespace" }
    ]) {
      yield* Effect.tryPromise(() =>
        Bun.write(registryPath, JSON.stringify({ ...registry, procStart: identity.procStart }))
      )
      yield* Effect.tryPromise(() => Bun.write(keyPath, JSON.stringify({ peerToken, ...identity })))
      const stale = yield* runCli(["list", "--json"], {
        NUDGE_CLAUDE_SESSIONS_DIR: sessionsDirectory,
        NUDGE_CLAUDE_PROJECTS_DIR: projectsDirectory,
        NUDGE_CODEX_SESSION_INDEX: index
      })
      expect(stale.exitCode).toBe(0)
      expect(JSON.parse(stale.stdout).targets).toEqual([])
    }
  })
)

testEffect(
  "the CLI does not manage Claude session lifecycle",
  Effect.gen(function* () {
    const result = yield* runCli(["start", "claude", "No Launcher"], {})
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toBe('error: unknown command "start"\nhint: Run "nudge --help"\n')
  })
)

testEffect(
  "Claude app titles are fetched only when a command needs them",
  Effect.gen(function* () {
    const directory = yield* temporaryDirectory(join(tmpdir(), "nudge-titles-"))
    const sessionsDirectory = join(directory, "sessions")
    const socketDirectory = join(directory, "socket")
    const inboxPath = join(socketDirectory, "inbox.sock")
    const bridgePath = join(directory, "bridge.sock")
    const index = join(directory, "index.jsonl")
    const state = join(directory, "state_5.sqlite")
    const remoteSession = "22222222-2222-4222-8222-222222222222"
    const secondRemoteSession = "33333333-3333-4333-8333-333333333333"
    // A live process that is not an ancestor keeps the fixture sessions
    // discoverable without making the CLI look like their sender.
    const holder = yield* spawnScoped(() =>
      Bun.spawn(["sleep", "120"], { stdin: "ignore", stdout: "ignore" })
    )
    yield* Effect.tryPromise(() => mkdir(sessionsDirectory, { recursive: true, mode: 0o700 }))
    yield* Effect.tryPromise(() => mkdir(socketDirectory, { recursive: true, mode: 0o700 }))
    const titleRequests: string[] = []
    let titlesFail = false
    let titlesStall = false
    const stalled = yield* Deferred.make<void>()
    const titles = yield* serveScoped(() =>
      Bun.serve({
        port: 0,
        fetch(request) {
          const id = new URL(request.url).pathname.split("/").at(-1) ?? ""
          titleRequests.push(id)
          if (titlesStall) {
            Deferred.doneUnsafe(stalled, Effect.void)
            return Effect.runPromise(Effect.never, { signal: request.signal })
          }
          if (titlesFail) return new Response("private failure body", { status: 500 })
          const title = id === "cse_r1" ? "Same" : "Second Remote"
          return Response.json({ session: { id, title } })
        }
      })
    )
    let inboxBody = ""
    const inbox = createServer((socket) => {
      socket.setEncoding("utf8")
      socket.on("data", (chunk) => {
        inboxBody += chunk
      })
    })
    yield* listen(inbox, inboxPath)
    yield* Effect.tryPromise(() => chmod(inboxPath, 0o600))
    let bridgeRequests = 0
    const bridge = createServer((socket) => {
      socket.setEncoding("utf8")
      socket.once("data", (body) => {
        bridgeRequests += 1
        // SAFETY: this fixture owns the only writer and echoes back its own fields.
        const request = JSON.parse(String(body).trim()) as BridgeRequestFixture
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
    yield* listen(bridge, bridgePath)
    yield* Effect.tryPromise(() => chmod(bridgePath, 0o600))
    const env = {
      NUDGE_CLAUDE_SESSIONS_DIR: sessionsDirectory,
      NUDGE_CLAUDE_PROJECTS_DIR: join(directory, "projects"),
      NUDGE_CODEX_SESSION_INDEX: index,
      NUDGE_CODEX_STATE_DB: state,
      NUDGE_CODEX_BRIDGE_SOCKET: bridgePath,
      NUDGE_CLAUDE_TITLES_URL: `http://127.0.0.1:${titles.port}/v1/code/sessions`,
      NUDGE_CLAUDE_ACCESS_TOKEN: "fixture-token",
      CODEX_THREAD_ID: "",
      CODEX_SESSION_ID: ""
    }
    const secondHolder = yield* spawnScoped(() =>
      Bun.spawn(["sleep", "120"], { stdin: "ignore", stdout: "ignore" })
    )
    for (const [sessionId, bridgeSessionId, name, pid] of [
      [remoteSession, "session_r1", "Registry R1", holder.pid],
      [secondRemoteSession, "session_r2", "Registry R2", secondHolder.pid]
    ] as const) {
      const { procStart, pidDomain } = yield* processIdentity(pid)
      yield* Effect.tryPromise(() =>
        Bun.write(
          join(sessionsDirectory, `${sessionId}.json`),
          JSON.stringify({
            pid,
            sessionId,
            startedAt: Date.now(),
            procStart,
            peerProtocol: 1,
            messagingSocketPath: inboxPath,
            name,
            bridgeSessionId
          })
        )
      )
      const keyPath = join(sessionsDirectory, `${pid}.${bridgeSessionId.at(-1)!.repeat(64)}.key`)
      yield* Effect.tryPromise(() =>
        Bun.write(keyPath, JSON.stringify({ peerToken: "1".repeat(32), procStart, pidDomain }))
      )
      yield* Effect.tryPromise(() => chmod(keyPath, 0o600))
    }
    const database = yield* openDatabase(state)
    database.run(
      "CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER, recency_at INTEGER, updated_at INTEGER, model TEXT, reasoning_effort TEXT, cwd TEXT)"
    )
    for (const [id, archived] of [
      ["codex-live", 0],
      ["codex-same", 0],
      ["codex-archived", 1]
    ] as const) {
      database.run("INSERT INTO threads VALUES (?, ?, 10, 10, NULL, NULL, '/project')", [
        id,
        archived
      ])
    }
    database.close()
    yield* Effect.tryPromise(() =>
      Bun.write(
        index,
        [
          { id: "codex-live", thread_name: "Code review" },
          { id: "codex-same", thread_name: "Same" },
          { id: "codex-archived", thread_name: "Archived review" }
        ]
          .map((row) => JSON.stringify(row))
          .join("\n")
      )
    )
    yield* Effect.tryPromise(() => Bun.write(env.NUDGE_CLAUDE_PROJECTS_DIR, "not a directory"))
    titlesFail = true
    const archivedList = yield* runCli(["list", "--archived", "--json"], env)
    expect(archivedList.exitCode).toBe(0)
    expect(archivedList.stderr).toBe("")
    expect(JSON.parse(archivedList.stdout)).toMatchObject({
      action: "list",
      targets: [{ provider: "codex", id: "codex-archived", name: "Archived review" }],
      total: 1,
      offset: 0,
      nextOffset: null
    })
    expect(titleRequests).toEqual([])
    const codexById = yield* runCli(["send", "codex-live", "no titles needed", "--json"], env)
    expect(codexById.exitCode).toBe(0)
    expect(codexById.stderr).toBe("")
    expect(JSON.parse(codexById.stdout)).toMatchObject({
      provider: "codex",
      status: "delivered",
      target: { id: "codex-live", name: "Code review" }
    })
    expect(titleRequests).toEqual([])
    expect(bridgeRequests).toBe(1)
    const unreadable = yield* runCli(["list", "--json"], env)
    expect(unreadable.exitCode).toBe(1)
    expect(unreadable.stderr).toContain("cannot inspect Claude transcripts")
    yield* Effect.tryPromise(() => Bun.file(env.NUDGE_CLAUDE_PROJECTS_DIR).delete())
    const byName = yield* runCli(["send", "Code review", "needs a decision"], env)
    expect(byName.exitCode).toBe(1)
    expect(byName.stderr).toStartWith("error: cannot load Claude session titles: ")
    expect(byName.stderr).not.toContain("private failure body")
    expect(titleRequests.length).toBeGreaterThan(0)
    expect(inboxBody).toBe("")
    expect(bridgeRequests).toBe(1)
    titlesFail = false
    titleRequests.length = 0
    const listed = JSON.parse((yield* runCli(["list", "--json"], env)).stdout)
    expect(
      listed.targets.map((row: { id: string; name: string }) => [row.id, row.name])
    ).toContainEqual([remoteSession, "Same"])
    expect(
      listed.targets.map((row: { id: string; name: string }) => [row.id, row.name])
    ).toContainEqual([secondRemoteSession, "Second Remote"])
    expect(listed.targets.map((row: { name: string }) => row.name)).not.toContain("Registry R1")
    expect(titleRequests.toSorted()).toEqual(["cse_r1", "cse_r2"])
    const ambiguous = yield* runCli(["send", "Same", "which one?"], env)
    expect(ambiguous.exitCode).toBe(1)
    expect(ambiguous.stderr).toBe(
      `error: multiple targets named "Same"\n\nNAME  PROVIDER  ID\nSame  Claude    ${remoteSession}\nSame  Codex     codex-same\n\nhint: Use an ID instead of the name\n`
    )
    expect(inboxBody).toBe("")
    titleRequests.length = 0
    const claudeById = yield* runCli(["send", remoteSession, "hello Claude", "--json"], env)
    expect(claudeById.exitCode).toBe(0)
    expect(claudeById.stderr).toBe("")
    expect(JSON.parse(claudeById.stdout)).toMatchObject({
      provider: "claude",
      status: "sent",
      target: { id: remoteSession, name: "Same" }
    })
    expect(titleRequests).toEqual(["cse_r1"])
    expect(inboxBody).toContain("hello Claude")
    const withoutCodex = yield* runCli(["send", remoteSession, "Claude only", "--json"], {
      ...env,
      CODEX_THREAD_ID: " \t ",
      CODEX_SESSION_ID: "",
      NUDGE_CODEX_SESSION_INDEX: join(directory, "missing-index.jsonl")
    })
    expect(withoutCodex.exitCode).toBe(0)
    expect(withoutCodex.stderr).toBe("")
    expect(inboxBody).toContain("Claude only")
    titlesStall = true
    inboxBody = ""
    const interrupted = yield* spawnScoped(() =>
      Bun.spawn([process.execPath, mainPath, "send", remoteSession, "cancel me"], {
        env: { ...environment, ...env },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 3000
      })
    )
    yield* Effect.raceAll([
      Deferred.await(stalled),
      Effect.promise(() => interrupted.exited).pipe(
        Effect.andThen(Effect.fail(new Error("CLI exited before title lookup")))
      )
    ])
    interrupted.kill("SIGINT")
    expect(yield* Effect.tryPromise(() => interrupted.exited)).toBe(130)
    expect(yield* Effect.tryPromise(() => Bun.readableStreamToText(interrupted.stdout))).toBe("")
    expect(yield* Effect.tryPromise(() => Bun.readableStreamToText(interrupted.stderr))).toBe("")
    expect(inboxBody).toBe("")
  })
)

testEffect(
  "a Remote Control sender is identified by its app title, not its registry name",
  Effect.gen(function* () {
    const directory = yield* temporaryDirectory(join(tmpdir(), "nudge-sender-"))
    const sessionsDirectory = join(directory, "sessions")
    const socketDirectory = join(directory, "socket")
    const inboxPath = join(socketDirectory, "inbox.sock")
    const bridgePath = join(directory, "bridge.sock")
    const index = join(directory, "index.jsonl")
    const senderSession = "66666666-6666-4666-8666-666666666666"
    const { procStart, pidDomain } = yield* processIdentity(process.pid)
    yield* Effect.tryPromise(() => mkdir(sessionsDirectory, { recursive: true, mode: 0o700 }))
    yield* Effect.tryPromise(() => mkdir(socketDirectory, { recursive: true, mode: 0o700 }))
    const titleRequests: string[] = []
    const titles = yield* serveScoped(() =>
      Bun.serve({
        port: 0,
        fetch(request) {
          const id = new URL(request.url).pathname.split("/").at(-1) ?? ""
          titleRequests.push(id)
          return Response.json({ session: { id, title: "Live App Title" } })
        }
      })
    )
    const inbox = createServer(() => {})
    yield* listen(inbox, inboxPath)
    yield* Effect.tryPromise(() => chmod(inboxPath, 0o600))
    let bridgeRequest: BridgeRequestFixture | undefined
    const bridge = createServer((socket) => {
      socket.setEncoding("utf8")
      socket.once("data", (body) => {
        // SAFETY: this fixture owns the only writer and asserts every field below.
        bridgeRequest = JSON.parse(String(body).trim()) as BridgeRequestFixture
        socket.end(
          `${JSON.stringify({
            version: 1,
            id: bridgeRequest.id,
            status: "delivered",
            targetThreadId: bridgeRequest.targetThreadId
          })}\n`
        )
      })
    })
    yield* listen(bridge, bridgePath)
    yield* Effect.tryPromise(() => chmod(bridgePath, 0o600))
    yield* Effect.tryPromise(() =>
      Bun.write(
        join(sessionsDirectory, `${senderSession}.json`),
        JSON.stringify({
          pid: process.pid,
          sessionId: senderSession,
          startedAt: Date.now(),
          procStart,
          peerProtocol: 1,
          messagingSocketPath: inboxPath,
          name: "Registry Sender",
          bridgeSessionId: "session_sender"
        })
      )
    )
    const keyPath = join(sessionsDirectory, `${process.pid}.${"c".repeat(64)}.key`)
    yield* Effect.tryPromise(() =>
      Bun.write(keyPath, JSON.stringify({ peerToken: "1".repeat(32), procStart, pidDomain }))
    )
    yield* Effect.tryPromise(() => chmod(keyPath, 0o600))
    yield* Effect.tryPromise(() =>
      Bun.write(index, `${JSON.stringify({ id: "codex-live", thread_name: "Code review" })}\n`)
    )
    for (const destination of ["codex-live", "Code review"]) {
      titleRequests.length = 0
      const sent = yield* runCli(["send", destination, "from a remote session", "--json"], {
        NUDGE_CLAUDE_SESSIONS_DIR: sessionsDirectory,
        NUDGE_CLAUDE_PROJECTS_DIR: join(directory, "projects"),
        NUDGE_CODEX_SESSION_INDEX: index,
        NUDGE_CODEX_BRIDGE_SOCKET: bridgePath,
        NUDGE_CLAUDE_TITLES_URL: `http://127.0.0.1:${titles.port}/v1/code/sessions`,
        NUDGE_CLAUDE_ACCESS_TOKEN: "fixture-token",
        CODEX_THREAD_ID: "",
        CODEX_SESSION_ID: ""
      })
      expect(sent.exitCode).toBe(0)
      expect(titleRequests).toEqual(["cse_sender"])
      expect(bridgeRequest?.prompt).toBe(
        `Message from Claude session "Live App Title" (${senderSession}) via nudge CLI:\n\nfrom a remote session`
      )
      expect(bridgeRequest?.sourceThreadId).toBeUndefined()
    }
  })
)

testEffect(
  "Claude discovery follows CLAUDE_CONFIG_DIR while the NUDGE overrides still win",
  Effect.gen(function* () {
    const directory = yield* temporaryDirectory(join(tmpdir(), "nudge-profile-"))
    const socketDirectory = join(directory, "socket")
    const socketPath = join(socketDirectory, "inbox.sock")
    const index = join(directory, "index.jsonl")
    const profile = join(directory, "profile")
    const override = join(directory, "override")
    const profileSession = "44444444-4444-4444-8444-444444444444"
    const overrideSession = "55555555-5555-4555-8555-555555555555"
    const { procStart, pidDomain } = yield* processIdentity(process.pid)
    yield* Effect.tryPromise(() => mkdir(socketDirectory, { recursive: true, mode: 0o700 }))
    yield* Effect.tryPromise(() => Bun.write(index, ""))
    const inbox = createServer(() => {})
    yield* listen(inbox, socketPath)
    yield* Effect.tryPromise(() => chmod(socketPath, 0o600))
    for (const [root, sessionId, name, title] of [
      [profile, profileSession, "Profile Registry", "Profile Title"],
      [override, overrideSession, "Override Registry", "Override Title"]
    ] as const) {
      yield* Effect.tryPromise(() =>
        mkdir(join(root, "sessions"), { recursive: true, mode: 0o700 })
      )
      yield* Effect.tryPromise(() => mkdir(join(root, "projects", "project"), { recursive: true }))
      yield* Effect.tryPromise(() =>
        Bun.write(
          join(root, "sessions", `${sessionId}.json`),
          JSON.stringify({
            pid: process.pid,
            sessionId,
            startedAt: Date.now(),
            procStart,
            peerProtocol: 1,
            messagingSocketPath: socketPath,
            name
          })
        )
      )
      const keyPath = join(root, "sessions", `${process.pid}.${"a".repeat(64)}.key`)
      yield* Effect.tryPromise(() =>
        Bun.write(keyPath, JSON.stringify({ peerToken: "1".repeat(32), procStart, pidDomain }))
      )
      yield* Effect.tryPromise(() => chmod(keyPath, 0o600))
      yield* Effect.tryPromise(() =>
        Bun.write(
          join(root, "projects", "project", `${sessionId}.jsonl`),
          `${JSON.stringify({ type: "custom-title", customTitle: title, sessionId })}\n`
        )
      )
    }
    const profiled = yield* runCli(["list", "--json"], {
      CLAUDE_CONFIG_DIR: profile,
      NUDGE_CLAUDE_SESSIONS_DIR: undefined,
      NUDGE_CLAUDE_PROJECTS_DIR: undefined,
      NUDGE_CODEX_SESSION_INDEX: index
    })
    expect(profiled.exitCode).toBe(0)
    expect(JSON.parse(profiled.stdout).targets).toMatchObject([
      { provider: "claude", id: profileSession, name: "Profile Title" }
    ])
    const sessionsOverride = yield* runCli(["list", "--json"], {
      CLAUDE_CONFIG_DIR: profile,
      NUDGE_CLAUDE_SESSIONS_DIR: join(override, "sessions"),
      NUDGE_CLAUDE_PROJECTS_DIR: undefined,
      NUDGE_CODEX_SESSION_INDEX: index
    })
    expect(JSON.parse(sessionsOverride.stdout).targets).toMatchObject([
      { provider: "claude", id: overrideSession, name: "Override Registry" }
    ])
    const bothOverrides = yield* runCli(["list", "--json"], {
      CLAUDE_CONFIG_DIR: profile,
      NUDGE_CLAUDE_SESSIONS_DIR: join(override, "sessions"),
      NUDGE_CLAUDE_PROJECTS_DIR: join(override, "projects"),
      NUDGE_CODEX_SESSION_INDEX: index
    })
    expect(JSON.parse(bothOverrides.stdout).targets).toMatchObject([
      { provider: "claude", id: overrideSession, name: "Override Title" }
    ])
  })
)

testEffect(
  "a session's custom title wins over the Claude app title",
  Effect.gen(function* () {
    const directory = yield* temporaryDirectory(join(tmpdir(), "nudge-custom-title-"))
    const sessionsDirectory = join(directory, "sessions")
    const projectsDirectory = join(directory, "projects")
    const socketDirectory = join(directory, "socket")
    const inboxPath = join(socketDirectory, "inbox.sock")
    const index = join(directory, "index.jsonl")
    const titledSession = "77777777-7777-4777-8777-777777777777"
    const senderSession = "88888888-8888-4888-8888-888888888888"
    const untitledSession = "99999999-9999-4999-8999-999999999999"
    yield* Effect.tryPromise(() => mkdir(sessionsDirectory, { recursive: true, mode: 0o700 }))
    yield* Effect.tryPromise(() => mkdir(join(projectsDirectory, "project"), { recursive: true }))
    yield* Effect.tryPromise(() => mkdir(socketDirectory, { recursive: true, mode: 0o700 }))
    yield* Effect.tryPromise(() => Bun.write(index, ""))
    const titleRequests: string[] = []
    const titles = yield* serveScoped(() =>
      Bun.serve({
        port: 0,
        fetch(request) {
          const id = new URL(request.url).pathname.split("/").at(-1) ?? ""
          titleRequests.push(id)
          return Response.json({ session: { id, title: "Automerge focus CI improvements" } })
        }
      })
    )
    let inboxBody = ""
    const inbox = createServer((socket) => {
      socket.setEncoding("utf8")
      socket.on("data", (chunk) => {
        inboxBody += chunk
      })
    })
    yield* listen(inbox, inboxPath)
    yield* Effect.tryPromise(() => chmod(inboxPath, 0o600))
    const holder = yield* spawnScoped(() =>
      Bun.spawn(["sleep", "120"], { stdin: "ignore", stdout: "ignore" })
    )
    const untitledHolder = yield* spawnScoped(() =>
      Bun.spawn(["sleep", "120"], { stdin: "ignore", stdout: "ignore" })
    )
    const register = (
      sessionId: string,
      bridgeSessionId: string,
      name: string,
      pid: number,
      key: string,
      title: string | null
    ) =>
      Effect.gen(function* () {
        const { procStart, pidDomain } = yield* processIdentity(pid)
        yield* Effect.tryPromise(() =>
          Bun.write(
            join(sessionsDirectory, `${sessionId}.json`),
            JSON.stringify({
              pid,
              sessionId,
              startedAt: Date.now(),
              procStart,
              peerProtocol: 1,
              messagingSocketPath: inboxPath,
              name,
              bridgeSessionId
            })
          )
        )
        const keyPath = join(sessionsDirectory, `${pid}.${key.repeat(64)}.key`)
        yield* Effect.tryPromise(() =>
          Bun.write(keyPath, JSON.stringify({ peerToken: "1".repeat(32), procStart, pidDomain }))
        )
        yield* Effect.tryPromise(() => chmod(keyPath, 0o600))
        if (title === null) return
        yield* Effect.tryPromise(() =>
          Bun.write(
            join(projectsDirectory, "project", `${sessionId}.jsonl`),
            [
              { type: "custom-title", customTitle: "An earlier title", sessionId },
              { type: "user", timestamp: "2026-09-09T21:02:00Z" },
              { type: "custom-title", customTitle: title, sessionId }
            ]
              .map((row) => JSON.stringify(row))
              .join("\n") + "\n"
          )
        )
      })
    yield* register(titledSession, "session_t1", "Registry T1", holder.pid, "a", "Council 19a")
    yield* register(
      senderSession,
      "session_s1",
      "Registry Sender",
      process.pid,
      "b",
      "Sender Custom"
    )
    const env = {
      NUDGE_CLAUDE_SESSIONS_DIR: sessionsDirectory,
      NUDGE_CLAUDE_PROJECTS_DIR: projectsDirectory,
      NUDGE_CODEX_SESSION_INDEX: index,
      NUDGE_CLAUDE_TITLES_URL: `http://127.0.0.1:${titles.port}/v1/code/sessions`,
      NUDGE_CLAUDE_ACCESS_TOKEN: "fixture-token",
      CODEX_THREAD_ID: "",
      CODEX_SESSION_ID: ""
    }
    const listed = yield* runCli(["list", "--json"], env)
    expect(listed.exitCode).toBe(0)
    expect(listed.stderr).toBe("")
    const listedNames = JSON.parse(listed.stdout).targets.map(
      (row: { id: string; name: string }) => [row.id, row.name]
    )
    expect(listedNames).toContainEqual([titledSession, "Council 19a"])
    expect(listedNames).toContainEqual([senderSession, "Sender Custom"])
    expect(titleRequests).toEqual([])
    const sent = yield* runCli(["send", "Council 19a", "hello from the app", "--json"], env)
    expect(sent.exitCode).toBe(0)
    expect(sent.stderr).toBe("")
    expect(JSON.parse(sent.stdout)).toMatchObject({
      provider: "claude",
      status: "sent",
      target: { id: titledSession, name: "Council 19a" }
    })
    expect(titleRequests).toEqual([])
    const frame = JSON.parse(inboxBody.trim().split("\n")[1]!)
    expect(frame.message.content).toBe(
      `<cross-session-message from-session="${senderSession}" from-name="Sender Custom">\nMessage from Claude session "Sender Custom" (${senderSession}) via nudge CLI:\n\nhello from the app\n</cross-session-message>`
    )
    yield* register(untitledSession, "session_u1", "Registry U1", untitledHolder.pid, "c", null)
    const relisted = yield* runCli(["list", "--json"], env)
    expect(relisted.exitCode).toBe(0)
    const relistedNames = JSON.parse(relisted.stdout).targets.map(
      (row: { id: string; name: string }) => [row.id, row.name]
    )
    expect(relistedNames).toContainEqual([untitledSession, "Automerge focus CI improvements"])
    expect(relistedNames).toContainEqual([titledSession, "Council 19a"])
    expect(titleRequests).toEqual(["cse_u1"])
  }),
  15000
)

testEffect(
  "Claude receipts are parsed before the inbox closes the connection",
  Effect.gen(function* () {
    const directory = yield* temporaryDirectory(join(tmpdir(), "nudge-receipt-"))
    const sessionsDirectory = join(directory, "sessions")
    const socketDirectory = join(directory, "socket")
    const socketPath = join(socketDirectory, "inbox.sock")
    const index = join(directory, "index.jsonl")
    const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    const { procStart, pidDomain } = yield* processIdentity(process.pid)
    yield* Effect.tryPromise(() => mkdir(sessionsDirectory, { recursive: true, mode: 0o700 }))
    yield* Effect.tryPromise(() => mkdir(socketDirectory, { recursive: true, mode: 0o700 }))
    yield* Effect.tryPromise(() => Bun.write(index, ""))
    yield* Effect.tryPromise(() =>
      Bun.write(
        join(sessionsDirectory, `${process.pid}.json`),
        JSON.stringify({
          pid: process.pid,
          sessionId,
          startedAt: Date.now(),
          procStart,
          peerProtocol: 1,
          messagingSocketPath: socketPath,
          name: "Receipt Stream"
        })
      )
    )
    const keyPath = join(sessionsDirectory, `${process.pid}.${"d".repeat(64)}.key`)
    yield* Effect.tryPromise(() =>
      Bun.write(keyPath, JSON.stringify({ peerToken: "1".repeat(32), procStart, pidDomain }))
    )
    yield* Effect.tryPromise(() => chmod(keyPath, 0o600))
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const later = (delay: number, action: () => void) => {
      const timer = setTimeout(() => {
        timers.delete(timer)
        action()
      }, delay)
      timers.add(timer)
    }
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const timer of timers) clearTimeout(timer)
        timers.clear()
      })
    )
    const receipt = (messageId: string, fields: Readonly<Record<string, string>>) =>
      `${JSON.stringify({
        type: "control",
        action: "peer_message_status",
        reason: "fixture policy",
        orig_msg_id: messageId,
        ...fields
      })}\n`
    let reply: (connection: Socket, messageId: string) => void = () => {}
    const inbox = createServer((socket) => {
      let body = ""
      socket.setEncoding("utf8")
      socket.on("data", (chunk) => {
        body += chunk
      })
      socket.on("end", () => {
        // SAFETY: this fixture owns the only writer and echoes back its own fields.
        const frame = JSON.parse(body.trim().split("\n")[1]!)
        const connection = createConnection(String(frame.from).replace(/^uds:/, ""))
        connection.on("error", () => {})
        connection.once("connect", () => {
          reply(connection, String(frame.msg_id))
          // Claude Code writes the receipt and only closes 150ms later on macOS.
          later(400, () => connection.end())
        })
      })
    })
    yield* listen(inbox, socketPath)
    yield* Effect.tryPromise(() => chmod(socketPath, 0o600))
    const env = {
      NUDGE_CLAUDE_SESSIONS_DIR: sessionsDirectory,
      NUDGE_CLAUDE_PROJECTS_DIR: join(directory, "projects"),
      NUDGE_CODEX_SESSION_INDEX: index
    }
    reply = (connection, messageId) => {
      connection.write(receipt(messageId, { status: "held" }))
    }
    const held = yield* runCli(["send", "Receipt Stream", "held message"], env)
    expect(held.exitCode).toBe(3)
    expect(held.stdout).toBe("")
    expect(held.stderr).toBe(
      `warning: message to Claude session "Receipt Stream" (${sessionId}) is held: fixture policy\nhint: Do not resend while delivery is pending\n`
    )
    reply = (connection, messageId) => {
      const line = receipt(messageId, { status: "expired", status_detail: "refused" })
      const split = Math.floor(line.length / 2)
      connection.write(line.slice(0, split))
      later(50, () => connection.write(line.slice(split)))
    }
    const refused = yield* runCli(["send", "Receipt Stream", "refused message"], env)
    expect(refused.exitCode).toBe(1)
    expect(refused.stdout).toBe("")
    expect(refused.stderr).toBe(
      `error: message to Claude session "Receipt Stream" (${sessionId}) was refused: fixture policy\n`
    )
    reply = (connection, messageId) => {
      connection.write(
        receipt(messageId, { status: "refused", orig_msg_id: "another-message" }) +
          receipt(messageId, { status: "delivered" })
      )
    }
    const delivered = yield* runCli(["send", "Receipt Stream", "delivered message", "--json"], env)
    expect(delivered.exitCode).toBe(0)
    expect(delivered.stderr).toBe("")
    expect(JSON.parse(delivered.stdout)).toMatchObject({
      status: "delivered",
      reason: "fixture policy"
    })
  }),
  15000
)

const processIdentity = Effect.fn("processIdentity")(function* (pid: number) {
  if (process.platform === "linux") {
    const [stat, machine, namespace] = yield* Effect.all(
      [
        Effect.tryPromise(() => Bun.file(`/proc/${pid}/stat`).text()),
        Effect.tryPromise(() => Bun.file("/etc/machine-id").text()),
        Effect.tryPromise(() => readlink("/proc/self/ns/pid"))
      ],
      { concurrency: "unbounded" }
    )
    return {
      procStart: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]!,
      pidDomain: `linux:${machine.trim()}:${namespace}`
    }
  }
  const child = yield* spawnScoped(() =>
    Bun.spawn(["ps", "-o", "lstart=", "-p", String(pid)], {
      env: { ...environment, LC_ALL: "C", TZ: "UTC" },
      stdout: "pipe",
      stderr: "ignore"
    })
  )
  const procStart = (yield* Effect.tryPromise(() => Bun.readableStreamToText(child.stdout))).trim()
  expect(yield* Effect.tryPromise(() => child.exited)).toBe(0)
  expect(procStart).not.toBe("")
  return { procStart, pidDomain: process.platform }
})
