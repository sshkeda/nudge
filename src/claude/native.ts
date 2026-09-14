import { lstat, readdir, readlink } from "node:fs/promises"
import { dirname, isAbsolute, join } from "node:path"

import { Deferred, Effect, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

import { claudeConfigDirectory } from "./config.ts"
import { readClaudeTitles } from "./titles.ts"

const PEER_PROTOCOL = 1
const MAX_FRAME_BYTES = 262_144
const RECEIPT_WAIT_MS = 300

const SessionSchema = Schema.Struct({
  pid: Schema.Int,
  sessionId: Schema.String,
  startedAt: Schema.Number,
  procStart: Schema.String,
  peerProtocol: Schema.Literal(PEER_PROTOCOL),
  messagingSocketPath: Schema.String,
  name: Schema.String,
  bridgeSessionId: Schema.optional(Schema.NullOr(Schema.String)),
  cwd: Schema.optional(Schema.String)
})

const PeerKeySchema = Schema.Struct({
  peerToken: Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/i)),
  procStart: Schema.String,
  pidDomain: Schema.String
})

const ReceiptSchema = Schema.Struct({
  type: Schema.Literal("control"),
  action: Schema.Literal("peer_message_status"),
  orig_msg_id: Schema.String,
  status: Schema.Literals(["held", "refused", "dropped", "denied", "expired", "delivered"]),
  status_detail: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String)
})

const TranscriptEventSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["user", "assistant"]),
    timestamp: Schema.String,
    effort: Schema.optional(Schema.String),
    message: Schema.optional(Schema.Struct({ model: Schema.optional(Schema.String) }))
  }),
  Schema.Struct({
    type: Schema.Literal("custom-title"),
    customTitle: Schema.String,
    sessionId: Schema.String
  }),
  Schema.Struct({
    type: Schema.Literal("agent-name"),
    agentName: Schema.String,
    sessionId: Schema.String
  })
])

type Session = Schema.Schema.Type<typeof SessionSchema>

export interface ClaudeNativeTarget {
  readonly provider: "claude"
  readonly id: string
  readonly name: string
  readonly pid: number
  readonly cwd: string | null
  readonly startedAt: string
  readonly socketPath: string
  readonly keyPath: string
  readonly bridgeSessionId: string | null
}

export type ClaudeSession = ClaudeNativeTarget & {
  readonly lastActiveAt: string
  readonly lastModel: string | null
  readonly lastEffort: string | null
}

export const readClaudeNativeTargets = Effect.fn("readClaudeNativeTargets")(function* () {
  const directory =
    Bun.env["NUDGE_CLAUDE_SESSIONS_DIR"] ?? join(claudeConfigDirectory(), "sessions")
  if (!(yield* privateDirectory(directory))) return []

  const names = yield* Effect.tryPromise({
    try: () => readdir(directory),
    catch: (cause) => cause
  }).pipe(
    Effect.catch((cause) =>
      isNotFound(cause)
        ? Effect.succeed([])
        : Effect.fail(
            new Error(`cannot list Claude session registry ${directory}: ${errorMessage(cause)}`, {
              cause
            })
          )
    )
  )
  const keyNames = names.filter((name) => name.endsWith(".key"))
  const pidDomain =
    process.platform === "linux"
      ? yield* Effect.all(
          [
            Effect.tryPromise(() => Bun.file("/etc/machine-id").text()).pipe(
              Effect.map((value) => value.trim()),
              Effect.catch(() => Effect.succeed(""))
            ),
            Effect.tryPromise(() => readlink("/proc/self/ns/pid")).pipe(
              Effect.catch(() => Effect.succeed(""))
            )
          ],
          { concurrency: "unbounded" }
        ).pipe(Effect.map(([machine, namespace]) => `linux:${machine}:${namespace}`))
      : process.platform
  const targets: ClaudeNativeTarget[] = []
  for (const name of names.filter((candidate) => candidate.endsWith(".json"))) {
    const session = yield* readSession(join(directory, name))
    if (session === null || !processExists(session.pid)) continue
    if (!(yield* privateSocket(session.messagingSocketPath))) continue

    const keyPath = yield* matchingKey(directory, keyNames, session, pidDomain)
    if (keyPath === null) continue
    if ((yield* readProcessStart(session.pid)) !== session.procStart) continue
    targets.push({
      provider: "claude",
      id: session.sessionId,
      name: session.name,
      cwd: session.cwd ?? null,
      pid: session.pid,
      startedAt: new Date(session.startedAt).toISOString(),
      socketPath: session.messagingSocketPath,
      keyPath,
      bridgeSessionId: session.bridgeSessionId || null
    })
  }
  return targets
})

