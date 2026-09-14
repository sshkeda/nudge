import { renameSync, writeFileSync } from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import net from "node:net"

const path = process.env["NUDGE_CODEX_BRIDGE_SOCKET"]
const observed = process.env["OBSERVED_PATH"]
const mode = process.env["PROBE_MODE"]
const helper = process.env["FIXTURE_BRIDGE_PATH"]
if (!path || !observed || !helper) throw new Error("fixture paths are required")
let calls = 0
net.createConnection = () => {
  const socket = new net.Socket()
  calls += 1
  if (calls === 2) writeFileSync(observed, "retried")
  if (mode === "replacement" && calls === 1) renameSync(path + ".replacement", path)
  if (mode === "replacement" && calls > 1) {
    queueMicrotask(() => socket.emit("connect"))
    return socket
  }
  if (mode !== "timeout")
    queueMicrotask(() =>
      socket.emit(
        "error",
        Object.assign(new Error("probe failed"), {
          code: mode === "replacement" ? "ECONNREFUSED" : "EACCES"
        })
      )
    )
  return socket
}
syncBuiltinESMExports()
await import(`${helper}?bridge`)
