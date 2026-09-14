import { lstat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import { Data, Effect, FiberSet, Schema } from "effect"

const MAX_RESPONSE_BYTES = 64 * 1024
const BRIDGE_VERSION = 1

const BridgeResponseSchema = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(BRIDGE_VERSION),
    id: Schema.String,
    status: Schema.Literal("delivered"),
    targetThreadId: Schema.String
  }),
  Schema.Struct({
    version: Schema.Literal(BRIDGE_VERSION),
    status: Schema.Literal("error"),
    error: Schema.String
  })
])

class CodexBridgeError extends Data.TaggedError("CodexBridgeError")<{
  message: string
  code: string
  cause?: unknown
}> {
  constructor(message: string, code: string, options?: ErrorOptions) {
    super({ message, code, ...options })
  }
}

export const sendViaCodexBridge = Effect.fn("sendViaCodexBridge")(function* (options: {
  readonly targetThreadId: string
  readonly prompt: string
  readonly sourceThreadId?: string
  readonly timeoutMs: number
  readonly socketPath?: string
}) {
  const socketPath =
    options.socketPath ??
    Bun.env["NUDGE_CODEX_BRIDGE_SOCKET"] ??
    join(
      Bun.env["NUDGE_STATE_DIR"] ?? join(homedir(), ".local", "state", "nudge"),
      "codex",
      "desktop-bridge.sock"
    )
  const before = yield* validatePrivateSocket(socketPath)
  const runValidation = yield* FiberSet.makeRuntime<never, void, never>()
  const id = crypto.randomUUID()
  const request = {
    version: BRIDGE_VERSION,
    id,
    targetThreadId: options.targetThreadId,
    prompt: options.prompt,
    sourceThreadId: options.sourceThreadId
  }
  const payload = new TextEncoder().encode(`${JSON.stringify(request)}\n`)
  const response = yield* Effect.callback<string, CodexBridgeError>((resume) => {
    let connection: Bun.Socket | undefined
    let settled = false
    let ready = false
    let offset = 0
    let body = ""
    let bytes = 0
    const decoder = new TextDecoder()
    const finish = (cause?: Error) => {
      if (settled) return
      settled = true
      connection?.end()
      resume(
        cause === undefined
          ? Effect.succeed(body + decoder.decode())
          : Effect.fail(bridgeError(cause))
      )
    }
    const fail = (cause: Error) =>
      finish(
        new CodexBridgeError(
          `cannot connect to the Codex bridge at ${socketPath}: ${cause.message}`,
          "connect-failed",
          { cause }
        )
      )
    const write = (socket: Bun.Socket) => {
      if (settled || !ready || offset === payload.length) return
      const written = socket.write(payload.subarray(offset))
      if (written < 0) {
        fail(new Error("connection closed before request was written"))
        return
      }
      offset += written
    }
    void Bun.connect<undefined>({
      unix: socketPath,
      socket: {
        open(socket) {
          connection = socket
          if (settled) {
            socket.end()
            return
          }
          runValidation(
            Effect.gen(function* () {
              const after = yield* validatePrivateSocket(socketPath)
              if (settled) return
              if (before.dev !== after.dev || before.ino !== after.ino) {
                finish(
                  new CodexBridgeError(
                    `Codex bridge socket changed while connecting: ${socketPath}`,
                    "socket-changed"
                  )
                )
                return
              }
              ready = true
              write(socket)
            }).pipe(Effect.catch((cause) => Effect.sync(() => finish(cause))))
          )
        },
        drain: write,
        data(_socket, chunk) {
          if (settled) return
          bytes += chunk.byteLength
          if (bytes > MAX_RESPONSE_BYTES) {
            finish(
              new CodexBridgeError(
                `Codex bridge response exceeds ${MAX_RESPONSE_BYTES} bytes`,
                "response-too-large"
              )
            )
            return
          }
          body += decoder.decode(chunk, { stream: true })
        },
        end() {
          finish()
        },
        close(_socket, cause) {
          finish(cause)
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
      duration: options.timeoutMs,
      orElse: () =>
        Effect.fail(
          new CodexBridgeError(
            `Codex bridge timed out after ${options.timeoutMs / 1000} seconds; delivery outcome is unknown`,
            "request-timeout"
          )
        )
    })
  )

  yield* Effect.try({
    try: () => validateResponse(response, id, options.targetThreadId),
    catch: bridgeError
  })
}, Effect.scoped)

function validateResponse(response: string, id: string, targetThreadId: string): void {
  let decoded: unknown
  try {
    decoded = JSON.parse(response.trim())
  } catch (cause) {
    throw new CodexBridgeError(
      `Codex bridge returned invalid JSON: ${errorMessage(cause)}`,
      "invalid-response",
      cause instanceof Error ? { cause } : undefined
    )
  }
  let result: Schema.Schema.Type<typeof BridgeResponseSchema>
  try {
    result = Schema.decodeUnknownSync(BridgeResponseSchema)(decoded)
  } catch (cause) {
    throw new CodexBridgeError(
      `Codex bridge returned an invalid response: ${errorMessage(cause)}`,
      "invalid-response",
      cause instanceof Error ? { cause } : undefined
    )
  }
  if (result.status === "error") {
    throw new CodexBridgeError(result.error, "bridge-error")
  }
  if (result.id !== id || result.targetThreadId !== targetThreadId) {
    throw new CodexBridgeError(
      `Codex bridge acknowledged the wrong request: ${response.trim()}`,
      "response-mismatch"
    )
  }
}

const validatePrivateSocket = Effect.fn("validatePrivateSocket")(function* (path: string) {
  const stat = yield* Effect.tryPromise({
    try: () => lstat(path),
    catch: (cause) =>
      new CodexBridgeError(
        cause instanceof Error && "code" in cause && cause["code"] === "ENOENT"
          ? `no Codex bridge socket at ${path}`
          : `cannot inspect Codex bridge socket at ${path}: ${errorMessage(cause)}`,
        "bridge-unavailable",
        cause instanceof Error ? { cause } : undefined
      )
  })
  if (!stat.isSocket()) {
    return yield* Effect.fail(
      new CodexBridgeError(`Codex bridge path is not a socket: ${path}`, "not-socket")
    )
  }
  if ((stat.mode & 0o077) !== 0) {
    return yield* Effect.fail(
      new CodexBridgeError(
        `Codex bridge socket permissions are not private: ${path}`,
        "insecure-socket"
      )
    )
  }
  const currentUid = process.getuid?.()
  if (currentUid !== undefined && stat.uid !== currentUid) {
    return yield* Effect.fail(
      new CodexBridgeError(
        `Codex bridge socket is owned by uid ${stat.uid}, not ${currentUid}`,
        "wrong-owner"
      )
    )
  }
  return { dev: stat.dev, ino: stat.ino }
})

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function bridgeError(cause: unknown): CodexBridgeError {
  return cause instanceof CodexBridgeError
    ? cause
    : new CodexBridgeError(errorMessage(cause), "connect-failed", { cause })
}
