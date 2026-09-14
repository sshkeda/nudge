import { Effect } from "effect"

import { runCli } from "../../support.ts"

const index = process.argv[2]
if (index === undefined) throw new Error("fixture session index is required")

const result = await Effect.runPromise(
  runCli(["list", "--json"], { NUDGE_CODEX_SESSION_INDEX: index })
)
console.log(JSON.stringify(result))