export const withClaudeMetadata = Effect.fn("withClaudeMetadata")(function* (
  targets: readonly ClaudeNativeTarget[],
  titles = new Map<string, string>()
) {
  const directory =
    Bun.env["NUDGE_CLAUDE_PROJECTS_DIR"] ?? join(claudeConfigDirectory(), "projects")
  return yield* Effect.forEach(targets, (target) =>
    Effect.gen(function* () {
      const metadata = yield* readTranscriptMetadata(directory, target.id)
      // An empty entry records that the transcript names no title, so a remote
      // session still falls back to the app title.
      titles.set(target.id, metadata.title ?? "")
      return {
        ...target,
        name: metadata.title ?? target.name,
        lastActiveAt: metadata.lastActiveAt ?? target.startedAt,
        lastModel: metadata.lastModel,
        lastEffort: metadata.lastEffort
      }
    })
  )
})

export const withClaudeNames = Effect.fn("withClaudeNames")(function* (
  targets: readonly ClaudeNativeTarget[],
  titles: Map<string, string>
) {
  yield* withClaudeMetadata(
    targets.filter((target) => !titles.has(target.id)),
    titles
  )
  return yield* withClaudeAppTitles(
    targets.map((target) => ({ ...target, name: titles.get(target.id) || target.name })),
    titles
  )
})

export const withClaudeAppTitles = Effect.fn("withClaudeAppTitles")(function* <
  T extends ClaudeNativeTarget
>(targets: readonly T[], titles = new Map<string, string>()) {
  const remoteIds = new Map<string, string>()
  for (const target of targets) {
    // A title the session set itself outranks the one the app reports.
    if (target.bridgeSessionId !== null && !titles.get(target.id))
      remoteIds.set(target.id, target.bridgeSessionId)
  }
  if (remoteIds.size === 0) return targets

  const missing = [...remoteIds.values()].filter((id) => !titles.has(id))
  if (missing.length > 0) {
    for (const [id, title] of yield* readClaudeTitles(missing)) titles.set(id, title)
  }
  return targets.map((target) => {
    const remoteId = remoteIds.get(target.id)
    const title = remoteId === undefined ? undefined : titles.get(remoteId)
    return title === undefined ? target : { ...target, name: title }
  })
})

export const withClaudeAppTitle = Effect.fn("withClaudeAppTitle")(function* (
  target: ClaudeNativeTarget,
  titles = new Map<string, string>()
) {
  const [named = target] = yield* withClaudeNames([target], titles)
  return named
})

type TranscriptMetadata = {
  title: string | null
  lastActiveAt: string | null
  lastModel: string | null
  lastEffort: string | null
}

