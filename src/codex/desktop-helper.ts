/*!
Licenses for Nudge and the JavaScript dependencies bundled in Nudge's Codex Desktop helper.

Nudge:
Copyright (c) 2026 Stephen Shkeda

effect, @effect/platform-bun, @effect/platform-node-shared:
Copyright (c) 2023 Effectful Technologies Inc

Node.js-derived path code in Effect:
Copyright Node.js contributors. All rights reserved.
Copyright Joyent, Inc. and other Node contributors. All rights reserved.

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

/* oxlint-disable anti-slop/no-runtime-typeof -- This Node transport shim validates untyped JSON at its MCP and socket boundaries. */

import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { realpathSync, type Stats } from "node:fs"
import { chmod, link, lstat, mkdir, mkdtemp, rename, rm, unlink } from "node:fs/promises"
import * as Module from "node:module"
import { createConnection, createServer, type Socket } from "node:net"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { createInterface, type Interface } from "node:readline"
import type { Writable } from "node:stream"
import { pathToFileURL } from "node:url"
import { isMainThread } from "node:worker_threads"

import { Cause, Deferred, Effect, Exit, FiberSet, Queue, type Schema } from "effect"

type BridgeRequest = {
  version: number
  id: string
  targetThreadId: string
  prompt: string
  sourceThreadId?: string
}
type Delivery = {
  request: BridgeRequest
  result: Deferred.Deferred<void, Error>
  signal: AbortSignal
}

const resourcesPath =
  process.env["CODEX_ELECTRON_RESOURCES_PATH"] ??
  (process.execPath.endsWith("/cua_node/bin/node")
    ? dirname(dirname(dirname(process.execPath)))
    : "/Applications/ChatGPT.app/Contents/Resources")
const nativeServerPath =
  process.env["NUDGE_CODEX_APP_TOOLS_SERVER"] ??
  join(resourcesPath, "plugins/openai-bundled/plugins/codex-app-tools/server.mjs")

let nativeServerUrl: string | undefined
let nativeServerFailure = ""
try {
  nativeServerUrl = pathToFileURL(realpathSync(nativeServerPath)).href
} catch (cause) {
  nativeServerFailure = cause instanceof Error ? cause.message : String(cause)
}
const bridgeUrl = new URL("?bridge", import.meta.url).href

export { resolveAsynchronously as resolve }

const resolveAsynchronously: Module.ResolveHook = (specifier, context, nextResolve) => {
  return Effect.runPromise(
    Effect.tryPromise({
      try: () => Promise.resolve(nextResolve(specifier, context)),
      catch: (cause) => cause
    }).pipe(Effect.map(redirectNativeServer))
  )
}

const resolveSynchronously: Module.ResolveHookSync = (specifier, context, nextResolve) => {
  return redirectNativeServer(nextResolve(specifier, context))
}

function redirectNativeServer(resolved: Module.ResolveFnOutput) {
  return nativeServerUrl !== undefined && resolved.url === nativeServerUrl
    ? { url: bridgeUrl, shortCircuit: true }
    : resolved
}

