import { homedir } from "node:os"
import { join } from "node:path"

export function claudeConfigDirectory(): string {
  return Bun.env["CLAUDE_CONFIG_DIR"] || join(homedir(), ".claude")
}
