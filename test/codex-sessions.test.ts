import { type Database } from "bun:sqlite"
import { expect } from "bun:test"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"

import {
  environment,
  openDatabase,
  spawnScoped,
  temporaryDirectory,
  testEffect
} from "./support.ts"

testEffect(
  "Codex honors CODEX_HOME, discovers the newest numeric database and never falls back to archived index entries",
  Effect.gen(function* () {
    const directory = yield* temporaryDirectory(join(tmpdir(), "nudge-db-version-"))
    const index = join(directory, "session_index.jsonl")
    const run = Effect.fn("run")(function* (override?: string) {
      const env = {
        ...environment,
        NUDGE_CODEX_STATE_DB: override,
        NUDGE_CODEX_SESSION_INDEX: undefined,
        CODEX_HOME: directory,
        NUDGE_CLAUDE_SESSIONS_DIR: join(directory, "none")
      }
      const child = yield* spawnScoped(() =>
        Bun.spawn([process.execPath, join(import.meta.dir, "../src/main.ts"), "list", "--json"], {
          env,
          stdout: "pipe",
          stderr: "pipe"
        })
      )
      const result = JSON.parse(
        yield* Effect.tryPromise(() => Bun.readableStreamToText(child.stdout))
      )
      expect(yield* Effect.tryPromise(() => child.exited)).toBe(0)
      return result
    })
    yield* Effect.tryPromise(() =>
      Bun.write(index, JSON.stringify({ id: "session", thread_name: "Review" }))
    )
    for (const [version, archived] of [
      [9, 0],
      [10, 1]
    ]) {
      const db = yield* openDatabase(join(directory, `state_${version}.sqlite`))
      db.run(
        "CREATE TABLE threads (id TEXT, archived INTEGER, recency_at INTEGER, updated_at INTEGER, model TEXT, reasoning_effort TEXT, cwd TEXT)"
      )
      db.run("INSERT INTO threads VALUES ('session', ?, 0, 20, NULL, NULL, '/project')", [
        archived!
      ])
      db.close()
    }
    yield* Effect.tryPromise(() =>
      Bun.write(join(directory, "state_99.sqlite-wal"), "not a database")
    )
    expect((yield* run()).targets).toEqual([])
    const explicit = yield* run(join(directory, "state_9.sqlite"))
    expect(explicit.targets[0]).toMatchObject({
      id: "session",
      lastActiveAt: "1970-01-01T00:00:20.000Z"
    })
    yield* Effect.tryPromise(() =>
      Bun.write(join(directory, "state_11.sqlite"), "incompatible database")
    )
    const broken = yield* run()
    expect(broken.targets).toEqual([])
    expect(broken.warnings[0].error).toContain("state_11.sqlite")
  })
)

testEffect(
  "Codex discovery survives WAL cleanup and reads subsequent live updates",
  Effect.gen(function* () {
    const directory = yield* temporaryDirectory(join(tmpdir(), "nudge-wal-cleanup-"))
    const index = join(directory, "session_index.jsonl")
    const path = join(directory, "state_5.sqlite")
    const env = {
      ...environment,
      CODEX_THREAD_ID: undefined,
      CODEX_SESSION_ID: undefined,
      NUDGE_CODEX_STATE_DB: path,
      NUDGE_CODEX_SESSION_INDEX: index,
      NUDGE_CLAUDE_SESSIONS_DIR: join(directory, "none")
    }
    const run = Effect.fn("run")(function* (...args: string[]) {
      const child = yield* spawnScoped(() =>
        Bun.spawn([process.execPath, join(import.meta.dir, "../src/main.ts"), ...args], {
          env,
          stdout: "pipe",
          stderr: "pipe"
        })
      )
      const [stdout, stderr, code] = yield* Effect.all(
        [
          Effect.tryPromise(() => Bun.readableStreamToText(child.stdout)),
          Effect.tryPromise(() => Bun.readableStreamToText(child.stderr)),
          Effect.tryPromise(() => child.exited)
        ],
        { concurrency: "unbounded" }
      )
      return { stdout, stderr, code }
    })
    let writer: Database | undefined
    yield* Effect.tryPromise(() =>
      Bun.write(index, JSON.stringify({ id: "session", thread_name: "Review" }))
    )
    writer = yield* openDatabase(path)
    writer.exec("PRAGMA journal_mode = WAL")
    writer.exec(
      "CREATE TABLE threads (id TEXT, archived INTEGER, recency_at INTEGER, updated_at INTEGER, model TEXT, reasoning_effort TEXT, cwd TEXT)"
    )
    writer.exec("INSERT INTO threads VALUES ('session', 0, 0, 20, NULL, NULL, '/project')")
    writer.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    writer.close()
    writer = undefined
    yield* Effect.tryPromise(() => rm(`${path}-wal`, { force: true }))
    yield* Effect.tryPromise(() => rm(`${path}-shm`, { force: true }))
    const before = Bun.hash(yield* Effect.tryPromise(() => Bun.file(path).arrayBuffer()))
    const cleaned = yield* run("list", "--json")
    expect(cleaned.code).toBe(0)
    expect(cleaned.stderr).toBe("")
    expect(JSON.parse(cleaned.stdout).targets[0]).toMatchObject({
      id: "session",
      lastActiveAt: "1970-01-01T00:00:20.000Z"
    })
    expect(Bun.hash(yield* Effect.tryPromise(() => Bun.file(path).arrayBuffer()))).toBe(before)
    writer = yield* openDatabase(path, { readwrite: true, create: false })
    writer.exec("PRAGMA wal_autocheckpoint = 0")
    writer.exec("BEGIN IMMEDIATE")
    writer.exec("UPDATE threads SET updated_at = 40")
    const uncommitted = yield* run("list", "--json")
    expect(uncommitted.code).toBe(0)
    expect(JSON.parse(uncommitted.stdout).targets[0].lastActiveAt).toBe("1970-01-01T00:00:20.000Z")
    writer.exec("COMMIT")
    const live = yield* run("list", "--json")
    expect(live.code).toBe(0)
    expect(JSON.parse(live.stdout).targets[0].lastActiveAt).toBe("1970-01-01T00:00:40.000Z")
    writer.close()
    writer = undefined
    yield* Effect.tryPromise(() => rm(path))
    const missing = yield* run("send", "Review", "hello", "--json")
    expect(missing.code).toBe(1)
    expect(missing.stdout).toBe("")
    expect(JSON.parse(missing.stderr).error.message).toContain("cannot list Codex tasks")
    expect(JSON.parse(missing.stderr).error.message).not.toContain("not found")
    expect(yield* Effect.tryPromise(() => Bun.file(path).exists())).toBe(false)
  })
)
