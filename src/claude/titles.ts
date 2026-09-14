/* eslint-disable anti-slop/no-shape-in-symbol-names -- response_shape is Claude's API field. */
import { userInfo } from "node:os"
import { join } from "node:path"

import { Effect, Schema, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

import { claudeConfigDirectory } from "./config.ts"

const CredentialsSchema = Schema.Struct({
  claudeAiOauth: Schema.Struct({ accessToken: Schema.NonEmptyString })
})
const SessionSchema = Schema.Struct({ id: Schema.String, title: Schema.NullOr(Schema.String) })
const ResponseSchema = Schema.Union([
  Schema.Struct({ response_shape: SessionSchema }),
  Schema.Struct({ session: SessionSchema })
])

const SESSIONS_ENDPOINT = "https://api.anthropic.com/v1/code/sessions"

const readAccessToken = Effect.fn("readAccessToken")(function* () {
  // A redirected endpoint supplies its own credential, so the signed-in token
  // is only ever sent to Anthropic.
  if (Bun.env["NUDGE_CLAUDE_TITLES_URL"]) return Bun.env["NUDGE_CLAUDE_ACCESS_TOKEN"] ?? ""
  return yield* readStoredAccessToken()
})

export const readStoredAccessToken = Effect.fn("readStoredAccessToken")(function* (
  options = { platform: process.platform, directory: claudeConfigDirectory() }
) {
  const path = join(options.directory, ".credentials.json")
  const file = Effect.tryPromise({
    try: () => Bun.file(path).text(),
    catch: (cause) =>
      isNotFound(cause)
        ? new Error(`no Claude credentials file at ${path}`)
        : new Error(`cannot read Claude credentials file at ${path}: ${errorMessage(cause)}`)
  }).pipe(Effect.flatMap((body) => decodeToken(body, `credentials file ${path}`)))
  if (options.platform !== "darwin") return yield* file
  return yield* readKeychainToken().pipe(
    Effect.catch((keychain) =>
      file.pipe(Effect.mapError((cause) => new Error(`${keychain.message}; ${cause.message}`)))
    )
  )
})

const decodeToken = (body: string, source: string) =>
  Effect.try({
    try: () =>
      Schema.decodeUnknownSync(CredentialsSchema)(JSON.parse(body)).claudeAiOauth.accessToken,
    catch: () => new Error(`cannot read a Claude access token from ${source}`)
  })

const readKeychainToken = Effect.fn("readKeychainToken")(function* () {
  const config = Bun.env["CLAUDE_SECURESTORAGE_CONFIG_DIR"]
  const custom = config !== undefined ? Boolean(config) : Boolean(Bun.env["CLAUDE_CONFIG_DIR"])
  const directory = (config || claudeConfigDirectory()).normalize("NFC")
  const suffix = custom
    ? `-${new Bun.CryptoHasher("sha256").update(directory).digest("hex").slice(0, 8)}`
    : ""
  const account = Bun.env["USER"] || userInfo().username
  const item = `Claude Code-credentials${suffix}`
  const body = yield* Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const child = yield* spawner.spawn(
        ChildProcess.make(
          "security",
          [
            "find-generic-password",
            "-a",
            /^[a-zA-Z0-9._-]+$/.test(account) ? account : "claude-code-user",
            "-w",
            "-s",
            item
          ],
          { stdin: "ignore", stdout: "pipe", stderr: "ignore", killSignal: "SIGKILL" }
        )
      )
      const [code, text] = yield* Effect.all(
        [child.exitCode, Stream.mkString(Stream.decodeText(child.stdout))],
        { concurrency: "unbounded" }
      )
      if (code !== 0)
        return yield* Effect.fail(
          new Error(`keychain lookup for "${item}" failed (security exited ${code})`)
        )
      return text
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof Error && cause.message.startsWith("keychain lookup")
          ? cause
          : new Error(`keychain lookup for "${item}" failed`)
      ),
      Effect.timeoutOrElse({
        duration: 5000,
        orElse: () =>
          Effect.fail(new Error(`keychain lookup for "${item}" timed out after 5 seconds`))
      })
    )
  )

  return yield* decodeToken(body, `keychain item "${item}"`)
})

function remoteId(id: string): string {
  if (!/^(session|cse)_[A-Za-z0-9]+$/.test(id)) throw new Error("invalid remote session ID")
  return id.replace(/^session_/, "cse_")
}

export const readClaudeTitles = Effect.fn("readClaudeTitles")(function* (
  ids: readonly string[],
  dependencies: {
    readAccessToken: () => Effect.Effect<string, Error, ChildProcessSpawner.ChildProcessSpawner>
  } = { readAccessToken }
) {
  if (ids.length === 0) return new Map<string, string>()
  return yield* Effect.gen(function* () {
    const unique = [...new Set(ids)]
    const normalized = yield* Effect.try({
      try: () => unique.map(remoteId),
      catch: (cause) => cause
    })
    const token = yield* dependencies.readAccessToken()
    const client = HttpClient.withScope(yield* HttpClient.HttpClient)
    const endpoint = Bun.env["NUDGE_CLAUDE_TITLES_URL"] || SESSIONS_ENDPOINT
    const entries = yield* Effect.forEach(
      unique,
      (id, index) =>
        Effect.gen(function* () {
          const expectedId = normalized[index]!
          const response = yield* client
            .get(new URL(`${endpoint}/${expectedId}`), {
              headers: {
                Authorization: `Bearer ${token}`,
                "anthropic-version": "2023-06-01",
                "anthropic-client-platform": "claude_code_cli"
              }
            })
            .pipe(Effect.mapError(() => new Error("connection failed")))
          if (response.status === 401)
            return yield* Effect.fail(new Error("Claude rejected the access token (HTTP 401)"))
          if (response.status === 403) return yield* Effect.fail(new Error("access denied"))
          if (response.status < 200 || response.status >= 300)
            return yield* Effect.fail(new Error(`server returned HTTP ${response.status}`))
          const data = yield* HttpClientResponse.schemaBodyJson(ResponseSchema)(response).pipe(
            Effect.mapError(() => new Error("invalid server response"))
          )
          const session = "response_shape" in data ? data.response_shape : data.session
          const returnedId = yield* Effect.try({
            try: () => remoteId(session.id),
            catch: (cause) => cause
          })
          if (returnedId !== expectedId)
            return yield* Effect.fail(new Error("server returned a different session"))
          const title = session.title?.trim()
          if (!title) return yield* Effect.fail(new Error(`remote session ${id} has no title`))
          return [id, title] as const
        }).pipe(Effect.scoped),
      { concurrency: "unbounded" }
    ).pipe(
      Effect.timeoutOrElse({
        duration: 15_000,
        orElse: () => Effect.fail(new Error("request timed out"))
      })
    )
    return new Map(entries)
  }).pipe(
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
    Effect.mapError(
      (cause) =>
        new Error(
          `cannot load Claude session titles: ${cause instanceof Error ? cause.message : "lookup failed"}`,
          { cause }
        )
    )
  )
})

function isNotFound(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause["code"] === "ENOENT"
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
