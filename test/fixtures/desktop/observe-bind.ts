import { statSync, writeFileSync } from "node:fs"
import { Server } from "node:net"

import { Schema } from "effect"

const observedPath = process.env["OBSERVED_PATH"]
const bridgePath = process.env["FIXTURE_BRIDGE_PATH"]
if (observedPath === undefined || bridgePath === undefined)
  throw new Error("fixture paths are required")
process.umask(0o022)
const emit = Server.prototype.emit
Server.prototype.emit = function (...args: Parameters<Server["emit"]>) {
  if (args[0] === "listening") {
    const socketPath = Schema.decodeUnknownSync(Schema.String)(this.address())
    writeFileSync(
      observedPath,
      JSON.stringify({ mode: statSync(socketPath).mode & 0o077, mask: process.umask() })
    )
  }
  return emit.apply(this, args)
}
await import(`${bridgePath}?bridge`)
