import { Effect } from "effect"
Effect.runFork(Effect.forever(Effect.sleep(1000)))
