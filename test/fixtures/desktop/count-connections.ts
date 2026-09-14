import { writeFileSync } from "node:fs"
import { Server } from "node:net"

const observedPath = process.env["OBSERVED_PATH"]
const bridgePath = process.env["FIXTURE_BRIDGE_PATH"]
if (observedPath === undefined || bridgePath === undefined)
  throw new Error("fixture paths are required")
let accepted = 0
writeFileSync(observedPath, String(accepted))
const emit = Server.prototype.emit
Server.prototype.emit = function (...args: Parameters<Server["emit"]>) {
  if (args[0] === "connection") writeFileSync(observedPath, String(++accepted))
  return emit.apply(this, args)
}
await import(`${bridgePath}?bridge`)
