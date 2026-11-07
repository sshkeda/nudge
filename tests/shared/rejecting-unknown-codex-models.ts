import assert from "node:assert/strict";

import { Effect, Schema } from "effect";

import { BOGUS_CODEX_MODEL } from "../../scripts/shared/aimock.ts";
import { columns } from "../../src/shared/columns.ts";
import { machineTest, NUDGE, quoteForShell, USAGE_EXIT_CODE } from "./machine-commands.ts";

const BOGUS_EFFORT = "nudge-bogus-effort";

const FAST_TIERS: ReadonlySet<string> = new Set(["priority", "fast", "ultrafast"]);

const MOCK_REPLY = "Mocked reply.";

const TURN_ENDED = '"type":"task_complete"';

const Catalog = Schema.fromJsonString(
  Schema.Struct({
    models: Schema.Array(
      Schema.Struct({
        slug: Schema.String,
        visibility: Schema.String,
        supported_reasoning_levels: Schema.Array(Schema.Struct({ effort: Schema.String })),
        service_tiers: Schema.optional(
          Schema.NullOr(Schema.Array(Schema.Struct({ id: Schema.String }))),
        ),
      }),
    ),
  }),
);

const AppliedModel = Schema.fromJsonString(
  Schema.Struct({
    payload: Schema.Struct({ thread_settings: Schema.Struct({ model: Schema.String }) }),
  }),
);

export const rejectingUnknownCodexModels = machineTest((machine) =>
  Effect.gen(function* () {
    const { models } = yield* Schema.decodeEffect(Catalog)(
      yield* machine.shell(`${quoteForShell(machine.codexCli)} debug models`),
    );
    const listed = models.filter((model) => model.visibility === "list");
    const effortsOf = (slug: string) =>
      listed
        .find((model) => model.slug === slug)
        ?.supported_reasoning_levels.map((level) => level.effort) ?? [];
    const offered = columns([
      ["MODEL", "EFFORTS", "FAST"],
      ...listed.map((model) => {
        const efforts = effortsOf(model.slug);
        const fast = (model.service_tiers ?? []).some((tier) => FAST_TIERS.has(tier.id));
        return [
          model.slug,
          efforts.length === 0 ? "none" : efforts.join(", "),
          fast ? "yes" : "no",
        ];
      }),
    ]);
    const refused = (message: string) => ({
      code: USAGE_EXIT_CODE,
      standardOutput: "",
      standardError: `error: ${message} Codex Desktop offers:\n\n${offered}`,
    });
    const allEfforts = new Set(listed.flatMap((model) => effortsOf(model.slug)));
    const narrowModel = listed.find((model) =>
      [...allEfforts].some((effort) => !effortsOf(model.slug).includes(effort)),
    );
    assert.ok(narrowModel, "every Codex model supports every reasoning effort");
    const missingEffort = [...allEfforts].find(
      (effort) => !effortsOf(narrowModel.slug).includes(effort),
    );
    assert.ok(missingEffort !== undefined);

    assert.deepEqual(
      yield* machine.attempt(
        `${NUDGE} new codex 'hello' --name 'Nudge Bogus Codex Model' --model ${BOGUS_CODEX_MODEL} --effort medium`,
      ),
      refused(`Codex has no model "${BOGUS_CODEX_MODEL}", so nudge didn't start the session.`),
    );
    assert.doesNotMatch(yield* machine.nudge("list"), /Nudge Bogus Codex Model/u);
    assert.deepEqual(
      yield* machine.attempt(
        `${NUDGE} new codex 'hello' --name 'Nudge Bogus Codex Effort' --model gpt-6-astra --effort ${BOGUS_EFFORT}`,
      ),
      refused(
        `Codex's model "gpt-6-astra" has no reasoning effort "${BOGUS_EFFORT}", so nudge didn't start the session.`,
      ),
    );
    assert.doesNotMatch(yield* machine.nudge("list"), /Nudge Bogus Codex Effort/u);

    const codexId = yield* machine.start("codex 'hello' --name 'Nudge Model Check'");
    yield* machine.waitUntilIdle(codexId);
    const transcript = quoteForShell((yield* machine.showJson(codexId)).target.transcript);
    const appliedModel = Effect.flatMap(
      machine.shell(`grep '"type":"thread_settings_applied"' ${transcript} | tail -n 1`),
      Schema.decodeEffect(AppliedModel),
    ).pipe(Effect.map((applied) => applied.payload.thread_settings.model));
    const modelBefore = yield* appliedModel;
    const sizeBefore = yield* machine.shell(`wc -c < ${transcript}`);
    const countTurns = Effect.map(
      machine.shell(`grep -c -F '${TURN_ENDED}' ${transcript}`),
      (count) => Number(count),
    );
    const turnsBefore = yield* countTurns;

    assert.deepEqual(
      yield* machine.attempt(
        `${NUDGE} send ${codexId} --model ${BOGUS_CODEX_MODEL} 'switch to a model Codex lacks'`,
      ),
      refused(`Codex has no model "${BOGUS_CODEX_MODEL}", so nudge didn't send the message.`),
    );
    assert.deepEqual(
      yield* machine.attempt(
        `${NUDGE} send ${codexId} --model ${narrowModel.slug} --effort ${missingEffort} 'switch to an effort the model lacks'`,
      ),
      refused(
        `Codex's model "${narrowModel.slug}" has no reasoning effort "${missingEffort}", so nudge didn't send the message.`,
      ),
    );
    assert.deepEqual(
      yield* machine.attempt(
        `${NUDGE} send ${codexId} --effort ${BOGUS_EFFORT} 'switch to an effort no model has'`,
      ),
      refused(
        `Codex's model "${modelBefore}" has no reasoning effort "${BOGUS_EFFORT}", so nudge didn't send the message.`,
      ),
    );
    assert.equal(yield* machine.shell(`wc -c < ${transcript}`), sizeBefore);
    assert.equal((yield* machine.showJson(codexId)).target.status, "idle");

    assert.equal(
      yield* machine.nudge(`send ${codexId} 'still working?'`),
      `Sent the message to Codex session "Nudge Model Check" (${codexId}).`,
    );
    yield* machine.waitUntilIdle(codexId);
    assert.equal(yield* countTurns, turnsBefore + 1);
    const lastTurnEnd = yield* machine.shell(`grep -F '${TURN_ENDED}' ${transcript} | tail -n 1`);
    assert.ok(lastTurnEnd.includes(`"last_agent_message":"${MOCK_REPLY}"`), lastTurnEnd);
    assert.equal(yield* appliedModel, modelBefore);
    const otherModel = listed.find((model) => model.slug !== modelBefore);
    assert.ok(otherModel, "Codex Desktop offers only one model");
    assert.equal(
      yield* machine.nudge(`send ${codexId} --model ${otherModel.slug} 'switch to another model'`),
      `Sent the message to Codex session "Nudge Model Check" (${codexId}).`,
    );
    yield* machine.waitUntilIdle(codexId);
    assert.equal(yield* appliedModel, otherModel.slug);
    yield* machine.nudge(`archive ${codexId}`);
  }),
);
