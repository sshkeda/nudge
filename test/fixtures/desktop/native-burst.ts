import { appendFileSync } from "node:fs"
import { createInterface } from "node:readline"

import { Effect } from "effect"
import type { Schema } from "effect"

import type { Request } from "./rpc.ts"
const callsPath = process.env["FAKE_NATIVE_CALLS_PATH"]
if (callsPath === undefined) throw new Error("FAKE_NATIVE_CALLS_PATH is required")
let inFlight = 0
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
        serverInfo: { name: "burst-fixture", version: "1" }
      }
    })
  } else if (message.method === "tools/call") {
    inFlight += 1
    const prompt = message.params.arguments.prompt
    appendFileSync(callsPath, JSON.stringify({ event: "start", prompt, inFlight }) + "\n")
    if (inFlight > 1) {
      inFlight -= 1
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: "fixture native queue is full" }
      })
      return
    }
    Effect.runFork(
      Effect.andThen(
        Effect.sleep(15),
        Effect.sync(() => {
          appendFileSync(callsPath, JSON.stringify({ event: "finish", prompt, inFlight }) + "\n")
          inFlight -= 1
          send({
            jsonrpc: "2.0",
            id: message.id,
            result: { content: [{ type: "text", text: "delivered" }], isError: false }
          })
        })
      )
    )
  }
})
