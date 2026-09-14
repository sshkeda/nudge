import { Effect } from "effect"
process.stdin.resume()
Effect.runFork(Effect.forever(Effect.sleep(1000)))
