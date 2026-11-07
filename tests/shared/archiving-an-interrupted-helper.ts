import assert from "node:assert/strict";

import { Duration, Effect, Schema } from "effect";

import { BUN } from "../../scripts/shared/codex-and-claude.ts";
import { startCodexDesktop } from "../../scripts/shared/codex-desktop.ts";
import { CODEX_MODEL_AND_EFFORT, machineTest } from "./machine-commands.ts";
import { CHOOSE_FULL_ACCESS, GLOBAL_STATE } from "./matching-the-default-permissions.ts";
import { spansMentioning } from "./read-traces.ts";

const HELPER_TITLE = "Nudge permissions helper";

const GIVE_UP_AFTER = "2 minutes";

const CREATED_THREAD_ID = /threadId\\*":\\*"(?<threadId>[0-9a-f-]{36})/u;

const Outcome = Schema.fromJsonString(
  Schema.Struct({
    code: Schema.NullOr(Schema.Int),
    standardOutput: Schema.String,
    helperReply: Schema.String,
    interrupted: Schema.Boolean,
  }),
);

const interruptWhileCodexCreatesTheHelper = ({
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
const [nudge, socket, helperTitle, name, giveUpMillis, ...nudgeArguments] = process.argv.slice(1);
const real = socket + ".real";
const output = { standardOutput: "", helperReply: "", interrupted: false };
const running = { child: undefined };
const isCreate = (request, title) => request.includes("create_thread") && request.includes(title);
const server = createServer((client) => {
  const chunks = [];
  client.on("error", () => {});
  client.on("data", (data) => {
    chunks.push(String(data));
    const request = chunks.join("");
    if (!request.includes("\\n") || isCreate(request, name)) return;
    const upstream = connect(real);
    const reply = [];
    upstream.on("connect", () => upstream.write(request));
    upstream.on("data", (data) => reply.push(String(data)));
    upstream.on("error", () => client.destroy());
    upstream.on("end", () => {
      if (isCreate(request, helperTitle) && !output.interrupted) {
        output.helperReply = reply.join("");
        output.interrupted = true;
        process.kill(running.child.pid, "SIGINT");
      }
      client.end(reply.join(""));
    });
  });
});
renameSync(socket, real);
server.listen(socket, () => {
  const child = spawn(nudge, nudgeArguments, { stdio: ["ignore", "pipe", "ignore"] });
  running.child = child;
  child.stdout.on("data", (data) => (output.standardOutput += data));
  const giveUp = setTimeout(() => child.kill("SIGKILL"), Number(giveUpMillis));
  child.on("exit", (code) => {
    clearTimeout(giveUp);
    server.close();
    renameSync(real, socket);
    console.log(JSON.stringify({ code, ...output }));
    process.exit(0);
  });
});' ${nudge} '${socket}' '${HELPER_TITLE}' '${name}' ${Duration.toMillis(GIVE_UP_AFTER)} new --json codex ${CODEX_MODEL_AND_EFFORT} --name '${name}' 'hello after an interrupted helper'`;

export const archivingAnInterruptedHelper = machineTest((machine) =>
  Effect.gen(function* () {
    const savedState = `${machine.scratch}/codex-global-state-before-interrupting.json`;
    const name = "Interrupted helper";
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
            interruptWhileCodexCreatesTheHelper({
              nudge: machine.nudgePath,
              socket: machine.bridgeSocket,
              name,
            }),
          ),
        );
      }),
    );
    assert.ok(outcome.interrupted, "nudge never asked Codex Desktop to create the helper");
    assert.equal(outcome.standardOutput, "", "nudge started a session before it was interrupted");
    assert.notEqual(outcome.code, 0, "nudge finished starting the session before the interrupt");
    const helperId = CREATED_THREAD_ID.exec(outcome.helperReply)?.groups?.["threadId"] ?? "";
    assert.notEqual(helperId, "", `no thread ID in Codex Desktop's reply: ${outcome.helperReply}`);
    const helper = (yield* machine.showJson(helperId)).target;
    assert.equal(helper.name, HELPER_TITLE);
    assert.equal(helper.status, "archived");
    const archivedAfterTheInterrupt = (yield* spansMentioning({ machine, text: helperId })).filter(
      (span) =>
        span.name === "codex.archiveHelperAfterFailure" &&
        span.attributes.some(
          (attribute) =>
            attribute.key === "nudge.codex.helperThreadId" &&
            attribute.value.stringValue === helperId,
        ) &&
        span.attributes.some(
          (attribute) =>
            attribute.key === "nudge.codex.helper.archived" && attribute.value.boolValue === true,
        ),
    );
    assert.equal(
      archivedAfterTheInterrupt.length,
      1,
      "nudge didn't archive the helper after the interrupt",
    );
  }),
);
