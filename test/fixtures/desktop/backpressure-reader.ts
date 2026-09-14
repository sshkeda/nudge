import { spawn } from "node:child_process"
import { existsSync } from "node:fs"

import { Effect } from "effect"

await Effect.runPromise(
  Effect.gen(function* () {
    const child = yield* Effect.acquireRelease(
      Effect.sync(() =>
        spawn(process.execPath, [process.env["FIXTURE_HELPER_PATH"]!], {
          stdio: ["inherit", "pipe", "inherit"]
        })
      ),
      (processChild) =>
        Effect.sync(() => {
          if (processChild.exitCode === null && processChild.signalCode === null)
            processChild.kill("SIGKILL")
          processChild.stdout.destroy()
        })
    )
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        while (!existsSync(`${process.env["FIXTURE_DIRECTORY"]}/release`)) yield* Effect.sleep(10)
        child.stdout.pipe(process.stdout)
      })
    )
    yield* Effect.callback<void, Error>((resume) => {
      const stop = () => child.kill("SIGTERM")
      const exit = (code: number | null) => {
        process.exitCode = code ?? 1
        resume(Effect.void)
      }
      const error = (cause: Error) => resume(Effect.fail(cause))
      process.on("SIGTERM", stop)
      child.once("exit", exit)
      child.once("error", error)
      return Effect.sync(() => {
        process.off("SIGTERM", stop)
        child.off("exit", exit)
        child.off("error", error)
      })
    })
  }).pipe(Effect.scoped)
)