const readTranscriptMetadata = Effect.fn("readTranscriptMetadata")(function* (
  projectsDirectory: string,
  sessionId: string
) {
  const metadata: TranscriptMetadata = {
    title: null,
    lastActiveAt: null,
    lastModel: null,
    lastEffort: null
  }
  let lastAssistantAt = -Infinity
  const candidates: Array<{ readonly path: string; readonly modifiedAt: number }> = []
  const glob = new Bun.Glob(`*/${sessionId}.jsonl`)
  yield* Stream.fromAsyncIterable(
    glob.scan({
      cwd: projectsDirectory,
      absolute: true,
      onlyFiles: true
    }),
    (cause) => cause
  ).pipe(
    Stream.runForEach((path) =>
      Effect.gen(function* () {
        const file = yield* Effect.tryPromise({ try: () => lstat(path), catch: (cause) => cause })
        if (file.isFile() && !file.isSymbolicLink()) {
          candidates.push({ path, modifiedAt: file.mtimeMs })
        }
      })
    ),
    Effect.catch((cause) =>
      isNotFound(cause)
        ? Effect.sync(() => {
            candidates.length = 0
          })
        : Effect.fail(
            new Error(
              `cannot inspect Claude transcripts in ${projectsDirectory}: ${errorMessage(cause)}`,
              { cause }
            )
          )
    )
  )

  for (const candidate of candidates.toSorted(
    (left, right) => left.modifiedAt - right.modifiedAt
  )) {
    const contents = yield* Effect.tryPromise({
      try: () => Bun.file(candidate.path).text(),
      catch: (cause) =>
        new Error(`cannot read Claude transcript ${candidate.path}: ${errorMessage(cause)}`, {
          cause
        })
    })
    for (const line of contents.split("\n")) {
      try {
        const event = Schema.decodeUnknownSync(TranscriptEventSchema)(JSON.parse(line))
        if (event.type === "user" || event.type === "assistant") {
          const timestamp = Date.parse(event.timestamp)
          if (!Number.isFinite(timestamp)) continue
          if (metadata.lastActiveAt === null || timestamp > Date.parse(metadata.lastActiveAt))
            metadata.lastActiveAt = new Date(timestamp).toISOString()
          const model = event.message?.model
          if (
            event.type === "assistant" &&
            model &&
            !model.startsWith("<") &&
            timestamp >= lastAssistantAt
          ) {
            lastAssistantAt = timestamp
            metadata.lastModel = model
            metadata.lastEffort = event.effort ?? null
          }
        } else if (event.type === "custom-title" || event.type === "agent-name") {
          if (event.sessionId !== sessionId) continue
          const title = event.type === "custom-title" ? event.customTitle : event.agentName
          if (title.trim()) metadata.title = title.trim()
        }
      } catch {
        // Ignore unrelated or incomplete transcript records.
      }
    }
  }
  return metadata
})

export const sendClaudeNative = Effect.fn("sendClaudeNative")(function* (
  target: ClaudeNativeTarget,
  message: string,
  timeoutMs: number
) {
  if (!(yield* privateSocket(target.socketPath))) {
    return yield* Effect.fail(
      new Error(`Claude inbox is no longer a private live socket: ${target.socketPath}`)
    )
  }
  const key = yield* readPeerKey(target.keyPath)
  const messageId = crypto.randomUUID()
  const receipt = yield* Effect.acquireRelease(
    Effect.try({
      try: () => openReceiptSocket(dirname(target.socketPath), messageId),
      catch: (cause) => cause
    }),
    (owned) => owned.close.pipe(Effect.orDie)
  )
  const auth = JSON.stringify({ type: "auth", token: key.peerToken })
  const frame = JSON.stringify({
    msgV: PEER_PROTOCOL,
    msg_id: messageId,
    type: "user",
    message: { role: "user", content: message },
    priority: "next",
    from: `uds:${receipt.path}`
  })
  const payload = `${auth}\n${frame}\n`
  const bytes = Buffer.byteLength(payload)
  if (bytes > MAX_FRAME_BYTES) {
    return yield* Effect.fail(
      new Error(`message is too large for Claude: ${bytes} bytes; maximum ${MAX_FRAME_BYTES}`)
    )
  }
  yield* writeSocket(target.socketPath, payload, timeoutMs)
  const result = yield* receipt.read
  const receiptResult: {
    messageId: string
    status: "sent" | ReceiptResult["status"]
    reason?: string
  } = result === null ? { messageId, status: "sent" } : { messageId, ...result }
  return receiptResult
}, Effect.scoped)

type ReceiptResult = {
  readonly status: "held" | "refused" | "dropped" | "denied" | "expired" | "delivered"
  readonly reason?: string
}

