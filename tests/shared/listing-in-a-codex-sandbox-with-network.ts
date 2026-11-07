import assert from "node:assert/strict";

import { Effect, Option } from "effect";

import { BUN, readFirstLine } from "../../scripts/shared/codex-and-claude.ts";
import { FAILED_EXIT_CODE, machineTest, NUDGE } from "./machine-commands.ts";

const OPEN_CLAUDE_IN_A_TERMINAL = `exec ${BUN} -e '
const sessionId = crypto.randomUUID();
console.log(sessionId);
const claude = Bun.spawn([process.env.HOME + "/.local/bin/claude", "--session-id", sessionId, "hello from nudge"], {
  cwd: process.env.HOME + "/work",
  env: { ...process.env, CLAUDE_CODE_NO_FLICKER: "1" },
  terminal: { cols: 120, rows: 40, data: () => {} },
});
process.on("SIGTERM", () => { claude.kill(); process.exit(0); });
await claude.exited;'`;

export const listingInACodexSandboxWithNetwork = machineTest((machine) =>
  Effect.scoped(
    Effect.gen(function* () {
      const opened = yield* machine.startInThisScope(OPEN_CLAUDE_IN_A_TERMINAL);
      const sessionId = Option.getOrElse(yield* readFirstLine(opened), () => "");
      yield* machine.shell(
        `for check in $(seq 1 120); do ${NUDGE} show ${sessionId} > /dev/null 2>&1 && break; sleep 0.5; done`,
      );
      yield* machine.waitUntilIdle(sessionId);
      const ran = yield* machine.shell(
        `cd ~/work && ${machine.codexCli} exec --skip-git-repo-check --json -s workspace-write -c sandbox_workspace_write.network_access=true "RUN_COMMAND: echo sandbox=\\$CODEX_SANDBOX; ${machine.nudgePath} list" < /dev/null 2>&1`,
      );
      assert.doesNotMatch(ran, /ERROR \(#\d+\)|\\n\s+at /u, ran);
      if ((yield* machine.shell("uname")) === "Darwin") {
        assert.match(
          ran,
          /sandbox=seatbelt/u,
          `codex exec didn't run the command in its sandbox: ${ran}`,
        );
        assert.match(
          ran,
          /error: Codex's sandbox blocks nudge from running ps, so run this nudge command outside the sandbox/u,
          ran,
        );
        assert.deepEqual(
          yield* machine.attempt(
            `sandbox-exec -p '(version 1)(allow default)(deny process-exec (literal "/bin/ps"))' ${machine.nudgePath} list`,
          ),
          {
            code: FAILED_EXIT_CODE,
            standardOutput: "",
            standardError:
              "error: nudge couldn't start ps: EPERM: operation not permitted, posix_spawn 'ps'",
          },
        );
      }
    }),
  ),
);
