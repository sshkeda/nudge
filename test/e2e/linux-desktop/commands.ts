import { Effect, Fiber, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"

export const command = (
  args: readonly [string, ...string[]],
  options: ChildProcess.CommandOptions = {}
) =>
  ChildProcess.make(args[0], args.slice(1), {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    forceKillAfter: 1000,
    ...options
  })

export const runCommand = Effect.fn("runCommand")(function* (spec: ChildProcess.Command) {
  const child = yield* spec
  const [code, stdout, stderr] = yield* Effect.all(
    [
      child.exitCode,
      Stream.mkString(Stream.decodeText(child.stdout)),
      Stream.mkString(Stream.decodeText(child.stderr))
    ],
    { concurrency: "unbounded" }
  )
  if (code !== 0)
    return yield* Effect.fail(new Error(`command exited with code ${code}: ${stderr || stdout}`))
  return stdout
}, Effect.scoped)

export const spawnLogged = Effect.fn("spawnLogged")(function* (
  spec: ChildProcess.Command,
  path: string
) {
  const writer = yield* Effect.acquireRelease(
    Effect.sync(() => Bun.file(path).writer()),
    (sink) => Effect.promise(() => Promise.resolve(sink.end()))
  )
  const child = yield* spec
  const drains = yield* Effect.forEach([child.stdout, child.stderr], (stream) =>
    Stream.runForEach(stream, (chunk) =>
      Effect.tryPromise(() => Promise.resolve(writer.write(chunk)))
    ).pipe(Effect.forkScoped)
  )
  const completed = Effect.gen(function* () {
    const [code] = yield* Effect.all([child.exitCode, Effect.forEach(drains, Fiber.join)], {
      concurrency: "unbounded"
    })
    yield* Effect.tryPromise(() => Promise.resolve(writer.flush()))
    if (code !== 0)
      return yield* Effect.fail(new Error(`command exited with code ${code}; see ${path}`))
  })
  return { child, completed }
})

export function waitUntil<A, E, R>(
  label: string,
  probe: Effect.Effect<A | null, E, R>,
  timeoutMs: number
) {
  return Effect.gen(function* () {
    for (;;) {
      const value = yield* probe
      if (value !== null) return value
      yield* Effect.sleep(200)
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () => Effect.fail(new Error(`timed out waiting for ${label}`))
    })
  )
}
