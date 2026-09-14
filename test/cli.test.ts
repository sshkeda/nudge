import { expect } from "bun:test"
import { chmod } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"

import {
  openDatabase,
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
  "list sorts actual activity, separates archives, and pages complete JSON",
  Effect.gen(function* () {
    const directory = yield* temporaryDirectory(join(tmpdir(), "nudge-pages-"))
    const index = join(directory, "index.jsonl")
    const state = join(directory, "state_5.sqlite")
    const env = {
      NUDGE_CODEX_SESSION_INDEX: index,
      NUDGE_CODEX_STATE_DB: state,
      NUDGE_CLAUDE_SESSIONS_DIR: join(directory, "none"),
      CODEX_THREAD_ID: "",
      CODEX_SESSION_ID: "",
      NUDGE_CODEX_BRIDGE_SOCKET: join(directory, "none.sock")
    }
    const database = yield* openDatabase(state)
    database.run(
      "CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER, recency_at INTEGER, updated_at INTEGER, model TEXT, reasoning_effort TEXT, cwd TEXT)"
    )
    for (const [id, archived, recency, updated] of [
      ["old", 0, 10, 999],
      ["new", 0, 30, 30],
      ["middle", 0, 0, 20],
      ["archive", 1, 40, 40]
    ] as const) {
      database.run("INSERT INTO threads VALUES (?, ?, ?, ?, 'test-model', 'high', '/project')", [
        id,
        archived,
        recency,
        updated
      ])
    }
    database.close()
    yield* Effect.tryPromise(() =>
      Bun.write(
        index,
        [
          { id: "old", thread_name: "Alpha" },
          { id: "new", thread_name: "Zulu" },
          { id: "middle", thread_name: "Middle" },
          { id: "archive", thread_name: "Zulu" },
          { id: "deleted", thread_name: "Deleted" }
        ]
          .map((row) => JSON.stringify({ ...row, updated_at: "2099-01-01T00:00:00Z" }))
          .join("\n")
      )
    )
    const full = JSON.parse((yield* runCli(["list", "--json"], env)).stdout)
    expect(full.targets.map((row: { id: string }) => row.id)).toEqual(["new", "middle", "old"])
    expect(full.targets[0]).toMatchObject({
      lastModel: "test-model",
      lastEffort: "high",
      cwd: "/project",
      archived: false,
      lastActiveAt: "1970-01-01T00:00:30.000Z"
    })
    expect(full).toMatchObject({ total: 3, offset: 0, nextOffset: null })
    const page = JSON.parse(
      (yield* runCli(["list", "--limit", "1", "--offset", "1", "--json"], env)).stdout
    )
    expect(page.targets.map((row: { id: string }) => row.id)).toEqual(["middle"])
    expect(page).toMatchObject({ total: 3, offset: 1, nextOffset: 2 })
    const archived = JSON.parse(
      (yield* runCli(["list", "--archived", "zulu", "--json"], env)).stdout
    )
    expect(archived.targets.map((row: { id: string }) => row.id)).toEqual(["archive"])
    const send = yield* runCli(["send", "Zulu", "hello"], env)
    expect(send.stderr).toContain("bridge")
    expect(send.stderr).not.toContain("multiple sessions")
    const archivedSend = yield* runCli(["send", "archive", "hello"], env)
    expect(archivedSend.exitCode).toBe(1)
    expect(archivedSend.stderr).toBe('error: target "archive" is archived\n')
    const beyond = JSON.parse((yield* runCli(["list", "--offset", "99", "--json"], env)).stdout)
    expect(beyond).toMatchObject({ targets: [], total: 3, offset: 99, nextOffset: null })
    for (const args of [
      ["--limit", "0"],
      ["--offset", "-1"],
      ["--limit", "1.5"],
      ["--all", "--limit", "2"],
      ["--limit"]
    ]) {
      expect((yield* runCli(["list", ...args], env)).exitCode).toBe(2)
    }
    const unavailable = yield* runCli(["list", "--json"], {
      ...env,
      NUDGE_CODEX_STATE_DB: join(directory, "missing.sqlite")
    })
    expect(JSON.parse(unavailable.stdout)).toMatchObject({
      targets: [],
      warnings: [{ provider: "codex" }]
    })
    expect(
      yield* Effect.tryPromise(() => Bun.file(join(directory, "missing.sqlite")).exists())
    ).toBe(false)
  })
)

