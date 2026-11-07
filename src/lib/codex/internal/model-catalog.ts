import { Effect, Option, Schema } from "effect";
import type { FileSystem, PlatformError } from "effect";

import { FastModeUnsupported, requireOfferedModel } from "../../../shared/model-choice.ts";
import { toOneLine } from "../../../shared/print-line.ts";
import { runCommand } from "../../../shared/run-command.ts";
import { isFastRequest } from "../../../shared/speed.ts";
import type { Speed } from "../../../shared/speed.ts";
import { Platform } from "../../platform/index.ts";
import { CodexModelListFailed, CodexModelListMissing, CodexModelsUnreadable } from "./errors.ts";
import { FAST_TIERS } from "./service-tier.ts";

const LISTED = "list";

const CatalogModel = Schema.Struct({
  slug: Schema.String,
  visibility: Schema.String,
  supported_reasoning_levels: Schema.Array(Schema.Struct({ effort: Schema.String })),
  service_tiers: Schema.optional(Schema.NullOr(Schema.Array(Schema.Struct({ id: Schema.String })))),
});

const Catalog = Schema.fromJsonString(Schema.Struct({ models: Schema.Array(CatalogModel) }));

const readCatalog = Effect.fn("codex.readModelCatalog")(function* <Failed, Unreadable>({
  failed,
  unreadable,
}: {
  readonly failed: (command: readonly string[], failure: string) => Failed;
  readonly unreadable: (command: readonly string[], reason: string) => Unreadable;
}) {
  const command = [(yield* Platform).codexDesktop.codex, "debug", "models"] as const;
  const [program, ...programArguments] = command;
  const listing = yield* runCommand(program, programArguments).pipe(
    Effect.catchTags({
      CommandFailed: (exited) =>
        Effect.fail(
          failed(
            command,
            exited.standardError.trim() === ""
              ? `exit code ${exited.exitCode}`
              : toOneLine(exited.standardError),
          ),
        ),
      PlatformError: (error) => Effect.fail(failed(command, toOneLine(error.message))),
    }),
  );
  return yield* Schema.decodeEffect(Catalog)(listing).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.fail(unreadable(command, toOneLine(error.message))),
    ),
  );
});

const hasFastTier = (known: typeof CatalogModel.Type) =>
  (known.service_tiers ?? []).some((tier) => FAST_TIERS.has(tier.id));

const offeredIn = (models: readonly (typeof CatalogModel.Type)[]) =>
  models
    .filter((known) => known.visibility === LISTED)
    .map((known) => ({
      model: known.slug,
      efforts: known.supported_reasoning_levels.map((level) => level.effort),
      fast: hasFastTier(known),
    }));

export const requireCatalogModel = Effect.fn("codex.requireCatalogModel")(function* ({
  models,
  model,
  effort,
  currentModel,
  speed,
}: {
  readonly models: readonly (typeof CatalogModel.Type)[];
  readonly model: Option.Option<string>;
  readonly effort: Option.Option<string>;
  readonly currentModel: Option.Option<string>;
  readonly speed: Option.Option<typeof Speed.Type>;
}) {
  const offered = offeredIn(models);
  yield* requireOfferedModel({
    agent: "codex",
    model,
    effort,
    currentModel,
    speed,
    attempt: "sending",
    models: offered,
  });
  const hiddenCurrent = models.find(
    (known) => known.visibility !== LISTED && Option.contains(currentModel, known.slug),
  );
  const lacksFastMode =
    isFastRequest(speed) && hiddenCurrent !== undefined && !hasFastTier(hiddenCurrent);
  if (lacksFastMode) {
    return yield* new FastModeUnsupported({
      agent: "codex",
      model: hiddenCurrent.slug,
      attempt: "sending",
      models: offered,
    });
  }
});

export const listOfferedModels = Effect.fn("codex.listOfferedModels")(function* () {
  const { models } = yield* readCatalog({
    failed: (command, failure) => new CodexModelListFailed({ command, failure }),
    unreadable: (command) => new CodexModelListMissing({ command }),
  });
  return offeredIn(models);
});

const modelsUnreadable = (command: readonly string[], reason: string) =>
  new CodexModelsUnreadable({ command, reason });

export const requireKnownModel = Effect.fn("codex.requireKnownModel")(function* ({
  model,
  effort,
  speed,
  currentModel,
}: {
  readonly model: Option.Option<string>;
  readonly effort: Option.Option<string>;
  readonly speed: Option.Option<typeof Speed.Type>;
  readonly currentModel: Effect.Effect<
    Option.Option<string>,
    PlatformError.PlatformError,
    FileSystem.FileSystem
  >;
}) {
  const isNothingToCheck = Option.isNone(model) && Option.isNone(effort) && !isFastRequest(speed);
  if (isNothingToCheck) {
    return;
  }
  const current = Option.isNone(model) ? yield* currentModel : Option.none<string>();
  yield* Effect.annotateCurrentSpan({
    "nudge.codex.model.checked": Option.isSome(model) || Option.isSome(current),
    "nudge.codex.model.fromTask": Option.isSome(current),
  });
  const { models } = yield* readCatalog({ failed: modelsUnreadable, unreadable: modelsUnreadable });
  yield* requireCatalogModel({ models, model, effort, currentModel: current, speed });
});
