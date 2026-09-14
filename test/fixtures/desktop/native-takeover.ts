import { appendFileSync } from "node:fs"
import { createInterface } from "node:readline"

import type { Schema } from "effect"

import type { Request } from "./rpc.ts"
const callsPath = process.env["FAKE_NATIVE_CALLS_PATH"]
if (callsPath === undefined) throw new Error("FAKE_NATIVE_CALLS_PATH is required")
function send(value: Schema.Json): void {
  process.stdout.write(JSON.stringify(value) + "\n")
}
createInterface({ input: process.stdin }).on("line", (line) => {
  const message: Request = JSON.parse(line)
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        serverInfo: { name: "takeover-fixture", version: "1" }
      }
    })
  } else if (message.method === "tools/call") {
    appendFileSync(callsPath, message.params.arguments.prompt + "\n")
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "text", text: "delivered" }], isError: false }
    })
  }
})