testEffect(
  "invalid CLI arguments return JSON errors without reading stdin",
  Effect.gen(function* () {
    for (const args of [
      ["send"],
      ["send", "review", "--unknown"],
      ["list", "--limit", "nope"],
      ["list", "--limit", "9007199254740992"],
      ["list", "--limit", "1", "--limit", "2"],
      ["list", "--all", "--limit", "1"],
      ["list", "--all", "--all"],
      ["list", "one", "two"]
    ]) {
      const child = yield* spawnScoped(() =>
        Bun.spawn([process.execPath, mainPath, ...args, "--json=true"], {
          env: environment,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          timeout: 2000
        })
      )
      const [exitCode, stdout, stderr] = yield* Effect.all(
        [
          Effect.tryPromise(() => child.exited),
          Effect.tryPromise(() => Bun.readableStreamToText(child.stdout)),
          Effect.tryPromise(() => Bun.readableStreamToText(child.stderr))
        ],
        { concurrency: "unbounded" }
      )
      expect(exitCode).toBe(2)
      expect(stdout).toBe("")
      expect(JSON.parse(stderr)).toMatchObject({
        status: "error",
        error: { code: "invalid_usage", message: expect.any(String) }
      })
    }
  })
)

testEffect(
  "JSON boolean aliases use consistent error output and respect the operand separator",
  Effect.gen(function* () {
    for (const flag of [
      "--json",
      "--json=true",
      "--json=1",
      "--json=y",
      "--json=yes",
      "--json=on"
    ]) {
      const result = yield* runCli(["list", "--limit", "0", flag], {})
      expect(result.exitCode).toBe(2)
      expect(JSON.parse(result.stderr)).toMatchObject({
        status: "error",
        error: { code: "invalid_usage" }
      })
    }
    for (const args of [
      ["list", "--limit", "0", "--json=false"],
      ["list", "--json=TRUE"],
      ["list", "--json= yes "],
      ["list", "--limit", "0", "--", "--json=yes"],
      ["list", "--limit", "0", "--", "--json"]
    ]) {
      const result = yield* runCli(args, {})
      expect(result.exitCode).toBe(2)
      expect(result.stderr).toStartWith("error: ")
    }
  })
)

testEffect(
  "interrupting a piped message exits without attempting delivery",
  Effect.gen(function* () {
    const child = yield* spawnScoped(() =>
      Bun.spawn([process.execPath, mainPath, "send", "review", "-", "--json"], {
        env: environment,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 2000
      })
    )
    child.stdin.write("a".repeat(1024 * 1024))
    yield* Effect.promise(() => Promise.resolve(child.stdin.flush()))
    child.kill("SIGINT")
    expect(yield* Effect.tryPromise(() => child.exited)).toBe(130)
    expect(yield* Effect.tryPromise(() => Bun.readableStreamToText(child.stdout))).toBe("")
    expect(yield* Effect.tryPromise(() => Bun.readableStreamToText(child.stderr))).toBe("")
  })
)

