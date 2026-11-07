import assert from "node:assert/strict";

import { Effect } from "effect";

import { BUN } from "../../scripts/shared/codex-and-claude.ts";
import { startCodexDesktop } from "../../scripts/shared/codex-desktop.ts";
import { machineTest, rows } from "./machine-commands.ts";

const STATUS_COLUMN = 3;

export const recoveringCodexStatusAfterACrash = machineTest((machine) =>
  Effect.gen(function* () {
    const id = yield* machine.start("codex 'hello from nudge' --name 'Crashed Codex'");
    yield* machine.waitUntilIdle(id);
    const release = `${machine.scratch}/release-crashed-turn`;
    yield* machine.nudge(`send ${id} 'HOLD_UNTIL: ${release}'`);
    const shown = (yield* machine.showJson(id)).target;
    assert.equal(shown.status, "running");
    yield* machine.shell(machine.quitCodex);
    const lastTurnEvent = yield* machine.shell(`${BUN} -e '
const lines = (await Bun.file(process.argv[1]).text()).trimEnd().split("\\n").map((line) => JSON.parse(line));
const events = lines.filter((line) => line.type === "event_msg" && ["task_started", "task_complete", "turn_aborted"].includes(line.payload.type));
console.log(events.at(-1).payload.type);' ${shown.transcript}`);
    assert.equal(lastTurnEvent, "task_started");
    yield* startCodexDesktop();
    assert.equal((yield* machine.showJson(id)).target.status, "idle");
    assert.equal(
      rows(yield* machine.nudge(`list ${id}`)).find((row) => row[1] === id)?.[STATUS_COLUMN],
      "idle",
    );
    yield* machine.shell(`touch ${release}`);
    yield* machine.nudge(`archive ${id}`);
  }),
);
