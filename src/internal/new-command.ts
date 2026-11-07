import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { Claude } from "../lib/claude/index.ts";
import { Codex } from "../lib/codex/index.ts";
import { AGENTS } from "../shared/agents.ts";
import { ModelOrEffortMissing, requireOfferedModel } from "../shared/model-choice.ts";
import { Output } from "../shared/output.ts";
import { homePath, prose } from "../shared/report.ts";
import { describeKind, describeSession } from "../shared/session.ts";
import {
  jsonFlag,
  readText,
  requireNudgeOutsideSandbox,
  requireUsableName,
} from "./command-arguments.ts";
import { VALUE_FLAGS } from "./command-flags.ts";
import { PromptEmpty, PromptMissing } from "./errors.ts";
import { findSender } from "./find-sender.ts";

export const newCommand = Command.make(
  "new",
  {
    agent: Argument.Literals("agent", AGENTS),
    prompt: Argument.String("prompt").pipe(Argument.optional),
    name: VALUE_FLAGS.name.pipe(
      Flag.withDescription(
        "Name the session. Without it, Claude names a Claude session itself, which can take a moment.",
      ),
      Flag.optional,
    ),
    model: VALUE_FLAGS.model.pipe(
      Flag.withDescription("Start it with this model. Required."),
      Flag.optional,
    ),
    effort: VALUE_FLAGS.effort.pipe(
      Flag.withDescription(
        "Start it with this reasoning effort. Required unless the model has none.",
      ),
      Flag.optional,
    ),
    speed: VALUE_FLAGS.speed.pipe(
      Flag.withDescription(
        "Run the session at this speed: standard or fast. Without it, nudge runs it at standard.",
      ),
      Flag.withDefault("standard"),
    ),
    json: jsonFlag,
  },
  Effect.fn("nudge.new", { attributes: { "nudge.command": "new" } })(function* ({
    agent,
    prompt,
    name,
    model,
    effort,
    speed,
  }) {
    if (Option.isSome(name)) {
      yield* requireUsableName(name.value);
    }
    const given = yield* readText(prompt, {
      empty: new PromptEmpty(),
      missing: new PromptMissing(),
    });
    yield* requireNudgeOutsideSandbox;
    const output = yield* Output;
    const provider = agent === "codex" ? yield* Codex : yield* Claude;
    const offered = yield* provider.listModels;
    yield* requireOfferedModel({
      agent,
      model,
      effort,
      currentModel: Option.none(),
      speed: Option.some(speed),
      attempt: "starting",
      models: offered,
    });
    const chosen = offered.find((known) => Option.contains(model, known.model));
    const isEffortNeeded = Option.isNone(effort) && chosen?.efforts.length !== 0;
    const missing = [
      ...(Option.isNone(model) ? (["--model"] as const) : []),
      ...(isEffortNeeded ? (["--effort"] as const) : []),
    ];
    if (missing.length > 0) {
      return yield* new ModelOrEffortMissing({ missing, agent, models: offered });
    }
    const sender = yield* findSender;
    const created = yield* provider.create({
      prompt: given,
      sender,
      name,
      model,
      effort,
      speed,
    });
    yield* Effect.forEach(created.warnings, (warning) => output.warn(warning), {
      discard: true,
    });
    const started = {
      provider: agent === "codex" ? ("Codex" as const) : ("Claude" as const),
      id: created.id,
    };
    yield* Effect.annotateCurrentSpan({
      "nudge.session.id": created.id,
      "nudge.provider": started.provider,
      "nudge.warning.count": created.warnings.length,
    });
    const startedSession = Option.match(created.name, {
      onNone: () => prose`an unnamed ${describeKind(started.provider)} (${started.id})`,
      onSome: (createdName) => describeSession({ ...started, name: createdName }),
    });
    const directory = homePath(created.directory);
    const whereStarted = created.isOutsideAnyProject
      ? prose`Started ${startedSession} in ${directory}, because ${homePath(process.cwd())} isn't a Codex Desktop project.`
      : prose`Started ${startedSession} in ${directory}.`;
    yield* output.print({
      shown: whereStarted,
      json: {
        action: "new",
        provider: agent,
        target: {
          id: created.id,
          name: Option.getOrNull(created.name),
          cwd: created.directory,
        },
      },
    });
  }),
).pipe(
  Command.withDescription(
    "Start a session with a prompt as its first message.\n\n<agent> is codex, for a session in Codex Desktop, or claude, for a Claude Code background session. Without [prompt], or with -, nudge reads the prompt from stdin.\n\nA Codex session starts in the current folder if that folder is a Codex Desktop project, and otherwise in a new folder that Codex Desktop makes. A Claude session starts in the current folder.",
  ),
);
