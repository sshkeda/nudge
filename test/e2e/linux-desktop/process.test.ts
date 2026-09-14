import { expect } from "bun:test"
import { join } from "node:path"

import { Effect, Fiber } from "effect"

import { testEffect } from "../../support.ts"
import { spawnScoped, StdioJsonRpc } from "./process"

testEffect(
  "the E2E scope stops a subprocess when its body fails",
  Effect.gen(function* () {
    let child: Bun.Subprocess | undefined
    const result = yield* Effect.exit(
      Effect.scoped(
        Effect.gen(function* () {
          child = yield* spawnScoped(() =>
            Bun.spawn([process.execPath, join(import.meta.dir, "../../fixtures/process/idle.ts")])
          )
          return yield* Effect.fail("test failure")
        })
      )
    )
    expect(result._tag).toBe("Failure")
    expect(child).toBeDefined()
    expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true)
  })
)

for (const [name, fixture] of [
  ["exit", "rpc-exit.ts"],
  ["invalid output", "rpc-invalid.ts"]
] as const) {
  testEffect(
    `the E2E RPC client rejects pending calls on ${name}`,
    Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const child = yield* spawnScoped(() =>
            Bun.spawn(
              [process.execPath, join(import.meta.dir, "../../fixtures/process", fixture)],
              {
                stdin: "pipe",
                stdout: "pipe",
                stderr: "pipe"
              }
            )
          )
          const rpc = yield* StdioJsonRpc.make(child)
          expect(yield* Effect.flip(rpc.call("initialize", {}))).toBeInstanceOf(Error)
          expect(yield* Effect.flip(rpc.call("again", {}))).toBeInstanceOf(Error)
        })
      )
    }),
    2000
  )
}

testEffect(
  "RPC requests fail when the process exits even if a descendant holds stdout open",
  Effect.gen(function* () {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawnScoped(() =>
          Bun.spawn(
            [process.execPath, join(import.meta.dir, "../../fixtures/process/rpc-descendant.ts")],
            {
              stdin: "pipe",
              stdout: "pipe",
              stderr: "pipe"
            }
          )
        )
        const rpc = yield* StdioJsonRpc.make(child)
        const request = yield* Effect.forkScoped(Effect.flip(rpc.call("initialize", {})))
        const descendant = Number(
          (yield* Effect.promise(() => Bun.readableStreamToText(child.stderr))).trim()
        )
        yield* Effect.gen(function* () {
          expect(yield* Effect.promise(() => child.exited)).toBe(7)
          const outcome = yield* Fiber.join(request).pipe(Effect.timeout(200))
          expect(outcome).toBeInstanceOf(Error)
          expect(String(outcome)).toContain("exited with code 7")
        }).pipe(
          Effect.ensuring(
            Effect.orDie(
              Effect.sync(() => {
                if (Number.isInteger(descendant) && descendant > 0) {
                  try {
                    process.kill(descendant, "SIGKILL")
                  } catch {}
                }
              })
            )
          )
        )
      })
    )
  })
)

testEffect(
  "an interrupted RPC call releases its connection and subprocess",
  Effect.gen(function* () {
    let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined
    const result = yield* Effect.exit(
      Effect.scoped(
        Effect.gen(function* () {
          child = yield* spawnScoped(() =>
            Bun.spawn(
              [process.execPath, join(import.meta.dir, "../../fixtures/process/rpc-silent.ts")],
              {
                stdin: "pipe",
                stdout: "pipe",
                stderr: "pipe"
              }
            )
          )
          const rpc = yield* StdioJsonRpc.make(child)
          yield* rpc.call("never-replies", {}).pipe(Effect.timeout(50))
        })
      )
    )
    expect(result._tag).toBe("Failure")
    expect(child).toBeDefined()
    expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true)
  }),
  2000
)

testEffect(
  "RPC write rejection fails the connection while its child is still alive",
  Effect.gen(function* () {
    const child = yield* spawnScoped(() =>
      Bun.spawn(
        [process.execPath, join(import.meta.dir, "../../fixtures/process/stdin-closed.ts")],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe" }
      )
    )
    // Keep stdout open so the write failure, rather than process exit or EOF,
    // must release this request and mark the RPC connection unusable.
    const rpc = yield* StdioJsonRpc.make(child)
    yield* rpc.waitForNotification("ready")
    const error = yield* Effect.flip(rpc.call("large-request", { body: "x".repeat(1_000_000) }))
    expect(error.message).toContain("stdin write failed")
    expect(child.exitCode).toBeNull()
    expect(yield* Effect.flip(rpc.call("again", {}))).toBe(error)
    expect(yield* Effect.flip(rpc.notify("notification"))).toBeInstanceOf(Error)
  }),
  2000
)
