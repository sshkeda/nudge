import assert from "node:assert/strict";

import { Effect } from "effect";

import { startCodexDesktop } from "../../scripts/shared/codex-desktop.ts";
import { FAILED_EXIT_CODE, machineTest, NUDGE } from "./machine-commands.ts";

const DESKTOP_SOCKET = "~/.codex/ipc/ipc.sock";

const SECONDS_BEFORE_QUITTING = 10;

const failed = ({ reason, hint }: { readonly reason: string; readonly hint?: string }) => ({
  code: FAILED_EXIT_CODE,
  standardOutput: "",
  standardError: `error: can't ask Codex Desktop for thread-owner-discovery at ${DESKTOP_SOCKET}: ${reason}${hint === undefined ? "" : `\nhint: ${hint}`}`,
});

export const failingToReachCodexDesktop = machineTest((machine) =>
  Effect.gen(function* () {
    const socket = `${machine.home}/.codex/ipc/ipc.sock`;
    const release = `${machine.scratch}/release-unreachable-turn`;
    const pausingDesktop = Effect.gen(function* () {
      const desktop = yield* machine.shell(`pgrep -o -f '${machine.mainProcess}'`);
      return yield* Effect.acquireRelease(machine.shell(`kill -STOP ${desktop}`), () =>
        machine.shell(`kill -CONT ${desktop} 2> /dev/null || true`).pipe(
          Effect.catchTags({
            CommandFailed: () => Effect.void,
            CommandNotStarted: () => Effect.void,
            CommandStandardInputFailed: () => Effect.void,
            PlatformError: () => Effect.void,
          }),
        ),
      );
    });

    const id = yield* Effect.scoped(
      Effect.gen(function* () {
        yield* startCodexDesktop();
        const started = yield* machine.start("codex 'hello from nudge' --name 'Unreachable Codex'");
        yield* machine.waitUntilIdle(started);
        yield* machine.nudge(`send ${started} 'HOLD_UNTIL: ${release}'`);
        const showing = machine.attempt(`${NUDGE} show ${started}`);
        assert.equal((yield* machine.showJson(started)).target.status, "running");

        const { hung, doctor } = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* pausingDesktop;
            return { hung: yield* showing, doctor: yield* machine.attempt(`${NUDGE} doctor`) };
          }),
        );
        assert.deepEqual(
          hung,
          failed({
            reason: "Codex Desktop did not answer thread-owner-discovery within 30 seconds",
          }),
        );
        assert.equal(doctor.code, 0, doctor.standardOutput);
        assert.doesNotMatch(doctor.standardOutput, /^error: /mu);
        assert.equal((yield* machine.showJson(started)).target.status, "running");

        const quitMidCall = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* pausingDesktop;
            return yield* machine.attempt(
              `(sleep ${SECONDS_BEFORE_QUITTING}; ${machine.quitCodex}) > /dev/null 2>&1 & ${NUDGE} show ${started}`,
            );
          }),
        );
        yield* machine.shell(machine.quitCodex);
        assert.deepEqual(
          quitMidCall,
          failed({ reason: "Codex Desktop closed the connection before answering" }),
        );
        return started;
      }),
    );

    assert.equal(
      yield* machine.shell(
        `{ test -S ${socket} && echo socket; test -e ~/.codex/thread-writer-locks/${id}.lock && echo lock; } | paste -sd ' ' -`,
      ),
      "socket lock",
    );
    assert.deepEqual(
      yield* machine.attempt(`${NUDGE} show ${id}`),
      failed({ reason: `connect ECONNREFUSED ${socket}`, hint: "nudge doctor" }),
    );
    const doctor = yield* machine.attempt(`${NUDGE} doctor`);
    assert.equal(doctor.code, FAILED_EXIT_CODE, doctor.standardOutput);
    assert.match(doctor.standardOutput, /^error: Codex Desktop isn't running$/mu);

    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* startCodexDesktop();
        assert.equal((yield* machine.showJson(id)).target.status, "idle");
        yield* machine.shell(`touch ${release}`);
        yield* machine.nudge(`archive ${id}`);
      }),
    );
  }),
);