testEffect(
  "help works without discovering targets or reading stdin",
  Effect.gen(function* () {
    for (const args of [
      [],
      ["--help"],
      ["list", "--help"],
      ["send", "--help"],
      ["help", "list"],
      ["help", "send"],
      ["send", "-h"]
    ]) {
      const child = yield* spawnScoped(() =>
        Bun.spawn([process.execPath, mainPath, ...args], {
          env: {
            ...environment,
            NUDGE_CODEX_SESSION_INDEX: "/missing-index",
            NUDGE_CLAUDE_SESSIONS_DIR: "/missing-sessions"
          },
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe"
        })
      )
      const exitCode = yield* Effect.promise(() => child.exited).pipe(Effect.timeout(2000))
      expect(exitCode).toBe(0)
      expect(yield* Effect.tryPromise(() => Bun.readableStreamToText(child.stderr))).toBe("")
      const help = yield* Effect.tryPromise(() => Bun.readableStreamToText(child.stdout))
      expect(help).toContain("USAGE\n  nudge")
      expect(help).toContain("--help, -h")
      expect(help).toContain("EXAMPLES")
      if (args.includes("list")) {
        expect(help).toContain("--limit integer")
        expect(help).toContain("--archived")
        expect(help).toContain("default: 20")
      }
      if (args.includes("send")) {
        expect(help).toContain("TARGET string")
        expect(help).toContain("Omit or use - to read stdin.")
      }
    }
  })
)

