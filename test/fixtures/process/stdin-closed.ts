import { closeSync } from "node:fs"

import { Effect } from "effect"

closeSync(0)
process.stdout.write(JSON.stringify({ method: "ready" }) + "\n")
Effect.runFork(Effect.forever(Effect.sleep(1000)))
