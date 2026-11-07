import assert from "node:assert/strict";

import { Duration, Effect, Schema } from "effect";

import { thisMachine } from "../../scripts/lib/platform/index.ts";
import { PERMISSIONS_HELPER_HOLD } from "../../scripts/shared/aimock.ts";
import { BUN } from "../../scripts/shared/codex-and-claude.ts";
import { startCodexDesktop } from "../../scripts/shared/codex-desktop.ts";
import { CODEX_MODEL_AND_EFFORT, machineTest } from "./machine-commands.ts";
import { CHOOSE_FULL_ACCESS, GLOBAL_STATE } from "./matching-the-default-permissions.ts";
import { spansMentioning } from "./read-traces.ts";

const APP_SERVER_PAUSE = "10 seconds";

const CHECK_INTERVAL = "10 millis";

const Outcome = Schema.fromJsonString(
  Schema.Struct({
    code: Schema.Int,
    standardOutput: Schema.String,
    standardError: Schema.String,
    helperRollout: Schema.String,
  }),
);

const startWithPausedAppServer = ({
  nudge,
  logs,
  started,
  appServer,
  name,
}: {
  readonly nudge: string;
  readonly logs: string;
  readonly started: string;
  readonly appServer: string;
  readonly name: string;
}) => `${BUN} -e '
import { spawn, spawnSync } from "node:child_process";
import { existsSync, watch } from "node:fs";
const [nudge, sessions, logs, started, appServer, pauseMillis, checkMillis, ...nudgeArguments] = process.argv.slice(1);
const answered = () => spawnSync("grep", ["-rh", "Sending server response.*tool=create_thread", logs]).stdout.toString().split("\\n").filter(Boolean).length;
const answeredBefore = answered();
const signalAppServer = (signal) => spawnSync("pkill", ["-" + signal, "-f", appServer]);
const output = { standardOutput: "", standardError: "", helperRollout: "" };
const child = spawn(nudge, nudgeArguments, { stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", (data) => (output.standardOutput += data));
child.stderr.on("data", (data) => (output.standardError += data));
const watcher = watch(sessions, { recursive: true }, (event, file) => {
  if (output.helperRollout !== "" || !String(file).endsWith(".jsonl")) return;
  output.helperRollout = sessions + "/" + file;
  process.kill(child.pid, "SIGSTOP");
  const waiting = setInterval(() => {
    if (!existsSync(started) || answered() === answeredBefore) return;
    clearInterval(waiting);
    signalAppServer("STOP");
    process.kill(child.pid, "SIGCONT");
    setTimeout(() => signalAppServer("CONT"), Number(pauseMillis));
  }, Number(checkMillis));
});
child.on("exit", (code) => {
  watcher.close();
  signalAppServer("CONT");
  console.log(JSON.stringify({ code, ...output }));
  process.exit(0);
});' ${nudge} ~/.codex/sessions '${logs}' '${started}' '${appServer}' ${Duration.toMillis(APP_SERVER_PAUSE)} ${Duration.toMillis(CHECK_INTERVAL)} new --json codex ${CODEX_MODEL_AND_EFFORT} --name '${name}' 'hello after a late stop'`;

export const confirmingAStoppedTurnLate = machineTest((machine) =>
  Effect.gen(function* () {
    const { app } = yield* thisMachine;
    const savedState = `${machine.scratch}/codex-global-state.json`;
    const release = `${machine.scratch}/release-permissions-helper`;
    const hold = `${machine.home}/${PERMISSIONS_HELPER_HOLD}`;
    const name = "Late stop";
    const outcome = yield* Effect.scoped(
      Effect.gen(function* () {
        yield* startCodexDesktop({
          beforeStart: `cp ${GLOBAL_STATE} ${savedState}\n${CHOOSE_FULL_ACCESS}`,
        });
        yield* Effect.acquireRelease(machine.shell(`printf '%s' '${release}' > '${hold}'`), () =>
          machine.shell(`rm -f '${hold}'; touch '${release}'`).pipe(
            Effect.catchTags({
              CommandFailed: () => Effect.void,
              CommandNotStarted: () => Effect.void,
              CommandStandardInputFailed: () => Effect.void,
              PlatformError: () => Effect.void,
            }),
          ),
        );
        return yield* Schema.decodeEffect(Outcome)(
          yield* machine.shell(
            startWithPausedAppServer({
              nudge: machine.nudgePath,
              logs: machine.codexLogs,
              started: `${release}.started`,
              appServer: `^${app}/.*codex .*app-server`,
              name,
            }),
          ),
        );
      }).pipe(
        Effect.andThen((started) =>
          Effect.gen(function* () {
            assert.equal(started.code, 0, started.standardError);
            const { id } = (yield* machine.showJson(name)).target;
            yield* machine.waitUntilIdle(id);
            const { transcript } = (yield* machine.showJson(id)).target;
            const firstTurn = yield* machine.shell(
              `grep -m1 '"type":"turn_context"' '${transcript}'`,
            );
            assert.match(firstTurn, /"approval_policy":"never"/u);
            assert.match(firstTurn, /"sandbox_policy":\{"type":"danger-full-access"/u);
            yield* machine.nudge(`archive ${id}`);
            return started;
          }),
        ),
      ),
    );
    yield* machine.shell(`cp ${savedState} ${GLOBAL_STATE}`);

    const helperFile = outcome.helperRollout.split("/").at(-1) ?? "";
    const helperEnding = yield* machine.shell(
      `grep -ho -m1 -E '"type":"(task_complete|turn_aborted)"' $(find ~/.codex/sessions ~/.codex/archived_sessions -name '${helperFile}')`,
    );
    assert.equal(helperEnding, '"type":"turn_aborted"');
    const unconfirmedStops = (yield* spansMentioning({
      machine,
      text: "nudge.codex.interrupt.confirmed",
    })).filter(
      (span) =>
        span.name === "codex.stopTurn" &&
        span.attributes.some(
          (attribute) =>
            attribute.key === "nudge.codex.interrupt.confirmed" &&
            attribute.value.boolValue === false,
        ),
    );
    assert.ok(
      unconfirmedStops.length > 0,
      "nudge never saw Codex Desktop leave a stop unconfirmed",
    );
  }),
);
