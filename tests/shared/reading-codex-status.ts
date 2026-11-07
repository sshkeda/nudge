import assert from "node:assert/strict";

import { Effect } from "effect";

import { BUN } from "../../scripts/shared/codex-and-claude.ts";
import { describeRuntimeStatus } from "../../src/lib/codex/internal/codex-service.ts";
import { machineTest, rows } from "./machine-commands.ts";

const PROMPT_PADDING_BYTES = 130_800;

const OLD_STATUS_WINDOW_BYTES = 262_144;

const STATUS_COLUMN = 3;

export const readingCodexStatus = machineTest((machine) =>
  Effect.gen(function* () {
    assert.equal(describeRuntimeStatus({ type: "active", activeFlags: [] }), "running");
    assert.equal(
      describeRuntimeStatus({ type: "active", activeFlags: ["waitingOnApproval"] }),
      "waiting-for-approval",
    );
    assert.equal(
      describeRuntimeStatus({ type: "active", activeFlags: ["waitingOnUserInput"] }),
      "waiting-for-input",
    );
    assert.equal(describeRuntimeStatus({ type: "active", activeFlags: ["futureFlag"] }), "running");
    assert.equal(describeRuntimeStatus({ type: "systemError" }), "failed");
    assert.equal(describeRuntimeStatus({ type: "notLoaded" }), "idle");
    const id = yield* machine.start("codex 'hello from nudge' --name 'Codex Status'");
    yield* machine.waitUntilIdle(id);
    const release = `${machine.scratch}/release-status`;
    yield* machine.nudge(
      `send ${id} "$(${BUN} -e 'console.log("HOLD_UNTIL: ${release}\\n" + "x".repeat(${PROMPT_PADDING_BYTES}))')"`,
    );
    yield* machine.filesHave([{ file: `${release}.started`, texts: ["ready"] }]);
    const transcript = (yield* machine.showJson(id)).target.transcript;
    const bytesSinceTurnStart = yield* machine.shell(`${BUN} -e '
const lines = (await Bun.file(process.argv[1]).text()).trimEnd().split("\\n");
const start = lines.findLastIndex((line) => { const value = JSON.parse(line); return value.type === "event_msg" && value.payload.type === "task_started"; });
console.log(Buffer.byteLength(lines.slice(start).join("\\n")));' ${transcript}`);
    assert.ok(Number(bytesSinceTurnStart) > OLD_STATUS_WINDOW_BYTES, bytesSinceTurnStart);
    const concurrentReads = yield* Effect.all([machine.showJson(id), machine.showJson(id)], {
      concurrency: "unbounded",
    });
    assert.deepEqual(
      concurrentReads.map((shown) => shown.target.status),
      ["running", "running"],
    );
    assert.equal(
      rows(yield* machine.nudge(`list ${id}`)).find((row) => row[1] === id)?.[STATUS_COLUMN],
      "running",
    );
    yield* machine.shell(`touch ${release}`);
    yield* machine.transcriptHas({ target: id, texts: ["Released."] });
    yield* machine.waitUntilIdle(id);
    assert.equal((yield* machine.showJson(id)).target.status, "idle");
    assert.equal(
      rows(yield* machine.nudge(`list ${id}`)).find((row) => row[1] === id)?.[STATUS_COLUMN],
      "idle",
    );
    yield* machine.nudge(`archive ${id}`);
  }),
);
