import { Effect, type Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

import { readClaudeArchives, type ClaudeArchive } from "./claude/archives.ts"
import {
  type ClaudeNativeTarget,
  type ClaudeSession,
  readClaudeNativeTargets,
  sendClaudeNative,
  withClaudeAppTitle,
  withClaudeMetadata,
  withClaudeNames,
  withClaudeAppTitles
} from "./claude/native.ts"
import { sendViaCodexBridge } from "./codex/bridge.ts"
import { type CodexSession, readCodexSessions } from "./codex/sessions.ts"
import { chooseSourceIdentity, codexMessage, peerMessage } from "./message-envelope.ts"

const SEND_TIMEOUT_MS = 180_000

type CodexTarget = CodexSession & { readonly provider: "codex" }

type LiveTarget = ClaudeNativeTarget | CodexTarget

type TargetSnapshot = {
  readonly claude: readonly ClaudeNativeTarget[]
  readonly codex: readonly CodexTarget[]
  readonly codexFailure: unknown | null
}

export const sendToTarget = Effect.fn("sendToTarget")(function* (options: {
  readonly target: string
  readonly message: string
  readonly json: boolean
}) {
  const { source, target } = yield* Effect.gen(function* () {
    const [snapshot, ancestorPids] = yield* Effect.all([readTargetSnapshot(), readAncestorPids()], {
      concurrency: "unbounded"
    })
    const titles = new Map<string, string>()
    const sender = yield* currentSourceIdentity(snapshot, ancestorPids, titles)
    const destination = yield* resolveTarget(options.target, snapshot, titles)
    return { source: sender, target: destination }
  })
  if (target.provider === "claude") {
    const message = peerMessage(options.message, source)
    const result = yield* sendClaudeNative(target, message, SEND_TIMEOUT_MS)
    const commonOutput = {
      action: "send",
      provider: "claude",
      status: result.status,
      target: { id: target.id, name: target.name },
      messageId: result.messageId
    }
    const output: Schema.Json =
      result.reason === undefined ? commonOutput : { ...commonOutput, reason: result.reason }
    const sent = result.status === "sent" || result.status === "delivered"
    if (sent) {
      writeResult(options.json, output, `Sent message to ${describeSession(target)}`)
    } else {
      process.exitCode = result.status === "held" ? 3 : 1
      const detail = result.reason === undefined ? "" : `: ${result.reason}`
      const status =
        result.status === "held"
          ? "is held"
          : result.status === "expired"
            ? "expired"
            : `was ${result.status}`
      const pending =
        result.status === "held" ? "\nhint: Do not resend while delivery is pending" : ""
      if (options.json) console.log(JSON.stringify(output))
      else
        process.stderr.write(
          `${result.status === "held" ? "warning" : "error"}: message to ${describeSession(target)} ${status}${detail}${pending}\n`
        )
    }
    return
  }

  const message = codexMessage(options.message, source)
  const bridgeOptions: Parameters<typeof sendViaCodexBridge>[0] =
    source?.provider === "codex"
      ? {
          targetThreadId: target.id,
          prompt: message,
          timeoutMs: SEND_TIMEOUT_MS,
          sourceThreadId: source.id
        }
      : {
          targetThreadId: target.id,
          prompt: message,
          timeoutMs: SEND_TIMEOUT_MS
        }
  yield* sendViaCodexBridge(bridgeOptions)
  writeResult(
    options.json,
    {
      action: "send",
      provider: "codex",
      status: "delivered",
      delivery: "native",
      target: { id: target.id, name: target.name }
    },
    `Sent message to ${describeSession(target)}`
  )
})

const currentSourceIdentity = Effect.fn("currentSourceIdentity")(function* (
  snapshot: TargetSnapshot,
  ancestorPids: readonly number[],
  titles: Map<string, string>
) {
  const codexThreadId = Bun.env["CODEX_THREAD_ID"]?.trim() || undefined
  const source = chooseSourceIdentity({
    claudeTargets: snapshot.claude,
    ancestorPids,
    codexThreadId: codexThreadId ?? "",
    codexThreads: snapshot.codex
  })
  if (source?.provider === "claude") {
    const sender = snapshot.claude.find((target) => target.id === source.id)
    if (sender === undefined) return source
    const named = yield* withClaudeAppTitle(sender, titles)
    return { provider: "claude" as const, id: named.id, name: named.name }
  }
  if (codexThreadId !== undefined && snapshot.codexFailure !== null)
    return yield* Effect.fail(snapshot.codexFailure)
  return source
})

const readAncestorPids = Effect.fn("readAncestorPids")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const child = yield* spawner.spawn(
    ChildProcess.make("ps", ["-axo", "pid=,ppid="], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      killSignal: "SIGKILL"
    })
  )
  const [exitCode, stdout, stderr] = yield* Effect.all(
    [
      child.exitCode,
      Stream.mkString(Stream.decodeText(child.stdout)),
      Stream.mkString(Stream.decodeText(child.stderr))
    ],
    { concurrency: "unbounded" }
  )
  if (exitCode !== 0)
    return yield* Effect.fail(
      new Error(`cannot inspect sender process ancestry: ${stderr.trim() || "ps failed"}`)
    )

  const parents = new Map<number, number>()
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (match === null) continue
    parents.set(Number(match[1]), Number(match[2]))
  }
  const result: number[] = []
  const seen = new Set<number>()
  let pid = process.ppid
  while (pid > 0 && !seen.has(pid)) {
    result.push(pid)
    seen.add(pid)
    pid = parents.get(pid) ?? 0
  }
  return result
}, Effect.scoped)

