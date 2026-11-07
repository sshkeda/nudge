import assert from "node:assert/strict";

import { Duration, Effect, Option, Schema } from "effect";

import { BUN, readFirstLine } from "../../scripts/shared/codex-and-claude.ts";
import { FAILED_EXIT_CODE, machineTest, NUDGE } from "./machine-commands.ts";

const LOCKED = "locked";

const LONGER_THAN_CODEX_BUSY_TIMEOUT = "7 seconds";

const LONGER_THAN_EVERY_ARCHIVE_TRY = "10 minutes";

class StateDatabaseNotLocked extends Schema.TaggedError<StateDatabaseNotLocked>()(
  "StateDatabaseNotLocked",
  { printed: Schema.NullOr(Schema.String) },
) {
  public override get message() {
    return `the writer that holds Codex's state database printed ${String(this.printed)} instead of "${LOCKED}"`;
  }
}

const holdCodexStateDatabase = ({
  releasing,
  duration,
}: {
  readonly releasing: string;
  readonly duration: Duration.Input;
}) => `exec ${BUN} -e '
import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
const [releasing, milliseconds] = process.argv.slice(1);
const directory = process.env.HOME + "/.codex";
const [newest] = readdirSync(directory)
  .filter((name) => /^state_\\d+\\.sqlite$/.test(name))
  .toSorted((left, right) => right.localeCompare(left, undefined, { numeric: true }));
const database = new Database(directory + "/" + newest);
database.exec("PRAGMA busy_timeout = 60000");
database.exec("BEGIN IMMEDIATE");
console.log("${LOCKED}");
await Bun.sleep(Number(milliseconds));
await Bun.write(releasing, "");
database.exec("COMMIT");' ${releasing} ${Duration.toMillis(duration)}`;

export const archivingWhileCodexDatabaseIsLocked = machineTest((machine) =>
  Effect.gen(function* () {
    const id = yield* machine.start("codex 'hello from nudge' --name 'Locked Codex'");
    yield* machine.waitUntilIdle(id);
    const releasing = `${machine.scratch}/releasing`;

    const archiveWhileLocked = ({
      name,
      threadId,
      released,
      duration,
    }: {
      readonly name: string;
      readonly threadId: string;
      readonly released: string;
      readonly duration: Duration.Input;
    }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const writer = yield* machine.startInThisScope(
            holdCodexStateDatabase({ releasing: released, duration }),
          );
          const printed = Option.getOrNull(yield* readFirstLine(writer));
          if (printed !== LOCKED) {
            return yield* new StateDatabaseNotLocked({ printed });
          }
          const result = yield* machine.attempt(`${NUDGE} archive '${name}'`);
          const whileWriterIsRunning = (yield* machine.showJson(threadId)).target.status;
          return { result, whileWriterIsRunning };
        }),
      );
    const archived = yield* archiveWhileLocked({
      name: "Locked Codex",
      threadId: id,
      released: releasing,
      duration: LONGER_THAN_CODEX_BUSY_TIMEOUT,
    });

    assert.deepEqual(archived.result, {
      code: 0,
      standardOutput: `Archived Codex session "Locked Codex" (${id}).`,
      standardError: "",
    });
    assert.equal(archived.whileWriterIsRunning, "archived");
    assert.equal(yield* machine.shell(`test -e ${releasing} && echo released`), "released");
    assert.equal((yield* machine.showJson(id)).target.status, "archived");

    const stuckId = yield* machine.start("codex 'hello from nudge' --name 'Stuck Codex'");
    yield* machine.waitUntilIdle(stuckId);
    const stuck = yield* archiveWhileLocked({
      name: "Stuck Codex",
      threadId: stuckId,
      released: `${machine.scratch}/still-releasing`,
      duration: LONGER_THAN_EVERY_ARCHIVE_TRY,
    });
    assert.equal(stuck.result.code, FAILED_EXIT_CODE, stuck.result.standardError);
    assert.equal(stuck.result.standardOutput, "");
    assert.match(
      stuck.result.standardError,
      new RegExp(
        String.raw`^error: Codex didn't archive session ${stuckId}, because another writer kept Codex's state database locked while nudge retried for 30 seconds: .+\nhint: nudge archive ${stuckId}$`,
        "u",
      ),
    );
    assert.equal(stuck.whileWriterIsRunning, "idle");
    assert.equal((yield* machine.showJson(stuckId)).target.status, "idle");
    yield* machine.nudge(`archive ${stuckId}`);
  }),
);
