import { promises as fs } from "node:fs"
import { syncBuiltinESMExports } from "node:module"

import { Effect } from "effect"

const socketPath = process.env["NUDGE_CODEX_BRIDGE_SOCKET"]
const gatePath = process.env["FIXTURE_PUBLICATION_GATE"]
if (socketPath === undefined || gatePath === undefined) throw new Error("fixture paths required")

// Gate public endpoint mutation after stale validation, for both unlink/bind and rename.
let paused = false
const pause = Effect.fn("pausePublication")(function* () {
  if (paused) return
  paused = true
  yield* Effect.tryPromise(() => fs.writeFile(gatePath + ".ready", "ready"))
  while (
    !(yield* Effect.tryPromise(() => fs.stat(gatePath + ".release")).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false))
    ))
  )
    yield* Effect.sleep(10)
})
const unlink = fs.unlink
fs.unlink = (path) =>
  Effect.runPromise(
    Effect.gen(function* () {
      if (path === socketPath) yield* pause()
      yield* Effect.tryPromise({ try: () => unlink(path), catch: (cause) => cause })
    })
  )
const rename = fs.rename
fs.rename = (source, destination) =>
  Effect.runPromise(
    Effect.gen(function* () {
      if (destination === socketPath) yield* pause()
      yield* Effect.tryPromise({ try: () => rename(source, destination), catch: (cause) => cause })
    })
  )
syncBuiltinESMExports()