export const listTargets = Effect.fn("listTargets")(function* (options: {
  readonly json: boolean
  readonly archived: boolean
  readonly limit: number | null
  readonly offset: number
  readonly query: string
}) {
  const snapshot = yield* readTargetSnapshot()
  const codexError =
    snapshot.codexFailure === null ? undefined : errorMessage(snapshot.codexFailure)
  const titles = new Map<string, string>()
  const claude: readonly (ClaudeSession | ClaudeArchive)[] = options.archived
    ? yield* readClaudeArchives()
    : yield* withClaudeAppTitles(yield* withClaudeMetadata(snapshot.claude, titles), titles)
  const candidates = [
    ...claude,
    ...snapshot.codex.filter((target) => target.archived === options.archived)
  ]
  const matches = candidates
    .filter(
      (target) =>
        target.name.toLowerCase().includes(options.query.toLowerCase()) ||
        target.id.toLowerCase().includes(options.query.toLowerCase()) ||
        target.provider.includes(options.query.toLowerCase())
    )
    .toSorted(
      (left, right) =>
        Date.parse(right.lastActiveAt) - Date.parse(left.lastActiveAt) ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id)
    )

  const targets = matches.slice(
    options.offset,
    options.limit === null ? undefined : options.offset + options.limit
  )
  const nextOffset =
    options.offset + targets.length < matches.length ? options.offset + targets.length : null
  if (options.json) {
    const output =
      codexError === undefined
        ? {
            action: "list",
            targets: targets.map(publicTarget),
            total: matches.length,
            offset: options.offset,
            nextOffset
          }
        : {
            action: "list",
            targets: targets.map(publicTarget),
            total: matches.length,
            offset: options.offset,
            nextOffset,
            warnings: [{ provider: "codex", error: codexError }]
          }
    console.log(JSON.stringify(output))
    return
  }
  if (targets.length === 0)
    console.log(
      matches.length > 0
        ? "No matches on this page."
        : options.query
          ? `No matches for ${JSON.stringify(options.query)}.`
          : options.archived
            ? "No archived tasks or sessions found."
            : "No tasks or sessions found."
    )
  if (targets.length > 0) console.log(targetTable(targets))
  if (nextOffset !== null) {
    const query = options.query ? ` -- '${options.query.replaceAll("'", "'\\''")}'` : ""
    const archived = options.archived ? " --archived" : ""
    process.stderr.write(
      `Showing ${options.offset + 1}–${options.offset + targets.length} of ${matches.length} matches.\nhint: View more matches with "nudge list${archived} --limit ${options.limit ?? 20} --offset ${nextOffset}${query}"\n`
    )
  }
  if (codexError !== undefined) {
    process.stderr.write(`warning: cannot list Codex tasks: ${codexError}\n`)
  }
})

