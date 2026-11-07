import assert from "node:assert/strict";

import { Effect } from "effect";

import { decodeSent, machineTest, NUDGE } from "./machine-commands.ts";

export const sendingToABusyCodexTask = machineTest((machine) =>
  Effect.gen(function* () {
    const codexId = yield* machine.start("codex 'hello from nudge' --name 'Busy Codex'");
    yield* machine.waitUntilIdle(codexId);
    const release = `${machine.scratch}/release`;
    yield* machine.nudge(`send ${codexId} 'HOLD_UNTIL: ${release}'`);
    assert.equal((yield* machine.showJson(codexId)).target.status, "running");

    const acceptedJson = yield* decodeSent(
      yield* machine.nudge(`send --json ${codexId} 'while you work'`),
    );
    assert.deepEqual(acceptedJson, {
      action: "send",
      provider: "codex",
      status: "accepted",
      delivery: "native",
      target: { id: codexId, name: "Busy Codex" },
      messageId: acceptedJson.messageId,
    });
    assert.deepEqual(yield* machine.attempt(`${NUDGE} send 'Busy Codex' 'and once more'`), {
      code: 0,
      standardOutput: `Sent the message to Codex session "Busy Codex" (${codexId}), which is in the middle of a turn, so it reads the message after its current step.`,
      standardError: `warning: nudge couldn't confirm the speed of Codex session ${codexId} within 3 seconds, so Codex Desktop may run this message at its default speed instead of Standard mode`,
    });
    assert.equal((yield* machine.showJson(codexId)).target.status, "running");
    assert.equal(
      yield* machine.shell(
        `grep -c -e 'while you work' -e 'and once more' ${(yield* machine.showJson(codexId)).target.transcript} || true`,
      ),
      "0",
    );

    yield* machine.shell(`touch ${release}`);
    yield* machine.transcriptHas({ target: codexId, texts: ["while you work", "and once more"] });
    yield* machine.waitUntilIdle(codexId);

    const finish = `${machine.scratch}/finish`;
    yield* machine.shell(`mkfifo ${finish}`);
    yield* machine.nudge(`send ${codexId} 'RUN_COMMAND: cat ${finish}'`);
    yield* machine.transcriptHas({ target: codexId, texts: ["Process running with session ID"] });
    assert.equal((yield* machine.showJson(codexId)).target.status, "running");
    yield* machine.shell(`echo finished > ${finish}`);
    yield* machine.waitUntilIdle(codexId);
    yield* machine.transcriptHas({ target: codexId, texts: ["Process exited with code 0"] });
    yield* machine.nudge("archive 'Busy Codex'");
  }),
);
