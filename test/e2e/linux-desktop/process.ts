import type { ReadableStreamDefaultReader } from "node:stream/web"

import { Cause, Deferred, Effect, Schema } from "effect"

const RpcFrameSchema = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  method: Schema.optional(Schema.String),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown)
})
type RpcFrame = Schema.Schema.Type<typeof RpcFrameSchema>

export const spawnScoped = <T extends Bun.Subprocess>(spawn: () => T) =>
  Effect.acquireRelease(Effect.sync(spawn), (process) =>
    Effect.gen(function* () {
      if (process.exitCode === null) process.kill("SIGTERM")
      yield* Effect.promise(() => process.exited).pipe(
        Effect.timeoutOrElse({
          duration: 1000,
          orElse: () =>
            Effect.gen(function* () {
              if (process.exitCode === null) process.kill("SIGKILL")
              return yield* Effect.promise(() => process.exited)
            })
        })
      )
    })
  )

export class StdioJsonRpc {
  #child: Bun.Subprocess<"pipe", "pipe", "pipe">
  #pending = new Map<string, Deferred.Deferred<RpcFrame, Error>>()
  #reader: ReadableStreamDefaultReader<Uint8Array>
  #failure: Error | undefined
  #notified: string[] = []
  #nextId = 0

  private constructor(child: Bun.Subprocess<"pipe", "pipe", "pipe">) {
    this.#child = child
    this.#reader = child.stdout.getReader()
  }

  static make(child: Bun.Subprocess<"pipe", "pipe", "pipe">) {
    return Effect.gen(function* () {
      const client = yield* Effect.acquireRelease(
        Effect.sync(() => new StdioJsonRpc(child)),
        (connection) => connection.#fail(new Error("RPC connection closed"))
      )
      yield* Effect.forkScoped(
        Effect.raceFirst(
          client.#read(),
          Effect.promise(() => child.exited).pipe(
            Effect.flatMap((code) =>
              client.#fail(new Error(`RPC process ${child.pid} exited with code ${code}`))
            )
          )
        ).pipe(Effect.catchCause((cause) => client.#fail(new Error(Cause.pretty(cause)))))
      )
      return client
    })
  }

  #fail(error: Error) {
    return Effect.gen({ self: this }, function* () {
      if (this.#failure) return
      this.#failure = error
      for (const pending of this.#pending.values()) yield* Deferred.fail(pending, error)
      this.#pending.clear()
      yield* Effect.tryPromise(() => this.#reader.cancel()).pipe(Effect.ignore)
    })
  }

  waitForNotification(method: string) {
    return Effect.gen({ self: this }, function* () {
      for (;;) {
        if (this.#failure) return yield* Effect.fail(this.#failure)
        if (this.#notified.includes(method)) return
        yield* Effect.sleep(250)
      }
    })
  }

  #read() {
    return Effect.gen({ self: this }, function* () {
      let buffer = ""
      const decoder = new TextDecoder()
      for (;;) {
        const chunk = yield* Effect.promise(() => this.#reader.read())
        if (chunk.done) {
          yield* this.#fail(new Error(`RPC process ${this.#child.pid} closed stdout`))
          return
        }
        buffer += decoder.decode(chunk.value, { stream: true })
        for (;;) {
          const newline = buffer.indexOf("\n")
          if (newline === -1) break
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          if (!line.trim()) continue
          const frame = Schema.decodeUnknownSync(RpcFrameSchema)(JSON.parse(line))
          const pending = frame.id === undefined ? undefined : this.#pending.get(String(frame.id))
          if (frame.id !== undefined && pending !== undefined) {
            this.#pending.delete(String(frame.id))
            yield* Deferred.succeed(pending, frame)
          } else if (frame.method !== undefined) this.#notified.push(frame.method)
        }
      }
    })
  }

  #write(frame: Schema.Json) {
    return Effect.gen({ self: this }, function* () {
      if (this.#failure) return yield* Effect.fail(this.#failure)
      yield* Effect.tryPromise(() =>
        Promise.resolve(this.#child.stdin.write(`${JSON.stringify(frame)}\n`))
      )
      yield* Effect.tryPromise(() => Promise.resolve(this.#child.stdin.flush()))
    }).pipe(
      Effect.catch((cause) => {
        const error = new Error(`RPC process ${this.#child.pid} stdin write failed`, { cause })
        return this.#fail(error).pipe(Effect.andThen(Effect.fail(error)))
      })
    )
  }

  call(method: string, params: Schema.Json) {
    return Effect.gen({ self: this }, function* () {
      if (this.#failure) return yield* Effect.fail(this.#failure)
      const id = ++this.#nextId
      const pending = yield* Deferred.make<RpcFrame, Error>()
      this.#pending.set(String(id), pending)
      return yield* Effect.gen({ self: this }, function* () {
        yield* this.#write({ jsonrpc: "2.0", id, method, params })
        return yield* Deferred.await(pending)
      }).pipe(Effect.ensuring(Effect.sync(() => this.#pending.delete(String(id)))))
    })
  }

  request<A>(method: string, params: Schema.Json, result: Schema.Codec<A, Schema.Json>) {
    return this.call(method, params).pipe(
      Effect.map((frame) => {
        if (frame.error !== undefined)
          throw new Error(`${method} failed: ${JSON.stringify(frame.error)}`)
        return Schema.decodeUnknownSync(result)(frame.result)
      })
    )
  }

  notify(method: string) {
    return this.#write({ jsonrpc: "2.0", method })
  }
}
