import { lintConfig } from "@sshkeda/check";

export default lintConfig({
  ".github": { allow: ["isAnUnlistedDirectory"] },
  ".github/nudge-tic-tac-toe-demo-3x-speed.gif": { allow: ["hasAnUnlistedFileType"] },
  "docs/how-to-check-account-models-and-usage.md": { allow: ["hasAnUnlistedFileType"] },
  "scripts/lib/platform/internal/test-platform.ts": { allow: ["readsConfig"] },
  "scripts/shared/aimock.ts": {
    allow: ["handlesEveryFailure"],
  },
  "scripts/shared/codex-and-claude.ts": { allow: ["spawnsCommands"] },
  "scripts/shared/refuse-unsafe-machines.ts": { allow: ["readsConfig"] },
  "src/index.ts": {
    allow: ["handlesEveryFailure"],
  },
  "src/internal/command-words.ts": { allow: ["readsConfig"] },
  "src/internal/list-command.ts": {
    allow: ["handlesEveryFailure"],
  },
  "src/internal/run-nudge.ts": {
    allow: ["handlesEveryFailure"],
  },
  "src/internal/send-message.ts": {
    allow: ["handlesEveryFailure"],
  },
  "src/lib/claude/internal/claude-peer.ts": { allow: ["pollsWithADeadline"] },
  "src/lib/claude/internal/claude-service.ts": { services: ["Claude"] },
  "src/lib/codex-helper/internal/start-helper.ts": {
    allow: ["readsConfig", "exitsTheProcess", "spawnsCommands", "handlesEveryFailure"],
  },
  "src/lib/codex/internal/codex-service.ts": {
    services: ["Codex"],
    allow: ["handlesEveryFailure", "waitsOnTimers"],
  },
  "src/lib/codex/internal/codex-state-database.ts": { allow: ["usesSqlDatabases"] },
  "src/lib/codex/internal/read-app-server-defaults.ts": {
    allow: ["spawnsCommands", "handlesEveryFailure"],
  },
  "src/lib/codex/internal/desktop-permissions.ts": {
    allow: ["handlesEveryFailure"],
  },
  "src/lib/platform/internal/macos-platform.ts": { allow: ["locksFiles"] },
  "src/lib/platform/internal/platform-service.ts": { services: ["Platform"] },
  "src/shared/output.ts": { services: ["Output"] },
  "src/shared/print-line.ts": { allow: ["writesToTheTerminal"] },
  "src/shared/read-environment.ts": { allow: ["readsConfig"] },
  "src/shared/run-command.ts": {
    allow: ["spawnsCommands", "handlesEveryFailure"],
  },
  "src/shared/wait-until.ts": {
    allow: ["spawnsCommands", "handlesEveryFailure"],
  },
  "tests/internal/waiting-for-a-claude-socket.ts": { allow: ["spawnsCommands"] },
  "tests/shared/failure-as-value.ts": {
    allow: ["handlesEveryFailure"],
  },
});
