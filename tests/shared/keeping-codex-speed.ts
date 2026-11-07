import assert from "node:assert/strict";

import { Effect, Schema } from "effect";

import { BUN, PROJECT } from "../../scripts/shared/codex-and-claude.ts";
import {
  CLAUDE_MODEL_AND_EFFORT,
  CODEX_MODEL_AND_EFFORT,
  FAILED_EXIT_CODE,
  machineTest,
  NUDGE,
  USAGE_EXIT_CODE,
} from "./machine-commands.ts";

const FAST_TIER = "priority";

const STANDARD_TIER = "default";

const TURN_STARTED = "started";

const Speed = Schema.fromJsonString(
  Schema.Struct({
    speed: Schema.NullOr(Schema.String),
    target: Schema.Struct({ transcript: Schema.String }),
  }),
);

const Started = Schema.fromJsonString(
  Schema.Struct({ target: Schema.Struct({ id: Schema.String }) }),
);

const HAIKU_WITHOUT_FAST =
  /^error: Claude's model "haiku" has no Fast mode, so nudge didn't start the session\. Claude Code offers:\n\nMODEL +EFFORTS +FAST\n(?:.*\n)*haiku +.* no$/mu;

const FAST_CLAUDE_ANSWERED_STANDARD =
  /^error: Claude session "Fast Claude" \([^)]+\) started, but Claude answered in Standard mode, not Fast mode$/mu;

const CONFIG = "~/.codex/config.toml";

const CONFIG_BEFORE_THE_TEST = "~/.codex/config.toml.before-keeping-codex-speed";

const switchToFast = (threadId: string) => `cd '${PROJECT}' && ${BUN} -e '
    import { BunServices } from "@effect/platform-bun";
    import * as BunCrypto from "@effect/platform-bun/BunCrypto";
    import { Effect, Layer } from "effect";
    import { askCodexDesktop, requireSuccess } from "./src/lib/codex/internal/codex-desktop-ipc.ts";
    const method = "thread-follower-update-thread-settings";
    const update = askCodexDesktop({
      socket: process.env.HOME + "/.codex/ipc/ipc.sock",
      method, version: 2,
      parameters: { conversationId: "${threadId}", threadSettings: { serviceTier: "${FAST_TIER}" } }
    });
    const applied = update.pipe(Effect.flatMap((answer) => requireSuccess({ method, answer })));
    console.log(JSON.stringify(await Effect.runPromise(applied.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(BunServices.layer, BunCrypto.layerSecureRandom))))));'`;

