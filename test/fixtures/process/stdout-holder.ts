import { Effect } from "effect"
Effect.runFork(
  Effect.andThen(
    Effect.sleep(1500),
    Effect.sync(() => {})
  )
)
