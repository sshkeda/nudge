import { createInterface } from "node:readline"

import type { Request } from "./rpc.ts"
createInterface({ input: process.stdin }).on("line", (line) => {
  const message: Request = JSON.parse(line)
  if (message.method === "initialize")
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          serverInfo: { name: "redirected-fixture", version: "1" }
        }
      }) + "\n"
    )
})