testEffect(
  "list is bounded, searchable, and names come first; send still resolves hidden targets",
  Effect.gen(function* () {
    const directory = yield* temporaryDirectory(join(tmpdir(), "nudge-list-"))
    const index = join(directory, "index.jsonl")
    const env = {
      NUDGE_CLAUDE_SESSIONS_DIR: join(directory, "none"),
      NUDGE_CODEX_SESSION_INDEX: index,
      CODEX_THREAD_ID: "",
      CODEX_SESSION_ID: "",
      NUDGE_CODEX_BRIDGE_SOCKET: join(directory, "absent.sock")
    }
    yield* Effect.tryPromise(() =>
      Bun.write(
        index,
        Array.from({ length: 25 }, (_, i) =>
          JSON.stringify({ id: `id-${i}`, thread_name: `Session ${String(i).padStart(2, "0")}` })
        ).join("\n")
      )
    )
    const listed = yield* runCli(["list"], env)
    expect(listed.exitCode).toBe(0)
    expect(listed.stdout.trim().split("\n")).toHaveLength(21)
    expect(listed.stdout).toStartWith("NAME        PROVIDER  ID\nSession 00  Codex     id-0\n")
    expect(listed.stderr).toContain("Showing 1–20 of 25")
    const all = yield* runCli(["list", "--json"], env)
    expect(JSON.parse(all.stdout).targets).toHaveLength(25)
    for (const value of ["true", "1", "y", "yes", "on"]) {
      const alias = yield* runCli(["list", `--json=${value}`], env)
      expect(alias.exitCode).toBe(0)
      expect(JSON.parse(alias.stdout).targets).toHaveLength(25)
    }
    const capped = yield* runCli(["list", "--limit", "20", "--json"], env)
    expect(JSON.parse(capped.stdout).targets).toHaveLength(20)
    expect(JSON.parse(capped.stdout).total).toBe(25)
    const match = yield* runCli(["list", "SESSION 24"], env)
    expect(match.stdout).toBe("NAME        PROVIDER  ID\nSession 24  Codex     id-24\n")
    const missing = yield* runCli(["list", "missing"], env)
    expect(missing.stdout).toBe('No matches for "missing".\n')
    const received: BridgeRequestFixture[] = []
    const bridge = createServer((socket) => {
      let body = ""
      socket.setEncoding("utf8")
      socket.on("data", (chunk) => {
        body += chunk
        if (!body.includes("\n")) return
        const request: BridgeRequestFixture = JSON.parse(body.trim())
        received.push(request)
        socket.end(
          `${JSON.stringify({ version: 1, id: request.id, status: "delivered", targetThreadId: request.targetThreadId })}\n`
        )
      })
    })
    yield* listen(bridge, env.NUDGE_CODEX_BRIDGE_SOCKET)
    yield* Effect.tryPromise(() => chmod(env.NUDGE_CODEX_BRIDGE_SOCKET, 0o600))
    const hidden = yield* runCli(["send", "Session 24", "hello"], env)
    expect(hidden.exitCode).toBe(0)
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      targetThreadId: "id-24",
      prompt: "Message via nudge CLI:\n\nhello"
    })
    const message = "  first line\n\tsecond line\n\n"
    for (const [args, input] of [
      [["send", "Session 24", message], undefined],
      [["send", "Session 24", "-"], message],
      [["send", "Session 24"], message]
    ] as const) {
      expect((yield* runCli(args, env, input)).exitCode).toBe(0)
      expect(received.at(-1)?.prompt).toBe(`Message via nudge CLI:\n\n${message}`)
    }
    const deliveries = received.length
    for (const [args, input] of [
      [["send", "Session 24", " \n\t"], undefined],
      [["send", "Session 24", "-"], " \n\t"]
    ] as const) {
      const blank = yield* runCli(args, env, input)
      expect(blank.exitCode).toBe(2)
      expect(blank.stderr).toBe("error: message must not be empty\n")
    }
    expect(received).toHaveLength(deliveries)
    const paddedTarget = yield* runCli(["send", " Session 24 ", "hello"], env)
    expect(paddedTarget.exitCode).toBe(0)
    expect(received.at(-1)).toMatchObject({
      targetThreadId: "id-24",
      prompt: "Message via nudge CLI:\n\nhello"
    })
    const rootSessionOnly = yield* runCli(["send", "Session 24", "no source thread"], {
      ...env,
      CODEX_THREAD_ID: " \t ",
      CODEX_SESSION_ID: " id-0 "
    })
    expect(rootSessionOnly.exitCode).toBe(0)
    expect(received.at(-1)?.prompt).toBe("Message via nudge CLI:\n\nno source thread")
    const undiscoveredSource = yield* runCli(["send", "Session 24", "actual source thread"], {
      ...env,
      CODEX_THREAD_ID: "child-thread",
      CODEX_SESSION_ID: "id-0"
    })
    expect(undiscoveredSource.exitCode).toBe(0)
    expect(received.at(-1)?.prompt).toBe(
      'Message from Codex task "child-thread" (child-thread) via nudge CLI:\n\nactual source thread'
    )
    expect(received.at(-1)?.sourceThreadId).toBe("child-thread")
    const literal = yield* runCli(["send", "missing", "--", "--json"], env)
    expect(literal.stderr).toBe('error: target "missing" not found\nhint: Run "nudge list"\n')
    yield* Effect.tryPromise(() =>
      Bun.write(
        index,
        JSON.stringify({ id: "a", thread_name: "Same" }) +
          "\n" +
          JSON.stringify({ id: "b", thread_name: "Same" })
      )
    )
    const duplicate = yield* runCli(["send", "Same", "hello"], env)
    expect(duplicate.stderr).toBe(
      'error: multiple targets named "Same"\n\nNAME  PROVIDER  ID\nSame  Codex     a\nSame  Codex     b\n\nhint: Use an ID instead of the name\n'
    )
    const query = "-$HOME'session"
    yield* Effect.tryPromise(() =>
      Bun.write(
        index,
        ["a", "b"].map((id) => JSON.stringify({ id, thread_name: `${query} ${id}` })).join("\n")
      )
    )
    const quotedPage = yield* runCli(["list", "--limit", "1", "--", query], env)
    const tip = quotedPage.stderr.split('hint: View more matches with "')[1]!.trim().slice(0, -1)
    const shell = yield* spawnScoped(() =>
      Bun.spawn(["sh", join(import.meta.dir, "fixtures/run-hint.sh"), tip], {
        stdout: "pipe",
        stderr: "pipe"
      })
    )
    expect(
      (yield* Effect.tryPromise(() => Bun.readableStreamToText(shell.stdout))).trim().split("\n")
    ).toEqual(["list", "--limit", "1", "--offset", "1", "--", query])
    expect(yield* Effect.tryPromise(() => shell.exited)).toBe(0)
    yield* Effect.tryPromise(() => Bun.write(index, ""))
    const empty = yield* runCli(["list"], env)
    expect(empty.stdout).toBe("No tasks or sessions found.\n")
  }),
  15000
)
