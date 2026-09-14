import { expect } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect, type Schema } from "effect"

import { runCli, temporaryDirectory, testEffect } from "./support.ts"

const archivedSession = {
  sessionId: "local_archived",
  cliSessionId: "claude-archived",
  title: "Archived review",
  isArchived: true,
  createdAt: 1000,
  lastActivityAt: 2000,
  cwd: "/project",
  model: "test-model",
  effort: "high"
}

const write = (path: string, value: Schema.Json) =>
  Effect.tryPromise(() => Bun.write(path, JSON.stringify(value)))

testEffect(
  "Claude archives use Desktop's archive flag and current account, not process history",
  Effect.gen(function* () {
    const root = yield* temporaryDirectory(join(tmpdir(), "nudge-archives-"))
    const desktop = join(root, "desktop")
    const env = {
      NUDGE_CLAUDE_DESKTOP_DIR: desktop,
      NUDGE_CLAUDE_SESSIONS_DIR: join(root, "no-live-sessions"),
      NUDGE_CODEX_SESSION_INDEX: join(root, "index.jsonl"),
      NUDGE_CODEX_STATE_DB: join(root, "missing.sqlite")
    }
    yield* write(join(desktop, "config.json"), { lastKnownAccountUuid: "current" })
    const store = join(desktop, "claude-code-sessions")
    yield* write(join(store, "current", "org", "local_archived.json"), archivedSession)
    yield* write(join(store, "current", "org", "local_idle.json"), {
      ...archivedSession,
      sessionId: "local_idle",
      cliSessionId: "idle",
      isArchived: false
    })
    yield* write(join(store, "other-account", "org", "local_other.json"), {
      ...archivedSession,
      cliSessionId: "other-account"
    })
    const result = yield* runCli(["list", "--archived", "--json"], env)
    expect(result.exitCode).toBe(0)
    const rows = JSON.parse(result.stdout).targets
    expect(rows).toEqual([
      {
        provider: "claude",
        id: "claude-archived",
        name: "Archived review",
        archived: true,
        pid: null,
        cwd: "/project",
        startedAt: "1970-01-01T00:00:01.000Z",
        lastActiveAt: "1970-01-01T00:00:02.000Z",
        lastModel: "test-model",
        lastEffort: "high"
      }
    ])
    expect(JSON.parse((yield* runCli(["list", "--json"], env)).stdout).targets).toEqual([])
    expect(
      JSON.parse((yield* runCli(["list", "--archived", "unmatched", "--json"], env)).stdout).targets
    ).toEqual([])
    const sent = yield* runCli(["send", "claude-archived", "hello"], env)
    expect(sent.exitCode).toBe(1)
    expect(sent.stderr).toContain('target "claude-archived" is archived')
    yield* write(join(store, "current", "second-org", "local_second.json"), archivedSession)
    const ambiguous = yield* runCli(["list", "--archived", "--json"], env)
    expect(ambiguous.exitCode).toBe(1)
    expect(ambiguous.stderr).toContain("multiple organizations")
  })
)

testEffect(
  "Claude archive discovery tolerates absent Desktop and rejects malformed records",
  Effect.gen(function* () {
    const root = yield* temporaryDirectory(join(tmpdir(), "nudge-archives-"))
    const env = {
      NUDGE_CLAUDE_DESKTOP_DIR: root,
      NUDGE_CLAUDE_SESSIONS_DIR: join(root, "missing"),
      NUDGE_CODEX_SESSION_INDEX: join(root, "index.jsonl"),
      NUDGE_CODEX_STATE_DB: join(root, "missing.sqlite")
    }
    expect(
      JSON.parse((yield* runCli(["list", "--archived", "--json"], env)).stdout).targets
    ).toEqual([])
    yield* write(join(root, "config.json"), { lastKnownAccountUuid: "../outside" })
    expect((yield* runCli(["list", "--archived"], env)).exitCode).toBe(1)
    yield* write(join(root, "config.json"), { lastKnownAccountUuid: "current" })
    yield* write(join(root, "claude-code-sessions", "current", "org", "local_bad.json"), {
      ...archivedSession,
      lastActivityAt: "invalid"
    })
    expect((yield* runCli(["list", "--archived"], env)).exitCode).toBe(1)
  })
)
