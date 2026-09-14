import { appendFileSync } from "node:fs"
import { createInterface } from "node:readline"

const callsPath = process.env["FAKE_NATIVE_CALLS_PATH"]
if (callsPath === undefined) throw new Error("FAKE_NATIVE_CALLS_PATH is required")

type Request = {
  readonly id: string | number
  readonly method: string
  readonly params?: { readonly arguments?: { readonly threadId: string } }
}

type Response = {
  readonly jsonrpc: "2.0"
  readonly id: string | number
  readonly result:
    | {
        readonly protocolVersion: string
        readonly capabilities: Record<string, never>
        readonly serverInfo: { readonly name: string; readonly version: string }
      }
    | {
        readonly content: readonly { readonly type: "text"; readonly text: string }[]
        readonly isError: false
      }
}

function send(value: Response): void {
  process.stdout.write(JSON.stringify(value) + "\n")
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message: Request = JSON.parse(line)
  appendFileSync(callsPath, JSON.stringify(message) + "\n")
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        serverInfo: { name: "fixture", version: "1" }
      }
    })
  } else if (message.method === "tools/call") {
    const threadId = message.params?.arguments?.threadId
    if (threadId === undefined) throw new Error("threadId is required")
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [{ type: "text", text: JSON.stringify({ threadId }) }],
        isError: false
      }
    })
  }
})