function openReceiptSocket(directory: string, messageId: string) {
  const path = join(directory, `${crypto.getRandomValues(new Uint8Array(4)).toHex()}.sock`)
  const terminal = Deferred.makeUnsafe<ReceiptResult>()
  let held: ReceiptResult | null = null
  const accept = (line: string) => {
    if (!line.trim()) return
    try {
      const parsed = Schema.decodeUnknownSync(ReceiptSchema)(JSON.parse(line))
      if (parsed.orig_msg_id !== messageId) return
      const status =
        parsed.status === "expired" && parsed.status_detail === "refused"
          ? "refused"
          : parsed.status
      const result = parsed.reason === undefined ? { status } : { status, reason: parsed.reason }
      if (status === "held") held = result
      else Deferred.doneUnsafe(terminal, Effect.succeed(result))
    } catch {}
  }
  const previousMask = process.umask(0o077)
  let server: Bun.UnixSocketListener<{ body: string; decoder: TextDecoder }>
  try {
    server = Bun.listen<{ body: string; decoder: TextDecoder }>({
      unix: path,
      socket: {
        open(socket) {
          socket.data = { body: "", decoder: new TextDecoder() }
        },
        data(socket, chunk) {
          // Claude Code holds the connection open after writing, so every
          // complete line is parsed as it arrives.
          const lines = (
            socket.data.body + socket.data.decoder.decode(chunk, { stream: true })
          ).split("\n")
          socket.data.body = lines.pop() ?? ""
          for (const line of lines) accept(line)
        },
        end(socket) {
          accept(socket.data.body + socket.data.decoder.decode())
          socket.end()
        },
        error(socket) {
          socket.end()
        }
      }
    })
  } finally {
    process.umask(previousMask)
  }
  return {
    path,
    read: Deferred.await(terminal).pipe(
      Effect.timeoutOrElse({ duration: RECEIPT_WAIT_MS, orElse: () => Effect.succeed(held) })
    ),
    close: Effect.gen(function* () {
      server.stop(true)
      yield* Effect.tryPromise({
        try: () => Bun.file(path).delete(),
        catch: (cause) => cause
      }).pipe(Effect.catch((cause) => (isNotFound(cause) ? Effect.void : Effect.fail(cause))))
    })
  }
}

const readSession = Effect.fn("readSession")(
  function* (path: string) {
    const file = yield* Effect.tryPromise({ try: () => lstat(path), catch: (cause) => cause })
    if (!file.isFile() || file.isSymbolicLink()) return null
    const value = yield* Effect.tryPromise({
      try: () => Bun.file(path).json(),
      catch: (cause) => cause
    })
    return yield* Schema.decodeUnknownEffect(SessionSchema)(value)
  },
  Effect.catch(() => Effect.succeed(null))
)

const matchingKey = Effect.fn("matchingKey")(function* (
  directory: string,
  names: readonly string[],
  session: Session,
  pidDomain: string
) {
  const pattern = new RegExp(`^${session.pid}\\.[0-9a-f]{64}\\.key$`, "i")
  const matches: string[] = []
  for (const name of names.filter((candidate) => pattern.test(candidate))) {
    const path = join(directory, name)
    const key = yield* readPeerKey(path).pipe(Effect.catch(() => Effect.succeed(null)))
    if (key?.procStart === session.procStart && key.pidDomain === pidDomain) matches.push(path)
  }
  return matches.length === 1 ? matches[0]! : null
})

const readPeerKey = Effect.fn("readPeerKey")(function* (path: string) {
  const file = yield* Effect.tryPromise({
    try: () => lstat(path),
    catch: (cause) =>
      new Error(`cannot inspect Claude peer key ${path}: ${errorMessage(cause)}`, { cause })
  })
  const uid = process.getuid?.()
  if (
    !file.isFile() ||
    file.isSymbolicLink() ||
    uid === undefined ||
    file.uid !== uid ||
    (file.mode & 0o077) !== 0
  ) {
    return yield* Effect.fail(
      new Error(`Claude peer key is not a private regular file owned by this user: ${path}`)
    )
  }
  return yield* Effect.tryPromise({
    try: () => Bun.file(path).json(),
    catch: (cause) => cause
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(PeerKeySchema)),
    Effect.mapError(
      (cause) =>
        new Error(`Claude peer key is malformed: ${path}: ${errorMessage(cause)}`, { cause })
    )
  )
})

