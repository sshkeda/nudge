import { join } from "node:path"
const descendant = Bun.spawn([process.execPath, join(import.meta.dir, "stdout-holder.ts")], {
  stdin: "ignore",
  stdout: "inherit",
  stderr: "ignore"
})
console.error(descendant.pid)
descendant.unref()
process.stdin.once("data", () => process.exit(7))
