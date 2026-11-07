import assert from "node:assert/strict";

import { Effect, Schema } from "effect";

import { renameATerminalSession } from "./listing-sessions.ts";
import { machineTest, NUDGE, rowsWithoutUpdated } from "./machine-commands.ts";
import { stoppedClaudeIsArchived } from "./renaming-and-archiving.ts";

const NAME = "Terminal Archived";

const ArchivedTerminal = Schema.fromJsonString(
  Schema.Struct({
    sessionId: Schema.String,
    code: Schema.Int,
    standardOutput: Schema.String,
    standardError: Schema.String,
  }),
);

export const archivingATerminalSession = machineTest((machine) =>
  Effect.gen(function* () {
    const archived = yield* Schema.decodeEffect(ArchivedTerminal)(
      yield* machine.shell(renameATerminalSession({ name: NAME, end: "archive with nudge" })),
    );
    const id = archived.sessionId;
    assert.deepEqual(
      {
        code: archived.code,
        standardOutput: archived.standardOutput,
        standardError: archived.standardError,
      },
      { code: 0, standardOutput: `Archived Claude session "${NAME}" (${id}).`, standardError: "" },
    );
    const shown = yield* machine.showJson(id);
    assert.deepEqual(
      { name: shown.target.name, status: shown.target.status, cwd: shown.target.cwd },
      { name: NAME, status: "stopped", cwd: `${machine.home}/work` },
    );
    assert.deepEqual(
      (yield* machine.nudge(`show '${NAME}'`))
        .split("\n")
        .filter((line) => /^(?:Name|ID|Status|Project|Directory):/u.test(line))
        .map((line) => line.replace(/^\w+:\s+/u, "")),
      [NAME, id, "stopped", "~/work", "~/work"],
    );
    assert.deepEqual(rowsWithoutUpdated(yield* machine.nudge(`list --archived '${NAME}'`)), [
      [NAME, id, "Claude", "stopped", "work"],
    ]);
    assert.equal(
      yield* machine.nudge(`list '${NAME}'`),
      `No matches for "${NAME}".\nhint: nudge list --archived '${NAME}'`,
    );
    assert.deepEqual(yield* machine.attempt(`${NUDGE} archive '${NAME}'`), {
      code: 0,
      standardOutput: stoppedClaudeIsArchived({ id, name: NAME }),
      standardError: "",
    });
  }),
);