const resolveTarget = Effect.fn("resolveTarget")(function* (
  query: string,
  snapshot: TargetSnapshot,
  titles: Map<string, string>
) {
  const codex = snapshot.codex.filter((target) => !target.archived)
  const idMatches: readonly LiveTarget[] = [...snapshot.claude, ...codex].filter(
    (target) => target.id === query
  )
  if (idMatches.length === 1) {
    const match = idMatches[0]!
    return match.provider === "claude" ? yield* withClaudeAppTitle(match, titles) : match
  }

  const targets: readonly LiveTarget[] = [
    ...(yield* withClaudeNames(snapshot.claude, titles)),
    ...codex
  ]
  const matches = targets.filter((target) => target.name === query)
  if (matches.length === 1) return matches[0]!
  if (matches.length === 0) {
    if (
      [...snapshot.codex, ...(yield* readClaudeArchives())].some(
        (target) => target.archived && (target.id === query || target.name === query)
      )
    ) {
      return yield* Effect.fail(new Error(`target ${JSON.stringify(query)} is archived`))
    }
    if (snapshot.codexFailure !== null) {
      return yield* Effect.fail(
        new Error(`cannot list Codex tasks: ${errorMessage(snapshot.codexFailure)}`)
      )
    }
    return yield* Effect.fail(
      new Error(`target ${JSON.stringify(query)} not found\nhint: Run "nudge list"`)
    )
  }
  return yield* Effect.fail(
    new Error(
      `multiple targets named ${JSON.stringify(query)}\n\n${targetTable(matches)}\n\nhint: Use an ID instead of the name`
    )
  )
})

const readTargetSnapshot = Effect.fn("readTargetSnapshot")(function* () {
  const claude = yield* readClaudeNativeTargets()
  return yield* readCodexSessions().pipe(
    Effect.map((sessions): TargetSnapshot => ({
      claude,
      codex: sessions.map((thread) => ({
        provider: "codex" as const,
        id: thread.id,
        name: thread.name,
        archived: thread.archived,
        lastActiveAt: thread.lastActiveAt,
        lastModel: thread.lastModel,
        lastEffort: thread.lastEffort,
        cwd: thread.cwd
      })),
      codexFailure: null
    })),
    Effect.catch((codexFailure) =>
      Effect.succeed({ claude, codex: [], codexFailure } satisfies TargetSnapshot)
    )
  )
})

function publicTarget(target: ClaudeSession | ClaudeArchive | CodexTarget): Schema.Json {
  if ("archived" in target && target.archived) return target
  return target.provider === "claude"
    ? {
        provider: target.provider,
        id: target.id,
        name: target.name,
        pid: target.pid,
        startedAt: target.startedAt,
        lastActiveAt: target.lastActiveAt,
        lastModel: target.lastModel,
        lastEffort: target.lastEffort,
        cwd: target.cwd,
        archived: false
      }
    : target
}

function providerName(provider: LiveTarget["provider"]): string {
  return provider === "claude" ? "Claude" : "Codex"
}

function describeSession(target: LiveTarget): string {
  return `${providerName(target.provider)} ${target.provider === "codex" ? "task" : "session"} ${JSON.stringify(target.name)} (${target.id})`
}

function targetTable(targets: readonly (LiveTarget | ClaudeArchive)[]): string {
  const width = Math.max(4, ...targets.map((target) => target.name.length))
  return [
    `${"NAME".padEnd(width)}  PROVIDER  ID`,
    ...targets.map(
      (target) =>
        `${target.name.padEnd(width)}  ${providerName(target.provider).padEnd(8)}  ${target.id}`
    )
  ].join("\n")
}

function writeResult(json: boolean, value: Schema.Json, text: string): void {
  console.log(json ? JSON.stringify(value) : text)
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
