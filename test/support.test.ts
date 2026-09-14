import { expect } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"

import { environment, spawnScoped, temporaryDirectory, testEffect } from "./support.ts"

testEffect(
  "Effect tests report failures and finish cleanup before the next test",
  Effect.gen(function* () {
    const child = yield* spawnScoped(() =>
      Bun.spawn(
        [
          process.execPath,
          "test",
          "--concurrent",
          join(import.meta.dir, "fixtures/process/test-effect.ts")
        ],
        { env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe" }
      )
    )
    const [code, stdout, stderr] = yield* Effect.all(
      [
        Effect.promise(() => child.exited),
        Effect.tryPromise(() => Bun.readableStreamToText(child.stdout)),
        Effect.tryPromise(() => Bun.readableStreamToText(child.stderr))
      ],
      { concurrency: "unbounded" }
    )
    const output = stdout + stderr
    expect(code).toBe(1)
    expect(output).toContain("2 pass")
    expect(output).toContain("2 fail")
    expect(output).toContain("(fail) deliberate timeout with slow cleanup")
    expect(output).toContain("(fail) deliberate assertion failure")
    expect(output).not.toContain("Unhandled error")
  })
)

testEffect(
  "CLI fixtures ignore an inherited production database override",
  Effect.gen(function* () {
    const directory = yield* temporaryDirectory(join(tmpdir(), "nudge-test-environment-"))
    const index = join(directory, "session_index.jsonl")
    const sentinel = join(directory, "production-sentinel.sqlite")
    yield* Effect.tryPromise(() => Bun.write(sentinel, "must remain untouched"))
    yield* Effect.tryPromise(() =>
      Bun.write(index, JSON.stringify({ id: "fixture-session", thread_name: "Fixture session" }))
    )
    const child = yield* spawnScoped(() =>
      Bun.spawn(
        [process.execPath, join(import.meta.dir, "fixtures/process/isolated-cli.ts"), index],
        {
          cwd: join(import.meta.dir, ".."),
          env: { ...environment, NUDGE_CODEX_STATE_DB: sentinel },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe"
        }
      )
    )
    const [code, stdout, stderr] = yield* Effect.all(
      [
        Effect.promise(() => child.exited),
        Effect.tryPromise(() => Bun.readableStreamToText(child.stdout)),
        Effect.tryPromise(() => Bun.readableStreamToText(child.stderr))
      ],
      { concurrency: "unbounded" }
    )
    expect(code).toBe(0)
    expect(stderr).toBe("")
    const result = JSON.parse(stdout)
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    const listed = JSON.parse(result.stdout)
    expect(listed.warnings).toBeUndefined()
    expect(listed.targets).toHaveLength(1)
    expect(listed.targets[0]).toMatchObject({ id: "fixture-session", name: "Fixture session" })
    expect(yield* Effect.tryPromise(() => Bun.file(sentinel).text())).toBe("must remain untouched")
  })
)
