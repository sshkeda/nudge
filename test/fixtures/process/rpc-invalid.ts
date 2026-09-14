import { Effect } from "effect"
process.stdin.once("data", () => {
  console.log("not json")
  Effect.runFork(Effect.forever(Effect.sleep(1000)))
})