const privateDirectory = Effect.fn("privateDirectory")(
  function* (path: string) {
    const directory = yield* Effect.tryPromise({ try: () => lstat(path), catch: (cause) => cause })
    const uid = process.getuid?.()
    return (
      directory.isDirectory() &&
      !directory.isSymbolicLink() &&
      uid !== undefined &&
      directory.uid === uid &&
      (directory.mode & 0o077) === 0
    )
  },
  (effect, path) =>
    effect.pipe(
      Effect.catch((cause) =>
        isNotFound(cause)
          ? Effect.succeed(false)
          : Effect.fail(
              new Error(`cannot inspect Claude session registry ${path}: ${errorMessage(cause)}`, {
                cause
              })
            )
      )
    )
)

const privateSocket = Effect.fn("privateSocket")(
  function* (path: string) {
    if (!isAbsolute(path)) return false
    const [socket, parent] = yield* Effect.all(
      [
        Effect.tryPromise({ try: () => lstat(path), catch: (cause) => cause }),
        Effect.tryPromise({ try: () => lstat(dirname(path)), catch: (cause) => cause })
      ],
      { concurrency: "unbounded" }
    )
    const uid = process.getuid?.()
    return (
      socket.isSocket() &&
      !socket.isSymbolicLink() &&
      parent.isDirectory() &&
      !parent.isSymbolicLink() &&
      uid !== undefined &&
      socket.uid === uid &&
      parent.uid === uid &&
      (socket.mode & 0o077) === 0 &&
      (parent.mode & 0o077) === 0
    )
  },
  Effect.catch(() => Effect.succeed(false))
)

function writeSocket(path: string, payload: string, timeoutMs: number) {
  const bytes = new TextEncoder().encode(payload)
  return Effect.callback<void, Error>((resume) => {
    let connection: Bun.Socket | undefined
    let offset = 0
    let settled = false
    const finish = (cause?: Error) => {
      if (settled) return
      settled = true
      connection?.end()
      resume(cause === undefined ? Effect.void : Effect.fail(cause))
    }
    const fail = (cause: Error) =>
      finish(new Error(`cannot write Claude inbox ${path}: ${cause.message}`, { cause }))
    const write = (socket: Bun.Socket) => {
      if (settled) return
      const written = socket.write(bytes.subarray(offset))
      if (written < 0) {
        fail(new Error("connection closed before message was written"))
        return
      }
      offset += written
      if (offset === bytes.length) finish()
    }
    void Bun.connect<undefined>({
      unix: path,
      socket: {
        open(socket) {
          connection = socket
          if (settled) socket.end()
          else write(socket)
        },
        drain: write,
        data() {},
        close() {
          if (!settled) fail(new Error("connection closed before message was written"))
        },
        error(_socket, cause) {
          fail(cause)
        }
      }
    }).catch(fail)
    return Effect.sync(() => {
      settled = true
      connection?.terminate()
    })
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () =>
        Effect.fail(
          new Error(
            `Claude send timed out after ${timeoutMs / 1000} seconds; delivery outcome is unknown`
          )
        )
    })
  )
}

const readProcessStart = Effect.fn("readProcessStart")(
  function* (pid: number) {
    if (process.platform === "linux") {
      const stat = yield* Effect.tryPromise(() => Bun.file(`/proc/${pid}/stat`).text())
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]
    }
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const child = yield* spawner.spawn(
      ChildProcess.make("ps", ["-o", "lstart=", "-p", String(pid)], {
        env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        killSignal: "SIGKILL"
      })
    )
    const [code, stdout] = yield* Effect.all(
      [child.exitCode, Stream.mkString(Stream.decodeText(child.stdout))],
      { concurrency: "unbounded" }
    )
    return code === 0 ? stdout.trim() : undefined
  },
  Effect.timeout(1000),
  Effect.scoped,
  Effect.catch(() => Effect.succeed(undefined))
)

function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function isNotFound(cause: unknown): cause is Error & { code: "ENOENT" } {
  return cause instanceof Error && "code" in cause && cause["code"] === "ENOENT"
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
