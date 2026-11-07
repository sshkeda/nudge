import assert from "node:assert/strict";

import { Duration, Effect, Schema } from "effect";

import { BUN } from "../../scripts/shared/codex-and-claude.ts";
import { startCodexDesktop } from "../../scripts/shared/codex-desktop.ts";
import { CODEX_MODEL_AND_EFFORT, machineTest, startedIdOf } from "./machine-commands.ts";
import { CHOOSE_FULL_ACCESS, GLOBAL_STATE } from "./matching-the-default-permissions.ts";

const HELPER_TITLE = "Nudge permissions helper";

const GIVE_UP_AFTER = "4 minutes";

const REFUSAL = '{"error":{"message":"the test refused to archive the helper"}}';

const Outcome = Schema.fromJsonString(
  Schema.Struct({
    code: Schema.NullOr(Schema.Int),
    standardOutput: Schema.String,
    standardError: Schema.String,
    helperId: Schema.String,
    refused: Schema.Boolean,
  }),
);

const refuseToArchiveTheHelper = ({
  nudge,
  socket,
  name,
}: {
  readonly nudge: string;
  readonly socket: string;
  readonly name: string;
}) => `${BUN} -e '
import { spawn } from "node:child_process";
import { renameSync } from "node:fs";
import { connect, createServer } from "node:net";
const [nudge, socket, helperTitle, refusal, giveUpMillis, ...nudgeArguments] = process.argv.slice(1);
const real = socket + ".real";
const output = { standardOutput: "", standardError: "", helperId: "", refused: false };
const isCreate = (request, title) => request.includes("create_thread") && request.includes(title);
const isArchivingTheHelper = (request) =>
  output.helperId !== "" && request.includes("set_thread_archived") && request.includes(output.helperId) && request.includes("\\"archived\\":true");
const server = createServer((client) => {
  const chunks = [];
  client.on("error", () => {});
  client.on("data", (data) => {
    chunks.push(String(data));
    const request = chunks.join("");
    if (!request.includes("\\n")) return;
    if (isArchivingTheHelper(request)) {
      output.refused = true;
      client.end(refusal);
      return;
    }
    const upstream = connect(real);
    const reply = [];
    upstream.on("connect", () => upstream.write(request));
    upstream.on("data", (data) => reply.push(String(data)));
    upstream.on("error", () => client.destroy());
    upstream.on("end", () => {
      const replied = reply.join("");
      if (isCreate(request, helperTitle)) {
        output.helperId = /threadId\\\\*":\\\\*"([0-9a-f-]{36})/u.exec(replied)?.[1] ?? "";
      }
      client.end(replied);
    });
  });
});
renameSync(socket, real);
server.listen(socket, () => {
  const child = spawn(nudge, nudgeArguments, { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (data) => (output.standardOutput += data));
  child.stderr.on("data", (data) => (output.standardError += data));
  const giveUp = setTimeout(() => child.kill("SIGKILL"), Number(giveUpMillis));
  child.on("exit", (code) => {
    clearTimeout(giveUp);
    server.close();
    renameSync(real, socket);
    console.log(JSON.stringify({ code, ...output }));
    process.exit(0);
  });
});' ${nudge} '${socket}' '${HELPER_TITLE}' '${REFUSAL}' ${Duration.toMillis(GIVE_UP_AFTER)} new --json codex ${CODEX_MODEL_AND_EFFORT} --name '${name}' 'hello while the helper stays'`;

export const warningAboutAnUnarchivedHelper = machineTest((machine) =>
  Effect.gen(function* () {
    const savedState = `${machine.scratch}/codex-global-state-before-refusing.json`;
    const name = "Helper left unarchived";
    const shellQuietly = (command: string) =>
      machine.shell(command).pipe(
        Effect.asVoid,
        Effect.catchTags({
          CommandFailed: () => Effect.void,
          CommandNotStarted: () => Effect.void,
          CommandStandardInputFailed: () => Effect.void,
          PlatformError: () => Effect.void,
        }),
      );
    const outcome = yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          shellQuietly(`[ ! -e ${savedState} ] || cp ${savedState} ${GLOBAL_STATE}`),
        );
        yield* startCodexDesktop({
          beforeStart: `cp ${GLOBAL_STATE} ${savedState}\n${CHOOSE_FULL_ACCESS}`,
        });
        yield* Effect.addFinalizer(() =>
          shellQuietly(
            `[ ! -e '${machine.bridgeSocket}.real' ] || mv '${machine.bridgeSocket}.real' '${machine.bridgeSocket}'`,
          ),
        );
        return yield* Schema.decodeEffect(Outcome)(
          yield* machine.shell(
            refuseToArchiveTheHelper({
              nudge: machine.nudgePath,
              socket: machine.bridgeSocket,
              name,
            }),
          ),
        );
      }),
    );
    assert.notEqual(outcome.helperId, "", "nudge never asked Codex Desktop to create the helper");
    assert.ok(outcome.refused, "nudge never asked Codex Desktop to archive the helper");
    yield* Effect.addFinalizer(() =>
      shellQuietly(`${machine.nudgePath} archive ${outcome.helperId}`),
    );
    assert.equal(outcome.code, 0, `nudge new failed: ${outcome.standardError}`);
    const startedId = yield* startedIdOf(outcome.standardOutput.trim());
    yield* Effect.addFinalizer(() => shellQuietly(`${machine.nudgePath} archive ${startedId}`));
    const warning = `warning: started the session, but nudge couldn't archive its permissions helper session ${outcome.helperId}, so it may stay in your Codex list. You can archive it in Codex Desktop.`;
    assert.ok(
      outcome.standardError.split("\n").includes(warning),
      `nudge didn't warn about the helper: ${outcome.standardError}`,
    );
    const helper = (yield* machine.showJson(outcome.helperId)).target;
    assert.equal(helper.name, HELPER_TITLE);
    assert.notEqual(helper.status, "archived");
    assert.equal((yield* machine.showJson(startedId)).target.name, name);
  }),
);
