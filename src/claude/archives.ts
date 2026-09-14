import { readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import { Effect, Schema } from "effect"

const Identifier = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]+$/))
const Profile = Schema.Struct({ lastKnownAccountUuid: Schema.optional(Identifier) })
const Session = Schema.Struct({
  sessionId: Identifier,
  cliSessionId: Schema.optional(Identifier),
  isArchived: Schema.Boolean,
  title: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  createdAt: Schema.Number,
  lastActivityAt: Schema.Number,
  model: Schema.optional(Schema.String),
  effort: Schema.optional(Schema.String)
})

export type ClaudeArchive = {
  readonly provider: "claude"
  readonly id: string
  readonly name: string
  readonly archived: true
  readonly pid: null
  readonly cwd: string | null
  readonly startedAt: string
  readonly lastActiveAt: string
  readonly lastModel: string | null
  readonly lastEffort: string | null
}

export const readClaudeArchives = Effect.fn("readClaudeArchives")(function* () {
  const directory = desktopDirectory()
  const profile = yield* readText(join(directory, "config.json"))
  if (profile === null) return []
  const account = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Profile))(profile).pipe(
    Effect.mapError(() => new Error("invalid Claude Desktop account metadata"))
  )
  if (!account.lastKnownAccountUuid) return []
  const root = join(directory, "claude-code-sessions", account.lastKnownAccountUuid)
  const entries = yield* Effect.tryPromise({
    try: () => readdir(root, { withFileTypes: true }),
    catch: (cause) => cause
  }).pipe(Effect.catch((cause) => (isMissing(cause) ? Effect.succeed([]) : Effect.fail(cause))))
  const organizations = entries.filter(
    (entry) => entry.isDirectory() && /^[a-zA-Z0-9_-]+$/.test(entry.name)
  )
  if (organizations.length === 0) return []
  // Never merge histories from different organizations into one session list.
  if (organizations.length !== 1)
    return yield* Effect.fail(
      new Error(
        "cannot select Claude Desktop archive organization: multiple organizations are stored"
      )
    )
  const organization = join(root, organizations[0]!.name)
  const files = yield* Effect.tryPromise(() => readdir(organization, { withFileTypes: true }))
  const archives: ClaudeArchive[] = []
  for (const file of files) {
    if (!file.isFile() || !file.name.startsWith("local_") || !file.name.endsWith(".json")) continue
    const value = yield* readText(join(organization, file.name))
    if (value === null) continue
    const session = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Session))(value).pipe(
      Effect.mapError(() => new Error(`invalid Claude archive ${file.name}`))
    )
    if (!session.isArchived) continue
    if (
      !Number.isFinite(session.createdAt) ||
      !Number.isFinite(session.lastActivityAt) ||
      Math.abs(session.createdAt) > 8.64e15 ||
      Math.abs(session.lastActivityAt) > 8.64e15
    )
      return yield* Effect.fail(new Error(`invalid timestamps in Claude archive ${file.name}`))
    archives.push({
      provider: "claude",
      id: session.cliSessionId ?? session.sessionId,
      name: session.title?.trim() || session.sessionId,
      archived: true,
      pid: null,
      cwd: session.cwd ?? null,
      startedAt: new Date(session.createdAt).toISOString(),
      lastActiveAt: new Date(session.lastActivityAt).toISOString(),
      lastModel: session.model ?? null,
      lastEffort: session.effort ?? null
    })
  }
  return archives
})

function desktopDirectory(): string {
  if (Bun.env["NUDGE_CLAUDE_DESKTOP_DIR"]) return Bun.env["NUDGE_CLAUDE_DESKTOP_DIR"]
  return process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "Claude")
    : join(Bun.env["XDG_CONFIG_HOME"] || join(homedir(), ".config"), "Claude")
}

const readText = Effect.fn("readClaudeArchiveText")(function* (path: string) {
  return yield* Effect.tryPromise({
    try: () => Bun.file(path).text(),
    catch: (cause) => cause
  }).pipe(Effect.catch((cause) => (isMissing(cause) ? Effect.succeed(null) : Effect.fail(cause))))
})

function isMissing(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause["code"] === "ENOENT"
}
