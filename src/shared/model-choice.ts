import { Effect, Option, Runtime, Schema } from "effect";

import { AGENTS, APP_NAMES, PROVIDER_NAMES } from "./agents.ts";
import { columns } from "./columns.ts";
import { messageOf, prose, quoted, Report, showOnTerminal } from "./report.ts";
import type { Shown } from "./report.ts";
import { isFastRequest } from "./speed.ts";
import type { Speed } from "./speed.ts";

export const USAGE_EXIT_CODE = 2;

export const OfferedModel = Schema.Struct({
  model: Schema.String,
  efforts: Schema.Array(Schema.String),
  fast: Schema.Boolean,
});

const Agent = Schema.Literals(AGENTS);

const Attempt = Schema.Literals(["starting", "sending"]);

const UNCHANGED = {
  starting: "nudge didn't start the session",
  sending: "nudge didn't send the message",
} as const;

const reportWithModels = ({
  message,
  models,
  missing = [],
}: {
  readonly message: Shown;
  readonly models: readonly (typeof OfferedModel.Type)[];
  readonly missing?: readonly string[];
}) =>
  new Report({
    message,
    details: {
      show: () =>
        columns([
          ["MODEL", "EFFORTS", "FAST"],
          ...models.map(({ model, efforts, fast }) => [
            showOnTerminal(model),
            efforts.length === 0 ? "none" : showOnTerminal(efforts.join(", ")),
            fast ? "yes" : "no",
          ]),
        ]),
    },
    data: {
      ...(missing.length === 0 ? {} : { missing: [...missing] }),
      models: models.map(({ model, efforts, fast }) => ({ model, efforts: [...efforts], fast })),
    },
  });

export class ModelOrEffortMissing extends Schema.TaggedError<ModelOrEffortMissing>()(
  "ModelOrEffortMissing",
  {
    missing: Schema.Array(Schema.Literals(["--model", "--effort"])),
    agent: Agent,
    models: Schema.Array(OfferedModel),
  },
) {
  public override readonly [Runtime.errorExitCode] = USAGE_EXIT_CODE;

  public get report(): Report {
    return reportWithModels({
      message: prose`nudge new needs ${this.missing.join(" and ")}. ${APP_NAMES[this.agent]} offers:`,
      models: this.models,
      missing: this.missing,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class ModelUnknown extends Schema.TaggedError<ModelUnknown>()("ModelUnknown", {
  agent: Agent,
  model: Schema.String,
  attempt: Attempt,
  models: Schema.Array(OfferedModel),
}) {
  public override readonly [Runtime.errorExitCode] = USAGE_EXIT_CODE;

  public get report(): Report {
    return reportWithModels({
      message: prose`${PROVIDER_NAMES[this.agent]} has no model ${quoted(this.model)}, so ${UNCHANGED[this.attempt]}. ${APP_NAMES[this.agent]} offers:`,
      models: this.models,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class EffortUnsupported extends Schema.TaggedError<EffortUnsupported>()(
  "EffortUnsupported",
  {
    agent: Agent,
    model: Schema.String,
    effort: Schema.String,
    attempt: Attempt,
    models: Schema.Array(OfferedModel),
  },
) {
  public override readonly [Runtime.errorExitCode] = USAGE_EXIT_CODE;

  public get report(): Report {
    return reportWithModels({
      message: prose`${PROVIDER_NAMES[this.agent]}'s model ${quoted(this.model)} has no reasoning effort ${quoted(this.effort)}, so ${UNCHANGED[this.attempt]}. ${APP_NAMES[this.agent]} offers:`,
      models: this.models,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class FastModeUnsupported extends Schema.TaggedError<FastModeUnsupported>()(
  "FastModeUnsupported",
  {
    agent: Agent,
    model: Schema.String,
    attempt: Attempt,
    models: Schema.Array(OfferedModel),
  },
) {
  public override readonly [Runtime.errorExitCode] = USAGE_EXIT_CODE;

  public get report(): Report {
    return reportWithModels({
      message: prose`${PROVIDER_NAMES[this.agent]}'s model ${quoted(this.model)} has no Fast mode, so ${UNCHANGED[this.attempt]}. ${APP_NAMES[this.agent]} offers:`,
      models: this.models,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class EffortUnknown extends Schema.TaggedError<EffortUnknown>()("EffortUnknown", {
  agent: Agent,
  effort: Schema.String,
  attempt: Attempt,
  models: Schema.Array(OfferedModel),
}) {
  public override readonly [Runtime.errorExitCode] = USAGE_EXIT_CODE;

  public get report(): Report {
    return reportWithModels({
      message: prose`${PROVIDER_NAMES[this.agent]} has no reasoning effort ${quoted(this.effort)}, so ${UNCHANGED[this.attempt]}. ${APP_NAMES[this.agent]} offers:`,
      models: this.models,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export const requireOfferedModel = Effect.fn("requireOfferedModel")(function* ({
  agent,
  model,
  effort,
  currentModel,
  speed,
  attempt,
  models,
}: {
  readonly agent: typeof Agent.Type;
  readonly model: Option.Option<string>;
  readonly effort: Option.Option<string>;
  readonly currentModel: Option.Option<string>;
  readonly speed: Option.Option<typeof Speed.Type>;
  readonly attempt: typeof Attempt.Type;
  readonly models: readonly (typeof OfferedModel.Type)[];
}) {
  const checked = Option.isSome(model) ? model : currentModel;
  const found = models.find((offered) => Option.contains(checked, offered.model));
  if (found === undefined) {
    if (Option.isSome(model)) {
      return yield* new ModelUnknown({ agent, model: model.value, attempt, models });
    }
    const isUnknownEffort =
      Option.isSome(effort) && !models.some((offered) => offered.efforts.includes(effort.value));
    if (isUnknownEffort) {
      return yield* new EffortUnknown({ agent, effort: effort.value, attempt, models });
    }
    return;
  }
  const isUnsupported = Option.isSome(effort) && !found.efforts.includes(effort.value);
  if (isUnsupported) {
    return yield* new EffortUnsupported({
      agent,
      model: found.model,
      effort: effort.value,
      attempt,
      models,
    });
  }
  const lacksFastMode = isFastRequest(speed) && !found.fast;
  if (lacksFastMode) {
    return yield* new FastModeUnsupported({ agent, model: found.model, attempt, models });
  }
});
