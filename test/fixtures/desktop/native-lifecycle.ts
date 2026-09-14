import { spawn } from "node:child_process"
import { appendFileSync, writeFileSync } from "node:fs"
import { createInterface } from "node:readline"

import { Effect } from "effect"

import type { Request } from "./rpc.ts"
const path = process.env["FAKE_NATIVE_CALLS_PATH"]
if (path === undefined) throw new Error("FAKE_NATIVE_CALLS_PATH is required")
writeFileSync(path, `${process.pid}\n`)
const descendantPath = process.env["FIXTURE_DESCENDANT_PATH"]
if (descendantPath) {
  const descendant = spawn(process.execPath, [descendantPath], {
    stdio: ["ignore", "inherit", "ignore"]
  })
  writeFileSync(path + ".descendant", String(descendant.pid))
  descendant.unref()
}
if (process.env["FIXTURE_IGNORE_TERM"] === "1") {
  process.on("SIGTERM", () => appendFileSync(path, "SIGTERM\n"))
  Effect.runFork(Effect.forever(Effect.sleep(1000)))
}
createInterface({ input: process.stdin }).on("line", (line) => {
  const request: Request = JSON.parse(line)
  if (request.method === "initialize") {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          serverInfo: { name: "lifecycle", version: "1" }
        }
      }) + "\n"
    )
  } else if (request.method === "tools/call") {
    appendFileSync(path, "dispatched\n")
    if (process.env["FIXTURE_EXIT_ON_CALL"] === "1") process.exit(42)
  }
})
