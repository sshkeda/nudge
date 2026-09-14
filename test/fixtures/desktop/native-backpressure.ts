import { existsSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { createInterface } from "node:readline"

import { Effect, Stream } from "effect"

const directory = process.env["FIXTURE_DIRECTORY"]!
const count = 2048
const data = "x".repeat(8192)

await Effect.runPromise(
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => writeFile(`${directory}/ready`, "ready"))
    if (process.env["FIXTURE_DIRECTION"] === "input") {
      while (!existsSync(`${directory}/release`)) yield* Effect.sleep(10)
      const input = yield* Effect.acquireRelease(
        Effect.sync(() => createInterface({ input: process.stdin })),
        (reader) => Effect.sync(() => reader.close())
      )
      let received = 0
      yield* Stream.fromAsyncIterable(input, (cause) => cause).pipe(
        Stream.take(count),
        Stream.runForEach((line) =>
          Effect.sync(() => {
            const message: { id: number; data: string } = JSON.parse(line)
            if (message.id !== received++ || message.data !== data)
              throw new Error("input frame corrupted")
          })
        )
      )
      if (received !== count) throw new Error("input ended before all frames arrived")
    } else {
      for (let id = 0; id < count; id++) {
        yield* Effect.callback<void, Error>((resume) => {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, data }) + "\n", (error) =>
            resume(error ? Effect.fail(error) : Effect.void)
          )
        })
      }
    }
    yield* Effect.tryPromise(() => writeFile(`${directory}/done`, "done"))
    yield* Effect.forever(Effect.sleep(1000))
  }).pipe(Effect.scoped)
)
