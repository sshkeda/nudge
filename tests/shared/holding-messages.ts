import assert from "node:assert/strict";

import { Effect, Schema } from "effect";

import {
  CLAUDE_MODEL_AND_EFFORT,
  HELD_EXIT_CODE,
  jsonLine,
  machineTest,
  NUDGE,
  startedIdOf,
  UUID,
} from "./machine-commands.ts";

const Held = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.Literal("MessageHeld"),
    messageId: Schema.String,
    reason: Schema.optional(Schema.String),
  }),
);

export const holdingMessages = machineTest((machine) =>
  Effect.gen(function* () {
    const heldId = yield* machine
      .shell(
        `cd ~/held && ${NUDGE} new --json claude ${CLAUDE_MODEL_AND_EFFORT} 'hello from nudge' --name '~Held Claude'`,
      )
      .pipe(Effect.flatMap(startedIdOf));
    yield* machine.waitUntilIdle("~Held Claude");
    const expectHeld = (standardError: string) =>
      Effect.gen(function* () {
        const { messageId, reason } = yield* Schema.decodeEffect(Held)(standardError);
        assert.match(messageId, UUID);
        const message = `Claude session "~Held Claude" (${heldId}) held the message for approval, so don't send it again${reason === undefined ? "" : `: ${reason}`}`;
        assert.equal(
          standardError,
          yield* jsonLine({
            error: "MessageHeld",
            message,
            hint: null,
            target: { id: heldId, name: "~Held Claude" },
            messageId,
            ...(reason === undefined ? {} : { reason }),
          }),
        );
        return message;
      });

    const heldJson = yield* machine.attempt(`${NUDGE} send --json '~Held Claude' 'please hold'`);
    assert.equal(heldJson.code, HELD_EXIT_CODE);
    assert.equal(heldJson.standardOutput, "");
    const message = yield* expectHeld(heldJson.standardError);
    assert.deepEqual(yield* machine.attempt(`${NUDGE} send '~Held Claude' 'please hold again'`), {
      code: HELD_EXIT_CODE,
      standardOutput: "",
      standardError: `error: ${message}`,
    });

    yield* machine.nudge(`archive '~Held Claude'`);
  }),
);