export const keepingCodexSpeed = machineTest((machine) =>
  Effect.gen(function* () {
    const speedOf = (id: string) =>
      Effect.flatMap(machine.nudge(`show --json ${id}`), Schema.decodeEffect(Speed));
    const checkLatestTurn = (id: string, wanted: string) =>
      Effect.gen(function* () {
        const { transcript } = (yield* speedOf(id)).target;
        const events = (yield* machine.shell(
          `grep -E '"type":"(thread_settings_applied|task_started)"' '${transcript}' | sed -E 's/.*"type":"task_started".*/${TURN_STARTED}/; s/.*"service_tier":"([a-z]+)".*/\\1/; s/.*"thread_settings_applied".*/${STANDARD_TIER}/' | paste -sd ' ' -`,
        )).split(" ");
        const start = events.lastIndexOf(TURN_STARTED);
        const isFirstTurn = start === 0;
        const chosenAt = isFirstTurn ? start + 1 : start - 1;
        const chosen = events[chosenAt] ?? "";
        const later = events.slice(Math.max(chosenAt, start) + 1);
        const changes = later.filter((tier, index) => tier !== (later[index - 1] ?? chosen));
        assert.deepEqual(changes, chosen === wanted ? [] : [wanted], events.join(" "));
        return chosen;
      });

    const parent = yield* machine.start("codex 'hello from the parent' --name 'Fast Parent'");
    yield* machine.waitUntilIdle(parent);
    assert.equal((yield* speedOf(parent)).speed, "standard");
    assert.equal(yield* machine.shell(switchToFast(parent)), '{"applied":true}');
    assert.equal((yield* speedOf(parent)).speed, "fast");

    const childRun = yield* machine.attempt(
      `CODEX_THREAD_ID=${parent} ${NUDGE} new --json codex ${CODEX_MODEL_AND_EFFORT} 'hello from the child' --name 'Child Of Fast'`,
    );
    assert.equal(childRun.code, 0, childRun.standardError);
    const child = (yield* Schema.decodeEffect(Started)(childRun.standardOutput)).target.id;
    yield* machine.waitUntilIdle(child);
    assert.equal((yield* speedOf(child)).speed, "standard");
    assert.notEqual(yield* checkLatestTurn(child, STANDARD_TIER), FAST_TIER);

    const fastRun = yield* Schema.decodeEffect(Started)(
      yield* machine.nudge(
        `new --json codex ${CODEX_MODEL_AND_EFFORT} 'hello in Fast mode' --name 'Started Fast' --speed fast`,
      ),
    );
    yield* machine.waitUntilIdle(fastRun.target.id);
    assert.equal((yield* speedOf(fastRun.target.id)).speed, "fast");
    yield* checkLatestTurn(fastRun.target.id, FAST_TIER);

    assert.equal(
      yield* machine.nudge(`send ${fastRun.target.id} 'still fast'`),
      `Sent the message to Codex session "Started Fast" (${fastRun.target.id}).`,
    );
    yield* machine.waitUntilIdle(fastRun.target.id);
    assert.equal((yield* speedOf(fastRun.target.id)).speed, "fast");
    yield* checkLatestTurn(fastRun.target.id, FAST_TIER);

    assert.equal(
      yield* machine.nudge(`send ${child} 'still standard'`),
      `Sent the message to Codex session "Child Of Fast" (${child}).`,
    );
    yield* machine.waitUntilIdle(child);
    assert.equal((yield* speedOf(child)).speed, "standard");
    yield* checkLatestTurn(child, STANDARD_TIER);
    assert.deepEqual(yield* machine.attempt(`${NUDGE} send --speed fast ${child} 'go fast'`), {
      code: 0,
      standardOutput: `Sent the message to Codex session "Child Of Fast" (${child}).`,
      standardError: "",
    });
    yield* machine.waitUntilIdle(child);
    assert.equal((yield* speedOf(child)).speed, "fast");
    assert.equal(yield* checkLatestTurn(child, FAST_TIER), FAST_TIER);

    const standardRun = yield* machine.attempt(
      `${NUDGE} send --speed standard ${child} 'back to standard'`,
    );
    assert.equal(standardRun.code, 0, standardRun.standardError);
    assert.equal(
      standardRun.standardOutput,
      `Sent the message to Codex session "Child Of Fast" (${child}).`,
    );
    yield* machine.waitUntilIdle(child);
    assert.equal((yield* speedOf(child)).speed, "standard");
    assert.equal(standardRun.standardError, "");
    assert.equal(yield* checkLatestTurn(child, STANDARD_TIER), STANDARD_TIER);
    assert.equal(
      yield* machine.nudge(`send ${child} 'stay standard'`),
      `Sent the message to Codex session "Child Of Fast" (${child}).`,
    );
    yield* machine.waitUntilIdle(child);
    assert.equal((yield* speedOf(child)).speed, "standard");
    yield* checkLatestTurn(child, STANDARD_TIER);

    const fastClaudeRun = yield* machine.attempt(
      `${NUDGE} new claude ${CLAUDE_MODEL_AND_EFFORT} 'hello in Fast mode' --name 'Fast Claude' --speed fast`,
    );
    assert.equal(fastClaudeRun.code, FAILED_EXIT_CODE, fastClaudeRun.standardError);
    assert.match(fastClaudeRun.standardError, FAST_CLAUDE_ANSWERED_STANDARD);
    const fastClaude = (yield* machine.showJson("Fast Claude")).target.id;
    const standardClaude = yield* machine.start(
      "claude 'hello in Standard mode' --name 'Standard Claude'",
    );
    yield* machine.waitUntilIdle(fastClaude, standardClaude);
    yield* machine.transcriptHas({ target: fastClaude, texts: ['"speed":"fast"'] });
    assert.equal((yield* speedOf(fastClaude)).speed, "standard");
    assert.equal((yield* speedOf(standardClaude)).speed, "standard");
    const { transcript: standardTranscript } = (yield* machine.showJson(standardClaude)).target;
    assert.doesNotMatch(yield* machine.shell(`cat '${standardTranscript}'`), /"speed":"fast"/u);

    const fastHaiku = yield* machine.attempt(
      `${NUDGE} new claude --model haiku --effort medium 'hello in Fast mode with Haiku' --name 'Fast Haiku' --speed fast`,
    );
    assert.equal(fastHaiku.code, USAGE_EXIT_CODE, fastHaiku.standardError);
    assert.equal(fastHaiku.standardOutput, "");
    assert.match(fastHaiku.standardError, HAIKU_WITHOUT_FAST);
    assert.doesNotMatch(yield* machine.nudge("list"), /Fast Haiku/u);

    const defaultFast = yield* Effect.acquireUseRelease(
      machine.shell(
        `cp ${CONFIG} ${CONFIG_BEFORE_THE_TEST} && { printf 'service_tier = "${FAST_TIER}"\\n'; cat ${CONFIG_BEFORE_THE_TEST}; } > ${CONFIG}`,
      ),
      () =>
        Effect.gen(function* () {
          const startRun = yield* machine.attempt(
            `${NUDGE} new --json codex ${CODEX_MODEL_AND_EFFORT} 'hello with Fast as the default' --name 'Default Fast'`,
          );
          assert.equal(startRun.code, 0, startRun.standardError);
          const id = (yield* Schema.decodeEffect(Started)(startRun.standardOutput)).target.id;
          yield* machine.waitUntilIdle(id);
          assert.equal((yield* speedOf(id)).speed, "standard");
          assert.equal(
            startRun.standardError,
            (yield* checkLatestTurn(id, STANDARD_TIER)) === FAST_TIER
              ? `warning: Codex Desktop started Codex session ${id} in Fast mode, its default speed, so nudge switched it to Standard, but its first model request may already have run in Fast mode`
              : "",
          );

          const sendRun = yield* machine.attempt(`${NUDGE} send ${id} 'stay standard'`);
          assert.equal(sendRun.code, 0, sendRun.standardError);
          assert.equal(
            sendRun.standardOutput,
            `Sent the message to Codex session "Default Fast" (${id}).`,
          );
          yield* machine.waitUntilIdle(id);
          assert.equal((yield* speedOf(id)).speed, "standard");
          assert.equal(
            sendRun.standardError,
            (yield* checkLatestTurn(id, STANDARD_TIER)) === FAST_TIER
              ? `warning: Codex Desktop started the turn for this message in Fast mode, its default speed, so nudge switched Codex session ${id} back to Standard, but the turn's first model request may already have run in Fast mode`
              : "",
          );

          const release = `${machine.scratch}/release-default-fast`;
          yield* machine.nudge(`send ${id} 'HOLD_UNTIL: ${release}'`);
          assert.equal((yield* machine.showJson(id)).target.status, "running");
          assert.deepEqual(yield* machine.attempt(`${NUDGE} send ${id} 'queued while busy'`), {
            code: 0,
            standardOutput: `Sent the message to Codex session "Default Fast" (${id}), which is in the middle of a turn, so it reads the message after its current step.`,
            standardError: `warning: nudge couldn't confirm the speed of Codex session ${id} within 3 seconds, so Codex Desktop may run this message at its default speed instead of Standard mode`,
          });
          assert.deepEqual(
            yield* machine.attempt(`${NUDGE} send --speed fast ${id} 'fast while busy'`),
            {
              code: 0,
              standardOutput: `Sent the message to Codex session "Default Fast" (${id}), which is in the middle of a turn, so it reads the message after its current step.`,
              standardError: `warning: nudge switched Codex session ${id} to Fast, but it's in the middle of a turn, which keeps running in Standard mode until it ends`,
            },
          );
          yield* machine.shell(`touch ${release}`);
          yield* machine.transcriptHas({
            target: id,
            texts: ["queued while busy", "fast while busy"],
          });
          yield* machine.waitUntilIdle(id);
          assert.equal((yield* speedOf(id)).speed, "fast");
          yield* checkLatestTurn(id, FAST_TIER);
          return id;
        }),
      () => machine.shell(`mv ${CONFIG_BEFORE_THE_TEST} ${CONFIG}`),
    );

    yield* Effect.forEach(
      [parent, child, fastRun.target.id, defaultFast, fastClaude, standardClaude],
      (id) => machine.nudge(`archive ${id}`),
      {
        discard: true,
      },
    );
  }),
);
