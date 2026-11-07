import assert from "node:assert/strict";

import { Task } from "@sshkeda/task";
import { Effect, Option } from "effect";

import {
  requireCatalogModel,
  requireKnownModel,
} from "../../src/lib/codex/internal/model-catalog.ts";
import { platformLayer } from "../../src/lib/platform/index.ts";

const catalogModel = ({
  slug,
  visibility,
  tiers,
}: {
  readonly slug: string;
  readonly visibility: string;
  readonly tiers: readonly string[] | null;
}) => ({
  slug,
  visibility,
  supported_reasoning_levels: [{ effort: "medium" }],
  service_tiers: tiers?.map((id) => ({ id })) ?? null,
});

const MODELS = [
  catalogModel({ slug: "nudge-fast", visibility: "list", tiers: ["priority"] }),
  catalogModel({ slug: "nudge-standard", visibility: "list", tiers: [] }),
  catalogModel({ slug: "nudge-hidden-fast", visibility: "hide", tiers: ["priority"] }),
  catalogModel({ slug: "nudge-hidden-standard", visibility: "hide", tiers: null }),
] as const;

const CHOICES = [
  { model: "nudge-fast", current: null, speed: "fast", refused: null },
  { model: "nudge-standard", current: null, speed: null, refused: null },
  { model: "nudge-standard", current: null, speed: "standard", refused: null },
  { model: "nudge-standard", current: null, speed: "fast", refused: "nudge-standard" },
  { model: null, current: "nudge-standard", speed: "fast", refused: "nudge-standard" },
  { model: null, current: "nudge-standard", speed: "standard", refused: null },
  { model: null, current: "nudge-fast", speed: "fast", refused: null },
  { model: null, current: null, speed: "fast", refused: null },
  {
    model: null,
    current: "nudge-hidden-standard",
    speed: "fast",
    refused: "nudge-hidden-standard",
  },
  { model: null, current: "nudge-hidden-standard", speed: null, refused: null },
  { model: null, current: "nudge-hidden-standard", speed: "standard", refused: null },
  { model: null, current: "nudge-hidden-fast", speed: "fast", refused: null },
] as const;

export const refusingFastWithoutSupport = Task.make(
  "refusing-fast-without-support",
  Effect.gen(function* () {
    const judged = yield* Effect.forEach(CHOICES, (choice) =>
      requireCatalogModel({
        models: MODELS,
        model: Option.fromNullishOr(choice.model),
        effort: Option.none(),
        currentModel: Option.fromNullishOr(choice.current),
        speed: Option.fromNullishOr(choice.speed),
      }).pipe(
        Effect.as(null),
        Effect.catchTag("FastModeUnsupported", (refusal) => Effect.succeed(refusal.model)),
        Effect.map((refused) => ({
          model: choice.model,
          current: choice.current,
          speed: choice.speed,
          refused,
        })),
      ),
    );
    assert.deepEqual(judged, CHOICES);
    yield* requireKnownModel({
      model: Option.none(),
      effort: Option.none(),
      speed: Option.some("standard"),
      currentModel: Effect.die("a standard-only send read the session's model"),
    }).pipe(Effect.provide(platformLayer));
  }),
);
