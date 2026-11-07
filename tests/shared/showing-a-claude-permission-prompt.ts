import assert from "node:assert/strict";

import { Effect } from "effect";

import { BUN } from "../../scripts/shared/codex-and-claude.ts";
import { machineTest, NUDGE } from "./machine-commands.ts";

const askForApprovalInATerminal = (approved: string) => `${BUN} -e '
const home = process.env.HOME;
const sessionId = crypto.randomUUID();
const shownText = (text) => text.replace(/\\x1b\\[[0-9;?]*[A-Za-z]/g, " ").replace(/\\s+/g, " ");
let screen = "";
const claude = Bun.spawn([home + "/.local/bin/claude", "--session-id", sessionId, "--permission-mode", "default", "RUN_COMMAND: touch ${approved}"], {
  cwd: home + "/work",
  env: { ...process.env, CLAUDE_CODE_NO_FLICKER: "1" },
  terminal: { cols: 120, rows: 40, data: (_, data) => { screen += new TextDecoder().decode(data); } },
});
let status = "";
for (let check = 0; check < 120 && status !== "waiting-for-approval"; check += 1) {
  await Bun.sleep(500);
  const shown = Bun.spawnSync(["sh", "-c", "${NUDGE} show --json " + sessionId]);
  status = shown.exitCode === 0 ? JSON.parse(shown.stdout.toString()).target.status : "";
}
const sessionFiles = Bun.spawnSync(["sh", "-c", "cat " + home + "/.claude/sessions/*.json"]).stdout.toString();
claude.kill();
await claude.exited;
process.stdout.write(JSON.stringify({ status, sessionFiles, screen: shownText(screen).slice(-1500) }));'`;

export const showingAClaudePermissionPrompt = machineTest((machine) =>
  Effect.gen(function* () {
    const approved = `${machine.scratch}/approved-by-a-person`;
    const asked = yield* machine.shell(askForApprovalInATerminal(approved));
    assert.match(asked, /^\{"status":"waiting-for-approval",/u, asked);
    assert.equal(
      yield* machine.shell(`test -e ${approved} && echo ran || echo waiting`),
      "waiting",
    );
  }),
);
