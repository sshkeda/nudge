import assert from "node:assert/strict";

import { Effect } from "effect";

import { stopProcesses } from "../../scripts/lib/platform/index.ts";
import { BUN } from "../../scripts/shared/codex-and-claude.ts";
import { decodeSent, machineTest, NUDGE, rows, rowsWithoutUpdated } from "./machine-commands.ts";
import { stoppedClaudeIsArchived } from "./renaming-and-archiving.ts";

export const CLAUDE_JOB_ID_LENGTH = 8;

export const STATUS_COLUMN = 3;

export const stopClaudeProcesses = ({
  sessionIds,
  waitForExit,
}: {
  readonly sessionIds: readonly string[];
  readonly waitForExit: (pids: string) => string;
}) => `${stopProcesses({ pattern: "^[^ ]*claude", waitForExit })}
claude agents --json --all > /dev/null
${BUN} -e '
for (const sessionId of [${sessionIds.map((id) => `"${id}"`).join(", ")}]) {
  const file = process.env.HOME + "/.claude/jobs/" + sessionId.slice(0, ${CLAUDE_JOB_ID_LENGTH}) + "/state.json";
  const state = await Bun.file(file).json();
  await Bun.write(file, JSON.stringify({ ...state, state: "blocked", tempo: "blocked", needs: "a reply" }));
}'`;

export const resumingAKilledClaudeSession = machineTest((machine) =>
  Effect.gen(function* () {
    const blockedId = yield* machine.start("claude 'hello from nudge' --name 'Nudge Blocked'");
    yield* machine.waitUntilIdle(blockedId);
    yield* machine.shell(
      stopClaudeProcesses({ sessionIds: [blockedId], waitForExit: machine.waitForExit }),
    );
    assert.deepEqual(rowsWithoutUpdated(yield* machine.nudge("list --archived 'Nudge Blocked'")), [
      ["Nudge Blocked", blockedId, "Claude", "stopped", "work"],
    ]);
    const resumed = yield* decodeSent(
      yield* machine.nudge("send --json 'Nudge Blocked' 'wake up'"),
    );
    assert.deepEqual(resumed.target, { id: blockedId, name: "Nudge Blocked" });
    yield* machine.waitUntilIdle(blockedId);
    yield* machine.transcriptHas({ target: blockedId, texts: ["wake up"] });
    assert.deepEqual(
      rows(yield* machine.nudge("list 'Nudge Blocked'")).map((row) => [row[1], row[STATUS_COLUMN]]),
      [[blockedId, "idle"]],
    );
    yield* machine.shell(
      stopClaudeProcesses({ sessionIds: [blockedId], waitForExit: machine.waitForExit }),
    );
    assert.deepEqual(rowsWithoutUpdated(yield* machine.nudge("list --archived 'Nudge Blocked'")), [
      ["Nudge Blocked", blockedId, "Claude", "stopped", "work"],
    ]);
    assert.deepEqual(yield* machine.attempt(`${NUDGE} rename 'Nudge Blocked' 'Nudge Renamed'`), {
      code: 0,
      standardOutput: `Renamed Claude session "Nudge Blocked" (${blockedId}) to "Nudge Renamed".`,
      standardError: "",
    });
    assert.deepEqual(rowsWithoutUpdated(yield* machine.nudge("list --archived 'Nudge Renamed'")), [
      ["Nudge Renamed", blockedId, "Claude", "stopped", "work"],
    ]);
    assert.deepEqual(yield* machine.attempt(`${NUDGE} archive 'Nudge Renamed'`), {
      code: 0,
      standardOutput: stoppedClaudeIsArchived({ id: blockedId, name: "Nudge Renamed" }),
      standardError: "",
    });
    assert.equal(
      yield* machine.nudge("list 'Nudge Renamed'"),
      `No matches for "Nudge Renamed".\nhint: nudge list --archived 'Nudge Renamed'`,
    );
  }),
);
