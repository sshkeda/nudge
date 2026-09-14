import { Database } from "bun:sqlite"
import { readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import { Effect, Result, Schema } from "effect"

const IndexLineSchema = Schema.Struct({
  id: Schema.String,
  thread_name: Schema.optionalKey(Schema.String)
})

const MetadataSchema = Schema.Struct({
  archived: Schema.Literals([0, 1]),
  last_active: Schema.Number,
  model: Schema.NullOr(Schema.String),
  reasoning_effort: Schema.NullOr(Schema.String),
  cwd: Schema.String
})

export type CodexSession = {
  readonly id: string
  readonly name: string
  readonly archived: boolean
  readonly lastActiveAt: string
  readonly lastModel: string | null
  readonly lastEffort: string | null
  readonly cwd: string
}

export const readCodexSessions = Effect.fn("readCodexSessions")(function* () {
  const path =
    Bun.env["NUDGE_CODEX_SESSION_INDEX"] ??
    join(Bun.env["CODEX_HOME"] ?? join(homedir(), ".codex"), "session_index.jsonl")
  const body = yield* Effect.tryPromise({
    try: () => Bun.file(path).text(),
    catch: (cause) =>
      new Error(`cannot read Codex session index ${path}: ${errorMessage(cause)}`, { cause })
  })
  const latest = new Map<string, string>()
  const lines = body.split("\n")
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim()
    if (!line) continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch (cause) {
      return yield* Effect.fail(
        new Error(
          `Codex session index ${path}:${index + 1} is invalid JSON: ${errorMessage(cause)}`,
          { cause }
        )
      )
    }
    const parsed = Schema.decodeUnknownResult(IndexLineSchema)(value)
    if (Result.isFailure(parsed)) continue
    const name = parsed.success.thread_name?.trim() ?? ""
    if (name) latest.set(parsed.success.id, name)
  }
  if (latest.size === 0) return []

  let databasePath = Bun.env["NUDGE_CODEX_STATE_DB"]
  if (databasePath === undefined) {
    const directory = dirname(path)
    const candidates = (yield* Effect.tryPromise({
      try: () => readdir(directory),
      catch: (cause) => cause
    }))
      .map((name) => ({ name, version: /^state_(\d+)\.sqlite$/.exec(name)?.[1] }))
      .filter((entry) => entry.version !== undefined)
      .toSorted((left, right) => Number(right.version) - Number(left.version))
    const newest = candidates[0]
    if (newest === undefined)
      return yield* Effect.fail(new Error(`cannot find Codex session metadata in ${directory}`))
    databasePath = join(directory, newest.name)
  }
  const selectedPath = databasePath
  return yield* Effect.gen(function* () {
    const database = yield* Effect.acquireRelease(
      Effect.try({
        try: () => new Database(selectedPath, { readwrite: true, create: false }),
        catch: (cause) => cause
      }),
      (connection) => Effect.sync(() => connection.close())
    )
    return yield* Effect.try({
      try: () => {
        database.exec("PRAGMA query_only = ON")
        const query = database.query(
          "SELECT archived, CASE WHEN recency_at > 0 THEN recency_at ELSE updated_at END AS last_active, model, reasoning_effort, cwd FROM threads WHERE id = ?"
        )
        const threads: CodexSession[] = []
        for (const [id, name] of latest) {
          const row = query.get(id)
          if (row === null) continue
          const metadata = Schema.decodeUnknownSync(MetadataSchema)(row)
          threads.push({
            id,
            name,
            archived: metadata.archived === 1,
            lastActiveAt: new Date(metadata.last_active * 1_000).toISOString(),
            lastModel: metadata.model,
            lastEffort: metadata.reasoning_effort,
            cwd: metadata.cwd
          })
        }
        return threads
      },
      catch: (cause) => cause
    })
  }).pipe(
    Effect.scoped,
    Effect.mapError(
      (cause) =>
        new Error(`cannot read Codex session metadata ${selectedPath}: ${errorMessage(cause)}`, {
          cause
        })
    )
  )
})

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