const runBridge = Effect.fn("runBridge")(function () {
  const MAX_REQUEST_BYTES = 64 * 1024
  const READY_TIMEOUT_MS = 10_000
  const SOCKET_TIMEOUT_MS = 180_000
  const BRIDGE_VERSION = 1
  const bridgeSocketPath =
    process.env["NUDGE_CODEX_BRIDGE_SOCKET"] ??
    join(
      process.env["NUDGE_STATE_DIR"] ?? join(homedir(), ".local", "state", "nudge"),
      "codex",
      "desktop-bridge.sock"
    )

  const program = Effect.gen(function* () {
    const shutdown = yield* Deferred.make<number, Error>()
    const ready = yield* Deferred.make<void, Error>()
    const childClosed = yield* Deferred.make<void>()
    let expectedChildExit = false
    const child = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const processChild = spawn(process.execPath, [nativeServerPath, ...process.argv.slice(2)], {
          env: { ...process.env, CODEX_NUDGE_BRIDGE_CHILD: "1" },
          stdio: ["pipe", "pipe", "inherit"]
        })
        processChild.once("error", (error) => {
          Deferred.doneUnsafe(childClosed, Effect.void)
          Deferred.doneUnsafe(shutdown, Effect.fail(error))
        })
        processChild.once("exit", (code, signal) => {
          Deferred.doneUnsafe(childClosed, Effect.void)
          Deferred.doneUnsafe(
            shutdown,
            expectedChildExit && code === 0
              ? Effect.succeed(0)
              : Effect.fail(
                  new Error(
                    signal === null
                      ? `Codex app-tools server exited with code ${String(code)}`
                      : `Codex app-tools server exited from signal ${signal}`
                  )
                )
          )
        })
        return processChild
      }),
      (processChild) =>
        Effect.gen(function* () {
          expectedChildExit = true
          if (processChild.exitCode !== null || processChild.signalCode !== null) return
          processChild.kill("SIGTERM")
          yield* Deferred.await(childClosed).pipe(
            Effect.timeoutOrElse({
              duration: 1000,
              orElse: () =>
                Effect.gen(function* () {
                  processChild.kill("SIGKILL")
                  yield* Deferred.await(childClosed)
                })
            })
          )
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              processChild.stdin.destroy()
              processChild.stdout.destroy()
            })
          )
        )
    )
    const deliveries = yield* Effect.acquireRelease(Queue.bounded<Delivery>(64), Queue.shutdown)
    const requests = new Map<string, Deferred.Deferred<void, Error>>()
    const requestPrefix = `nudge:${randomUUID()}:`
    const initializationIds = new Set<string>()
    const runRequest = yield* FiberSet.makeRuntime()

    const input = createInterface({ input: process.stdin })
    const output = createInterface({ input: child.stdout })
    const fail = (error: Error) => {
      Deferred.doneUnsafe(shutdown, Effect.fail(error))
    }
    const stop = (code: number) => {
      Deferred.doneUnsafe(shutdown, Effect.succeed(code))
    }
    const end = () => {
      expectedChildExit = true
      child.stdin.end()
    }
    const resumeInput = () => input.resume()
    const resumeOutput = () => output.resume()
    child.stdin.on("drain", resumeInput)
    process.stdout.on("drain", resumeOutput)
    process.stdout.on("error", fail)
    const sigint = () => stop(130)
    const sigterm = () => stop(143)
    child.stdin.on("error", fail)
    child.stdout.on("error", fail)
    process.stdin.on("end", end)
    process.on("SIGINT", sigint)
    process.on("SIGTERM", sigterm)
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        child.stdin.off("drain", resumeInput)
        process.stdout.off("drain", resumeOutput)
        process.stdout.off("error", fail)
        input.close()
        output.close()
        process.stdin.pause()
        process.stdin.off("end", end)
        process.off("SIGINT", sigint)
        process.off("SIGTERM", sigterm)
      })
    )

    input.on("line", (line) => {
      if (!line.trim()) return
      try {
        const message: Schema.Json = JSON.parse(line)
        const fields = record(message)
        const id = fields?.["id"]
        if (fields?.["method"] === "initialize" && id !== null && id !== undefined)
          initializationIds.add(String(id))
        writeLine(child.stdin, message, input)
      } catch (error) {
        fail(new Error(`Codex sent invalid MCP JSON: ${errorMessage(error)}`))
      }
    })
    output.on("line", (line) => {
      if (!line.trim()) return
      try {
        const message: Schema.Json = JSON.parse(line)
        const fields = record(message)
        const id = fields?.["id"]
        const responseId = id === null || id === undefined ? null : String(id)
        const error = fields?.["error"]
        const failed = error !== null && error !== undefined
        if (responseId !== null && initializationIds.delete(responseId)) {
          Deferred.doneUnsafe(
            ready,
            failed ? Effect.fail(new Error(mcpFailure(message))) : Effect.void
          )
        }
        const request = responseId === null ? undefined : requests.get(responseId)
        if (request !== undefined) {
          Deferred.doneUnsafe(
            request,
            failed || record(fields?.["result"])?.["isError"] === true
              ? Effect.fail(new Error(mcpFailure(message)))
              : Effect.void
          )
        } else if (responseId === null || !responseId.startsWith(requestPrefix)) {
          writeLine(process.stdout, message, output)
        }
      } catch (error) {
        fail(new Error(`Codex app-tools server returned invalid MCP JSON: ${errorMessage(error)}`))
      }
    })

    const deliver = (delivery: Delivery) =>
      Effect.gen(function* () {
        if (delivery.signal.aborted) return yield* Effect.fail(new Error("client disconnected"))
        yield* Deferred.await(ready).pipe(
          Effect.timeoutOrElse({
            duration: READY_TIMEOUT_MS,
            orElse: () =>
              Effect.fail(
                new Error(
                  `Codex app-tools server did not finish MCP initialization within ${READY_TIMEOUT_MS / 1000} seconds`
                )
              )
          })
        )
        if (delivery.signal.aborted) return yield* Effect.fail(new Error("client disconnected"))
        const request = delivery.request
        const internalId = `${requestPrefix}${randomUUID()}`
        const confirmed = yield* Deferred.make<void, Error>()
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            requests.set(internalId, confirmed)
            return internalId
          }),
          (id) =>
            Effect.sync(() => {
              requests.delete(id)
            })
        )
        const written = writeLine(
          child.stdin,
          {
            jsonrpc: "2.0",
            id: internalId,
            method: "tools/call",
            params: {
              name: "send_message_to_thread",
              arguments: { threadId: request.targetThreadId, prompt: request.prompt },
              _meta: {
                "openai/threadId": request.sourceThreadId ?? request.targetThreadId,
                "openai/toolCallId": `nudge-${request.id}`,
                "openai/turnId": `nudge-${request.id}`
              }
            }
          },
          input
        )
        if (!written) yield* drained(child.stdin)
        yield* Deferred.await(confirmed).pipe(
          Effect.timeoutOrElse({
            duration: SOCKET_TIMEOUT_MS,
            orElse: () =>
              Effect.fail(
                new Error(
                  `Codex did not confirm sending within ${SOCKET_TIMEOUT_MS / 1000} seconds; delivery outcome is unknown`
                )
              )
          })
        )
      })

    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const delivery = yield* Queue.take(deliveries)
          const result = yield* Effect.scoped(deliver(delivery)).pipe(
            Effect.raceFirst(
              aborted(delivery.signal).pipe(
                Effect.andThen(Effect.fail(new Error("client disconnected")))
              )
            ),
            Effect.exit
          )
          yield* Deferred.done(delivery.result, result)
        })
      ).pipe(Effect.catchCause((cause) => Deferred.failCause(shutdown, cause)))
    )

    function accept(socket: Socket) {
      const controller = new AbortController()
      const closed = () => controller.abort()
      socket.once("close", closed)
      const task = Effect.gen(function* () {
        const request = yield* readRequest(socket)
        const result = yield* Deferred.make<void, Error>()
        yield* Queue.offer(deliveries, { request, result, signal: controller.signal })
        yield* Deferred.await(result)
        return {
          version: BRIDGE_VERSION,
          id: request.id,
          status: "delivered",
          targetThreadId: request.targetThreadId
        }
      }).pipe(
        Effect.timeoutOrElse({
          duration: SOCKET_TIMEOUT_MS,
          orElse: () =>
            Effect.fail(
              new Error(
                `Codex bridge request timed out after ${SOCKET_TIMEOUT_MS / 1000} seconds; delivery outcome is unknown`
              )
            )
        }),
        Effect.catch((error) =>
          Effect.succeed({ version: BRIDGE_VERSION, status: "error", error: errorMessage(error) })
        ),
        Effect.tap((response) =>
          Effect.sync(() => {
            if (!socket.destroyed) socket.end(JSON.stringify(response) + "\n")
          })
        ),
        Effect.ensuring(
          Effect.sync(() => {
            controller.abort()
            socket.off("close", closed)
          })
        )
      )
      const fiber = runRequest(task)
      socket.once("close", () => fiber.interruptUnsafe())
    }

    if (process.env["CODEX_APP_TOOLS_PIPE_PATH"]?.trim()) {
      let warned = ""
      const unavailable = (error: Error) =>
        Effect.sync(() => {
          const warning = `warning: Codex bridge unavailable: ${errorMessage(error)}\n`
          if (warning === warned) return
          warned = warning
          process.stderr.write(warning)
        })
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          for (;;) {
            yield* Effect.scoped(
              Effect.gen(function* () {
                const { owned, socketPath } = yield* startServer(accept, fail)
                warned = ""
                for (;;) {
                  yield* publishSocket(socketPath, owned).pipe(Effect.catch(unavailable))
                  yield* Effect.sleep(250)
                }
              })
            ).pipe(Effect.catch(unavailable))
            yield* Effect.sleep(250)
          }
        }).pipe(Effect.catchCause((cause) => Deferred.failCause(shutdown, cause)))
      )
    }
    return yield* Deferred.await(shutdown)
  })

  return Effect.scoped(program).pipe(
    Effect.exit,
    Effect.map((exit) => {
      if (Exit.isFailure(exit)) {
        process.stderr.write(`error: ${errorMessage(Cause.squash(exit.cause))}\n`)
        process.exitCode = 1
      } else process.exitCode = exit.value
    })
  )

  function writeLine(stream: Writable, value: Schema.Json, source: Interface): boolean {
    const written = stream.write(JSON.stringify(value) + "\n")
    if (!written) source.pause()
    return written
  }

  function drained(stream: Writable): Effect.Effect<void, Error> {
    return Effect.callback((resume) => {
      if (!stream.writableNeedDrain) return resume(Effect.void)
      const drain = () => resume(Effect.void)
      const error = (cause: Error) => resume(Effect.fail(cause))
      stream.once("drain", drain)
      stream.once("error", error)
      return Effect.sync(() => {
        stream.off("drain", drain)
        stream.off("error", error)
      })
    })
  }

  function aborted(signal: AbortSignal): Effect.Effect<void> {
    return Effect.callback((resume) => {
      const stop = () => {
        signal.removeEventListener("abort", stop)
        resume(Effect.void)
      }
      if (signal.aborted) stop()
      else signal.addEventListener("abort", stop, { once: true })
      return Effect.sync(() => signal.removeEventListener("abort", stop))
    })
  }

  function readRequest(socket: Socket): Effect.Effect<BridgeRequest, Error> {
    return Effect.callback((resume) => {
      const complete = (result: Effect.Effect<BridgeRequest, Error>) => {
        socket.off("data", data)
        socket.off("error", error)
        resume(result)
      }
      let body = ""
      socket.setEncoding("utf8")
      const data = (chunk: string) => {
        body += chunk
        if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
          complete(
            Effect.fail(new Error(`Codex bridge request exceeds ${MAX_REQUEST_BYTES} bytes`))
          )
          return
        }
        const newline = body.indexOf("\n")
        if (newline === -1) return
        let value: Schema.Json
        try {
          value = JSON.parse(body.slice(0, newline))
        } catch (error) {
          complete(
            Effect.fail(new Error(`Codex bridge request is not valid JSON: ${errorMessage(error)}`))
          )
          return
        }
        complete(Effect.try({ try: () => parseBridgeRequest(value), catch: toError }))
      }
      const error = (cause: Error) => complete(Effect.fail(cause))
      socket.on("data", data)
      socket.on("error", error)
      return Effect.sync(() => {
        socket.off("data", data)
        socket.off("error", error)
      })
    })
  }

  function startServer(accept: (socket: Socket) => void, fail: (error: Error) => void) {
    return Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => mkdir(dirname(bridgeSocketPath), { recursive: true, mode: 0o700 }),
        catch: toError
      })
      const directory = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => mkdtemp(join(dirname(bridgeSocketPath), ".b-")),
          catch: toError
        }),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true }))
      )
      const socketPath = join(directory, "s")
      const sockets = new Set<Socket>()
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          createServer((socket) => {
            sockets.add(socket)
            socket.on("error", () => {})
            socket.once("close", () => sockets.delete(socket))
            accept(socket)
          })
        ),
        (listener) =>
          Effect.gen(function* () {
            yield* Effect.callback((resume) => {
              listener.close(() => resume(Effect.void))
              for (const socket of sockets)
                if (!socket.writableEnded && !socket.destroyed)
                  socket.end(
                    JSON.stringify({
                      version: BRIDGE_VERSION,
                      status: "error",
                      error: "Codex bridge is shutting down"
                    }) + "\n"
                  )
            }).pipe(
              Effect.timeoutOrElse({
                duration: 1000,
                orElse: () =>
                  Effect.sync(() => {
                    for (const socket of sockets) socket.destroy()
                  })
              })
            )
          })
      )
      yield* Effect.callback<void, Error>((resume) => {
        const error = (cause: Error) => resume(Effect.fail(cause))
        server.once("error", error)
        const mask = process.umask(0o077)
        try {
          server.listen(socketPath, () => {
            server.off("error", error)
            server.on("error", fail)
            resume(Effect.void)
          })
        } finally {
          process.umask(mask)
        }
        return Effect.sync(() => server.off("error", error))
      })
      yield* Effect.tryPromise({ try: () => chmod(socketPath, 0o600), catch: toError })
      const owned = yield* Effect.tryPromise({ try: () => lstat(socketPath), catch: toError })
      return { owned, socketPath }
    })
  }

  function publishSocket(socketPath: string, owned: Stats) {
    return Effect.gen(function* () {
      if (!(yield* prepareSocketPath(bridgeSocketPath, owned))) return
      const pending = join(dirname(socketPath), "p")
      yield* Effect.acquireRelease(
        Effect.tryPromise({ try: () => link(socketPath, pending), catch: toError }),
        () =>
          Effect.tryPromise({ try: () => unlink(pending), catch: toError }).pipe(
            Effect.catch((error) =>
              errorCode(error) === "ENOENT" ? Effect.void : Effect.die(error)
            )
          )
      )
      yield* Effect.tryPromise({ try: () => rename(pending, bridgeSocketPath), catch: toError })
    }).pipe(Effect.scoped)
  }

  function prepareSocketPath(path: string, owned: Stats) {
    return Effect.gen(function* () {
      const stat = yield* Effect.tryPromise({ try: () => lstat(path), catch: toError }).pipe(
        Effect.catch((error) =>
          errorCode(error) === "ENOENT" ? Effect.succeed(null) : Effect.fail(error)
        )
      )
      if (stat === null) return true
      if (stat.dev === owned.dev && stat.ino === owned.ino) return false
      if (!stat.isSocket())
        return yield* Effect.fail(
          new Error(`Codex bridge path exists and is not a socket: ${path}`)
        )
      const probe = Effect.callback<boolean, Error>((resume) => {
        const socket = createConnection(path)
        socket.once("connect", () => {
          socket.destroy()
          resume(Effect.succeed(true))
        })
        socket.once("error", (cause) => {
          socket.destroy()
          resume(errorCode(cause) === "ECONNREFUSED" ? Effect.succeed(false) : Effect.fail(cause))
        })
        return Effect.sync(() => socket.destroy())
      })
      if (
        yield* probe.pipe(
          Effect.timeoutOrElse({ duration: 200, orElse: () => Effect.succeed(true) })
        )
      )
        return false
      const current = yield* Effect.tryPromise({ try: () => lstat(path), catch: toError }).pipe(
        Effect.catch((error) =>
          errorCode(error) === "ENOENT" ? Effect.succeed(null) : Effect.fail(error)
        )
      )
      if (current === null) return true
      if (current.dev !== stat.dev || current.ino !== stat.ino) return false
      return true
    })
  }
  function parseBridgeRequest(value: Schema.Json): BridgeRequest {
    const fields = record(value)
    if (fields === null) throw new Error("Codex bridge request must be an object")
    if (fields["version"] !== BRIDGE_VERSION) {
      throw new Error(`Codex bridge requires version ${BRIDGE_VERSION}`)
    }
    const required = (name: string) => {
      const field = fields[name]
      if (typeof field !== "string" || !field.trim()) {
        throw new Error(`Codex bridge request requires a nonempty ${name}`)
      }
      return field
    }
    const request = {
      version: BRIDGE_VERSION,
      id: required("id"),
      targetThreadId: required("targetThreadId"),
      prompt: required("prompt")
    }
    const sourceThreadId = fields["sourceThreadId"]
    if (sourceThreadId === undefined) return request
    if (typeof sourceThreadId !== "string" || !sourceThreadId.trim()) {
      throw new Error("Codex bridge sourceThreadId must be a nonempty string when supplied")
    }
    return { ...request, sourceThreadId }
  }

  function mcpFailure(message: Schema.Json) {
    const error = record(message)?.["error"]
    if (error !== null && error !== undefined) {
      const fields = record(error)
      const code =
        fields?.["code"] === null || fields?.["code"] === undefined
          ? "MCP error"
          : `MCP error ${fields["code"]}`
      return `${code}: ${fields?.["message"] ?? JSON.stringify(error)}`
    }
    const content = record(record(message)?.["result"])?.["content"]
    const texts = Array.isArray(content)
      ? content.flatMap((item) => {
          const fields = record(item)
          return fields?.["type"] === "text" && typeof fields["text"] === "string"
            ? [fields["text"]]
            : []
        })
      : []
    return texts.join("\n") || "Codex could not send the message: no error details"
  }

  function errorMessage(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause)
  }
  function toError(cause: unknown): Error {
    return cause instanceof Error ? cause : new Error(String(cause))
  }
})

function record(value: Schema.Json | undefined): Record<string, Schema.Json> | null {
  return isRecord(value) ? value : null
}

function errorCode(cause: unknown): string | undefined {
  return cause instanceof Error && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined
}

function isRecord(value: Schema.Json | undefined): value is Record<string, Schema.Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

if (isMainThread && process.env["CODEX_NUDGE_BRIDGE_CHILD"] !== "1") {
  if (
    import.meta.url === bridgeUrl ||
    (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url)
  ) {
    await Effect.runPromise(runBridge())
  } else if (nativeServerUrl === undefined) {
    process.stderr.write(
      `Nudge helper: cannot resolve Codex Desktop's App Tools server at ${nativeServerPath}: ${nativeServerFailure}\n`
    )
  } else if (typeof Module.registerHooks === "function") {
    Module.registerHooks({ resolve: resolveSynchronously })
  } else {
    Module.register(import.meta.url)
  }
}
