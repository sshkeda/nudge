import { BunServices } from "@effect/platform-bun";
import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import { Cause, Effect, Exit, Layer, Match, Option, Runtime, Schema } from "effect";
import { CliConfig, CliError, CliOutput, Command, Flag, GlobalFlag } from "effect/cli";
import type { HelpDoc } from "effect/cli/HelpDoc";

import { version } from "../../package.json" with { type: "json" };
import { claudeLayer } from "../lib/claude/index.ts";
import { codexLayer } from "../lib/codex/index.ts";
import { platformLayer } from "../lib/platform/index.ts";
import { AGENTS, APP_NAMES } from "../shared/agents.ts";
import { Output, outputLayerFor } from "../shared/output.ts";
import { linePrinter } from "../shared/print-line.ts";
import { HOME } from "../shared/read-environment.ts";
import { Audience } from "../shared/report.ts";
import { BUILD_COMMIT } from "./build-commit.ts";
import {
  describeUsageErrors,
  findUnknownShortFlagError,
  formatUsageErrors,
} from "./cli-diagnostics.ts";
import { hintFor } from "./command-arguments.ts";
import { BUILT_IN_FLAGS, namesOf } from "./command-flags.ts";
import { isJsonRequested, positionalsOf, withoutFlags } from "./command-line.ts";
import { commandWords, HELP_COMMAND } from "./command-words.ts";
import { FailureReported, PROGRAM } from "./errors.ts";
import { formatHelpDoc } from "./format-help.ts";
import { traceLayer } from "./record-traces.ts";
import { SUBCOMMANDS, subcommandOf } from "./subcommands.ts";

const nudge = Command.make(PROGRAM).pipe(
  Command.withSubcommands(SUBCOMMANDS),
  Command.withDescription(
    `List, start and message ${AGENTS.map((agent) => APP_NAMES[agent]).join(" and ")} sessions.`,
  ),
);

const HELP_FLAGS: ReadonlySet<string> = new Set(namesOf(BUILT_IN_FLAGS.help));

const wordsToParse = (words: readonly string[]) => {
  const [first] = positionalsOf(words);
  const isUnknownCommand =
    subcommandOf(words) === undefined && first !== undefined && first.value !== HELP_COMMAND;
  return isUnknownCommand ? withoutFlags(words, HELP_FLAGS) : words;
};

const helpFlag = GlobalFlag.Action({
  flag: BUILT_IN_FLAGS.help.pipe(Flag.withDescription("Show this help."), Flag.withDefault(false)),
  run: GlobalFlag.Help.run,
});

const versionWithCommit = Option.match(BUILD_COMMIT, {
  onNone: () => version,
  onSome: (commit) => `${version} (${commit})`,
});

const versionFlag = GlobalFlag.Action({
  flag: BUILT_IN_FLAGS.version.pipe(
    Flag.withDescription("Print nudge's version."),
    Flag.withDefault(false),
  ),
  run: GlobalFlag.Version.run,
});

const outputLayer = Layer.unwrap(
  Effect.gen(function* () {
    const words = yield* commandWords;
    const home = yield* HOME;
    return outputLayerFor(
      Audience.make({ mode: isJsonRequested(words) ? "json" : "terminal", home }),
    );
  }),
);

export const nudgeLayer = Layer.mergeAll(
  CliConfig.layer({ builtIns: [helpFlag, versionFlag] }),
  CliOutput.layer({
    formatHelpDoc: (doc: HelpDoc) => formatHelpDoc(doc),
    formatCliError: (error) => formatUsageErrors([error]),
    formatError: (error) => formatUsageErrors([error]),
    formatErrors: formatUsageErrors,
    formatVersion: (_name, nudgeVersion) => nudgeVersion,
  }),
  claudeLayer,
  codexLayer,
  Layer.unwrap(
    Effect.map(commandWords, (words) =>
      subcommandOf(words) === "doctor" ? Layer.empty : traceLayer,
    ),
  ),
).pipe(
  Layer.provideMerge(outputLayer),
  Layer.provideMerge(platformLayer),
  Layer.provideMerge(Layer.mergeAll(BunServices.layer, BunCrypto.layerSecureRandom)),
);

const reportFailure = (failure: Error) =>
  Effect.gen(function* () {
    const words = yield* commandWords;
    const described = Schema.is(CliError.ShowHelp)(failure)
      ? describeUsageErrors({ commandPath: failure.commandPath, errors: failure.errors, words })
      : failure;
    yield* Effect.annotateCurrentSpan("nudge.error", described.name);
    yield* (yield* Output).fail(described, {
      hint: hintFor({ failure: described, words }),
    });
    return yield* new FailureReported({ exitCode: Runtime.getErrorExitCode(described) });
  });

const bufferCliOutput = <Value, Failure, Requirements>(
  effect: Effect.Effect<Value, Failure, Requirements>,
) =>
  Effect.gen(function* () {
    const formatter = yield* CliOutput.Formatter;
    const writes: { readonly isError: boolean; readonly text: string }[] = [];
    const write = (isError: boolean, text: string) =>
      Effect.sync(() => {
        writes.push({ isError, text });
      });
    const exit = yield* effect.pipe(
      Effect.provideService(CliOutput.Presenter, {
        present: (event) =>
          Match.valueTags(event, {
            Help: ({ helpDoc }) => write(false, formatter.formatHelpDoc(helpDoc)),
            InvalidInvocation: ({ helpDoc, errors }) =>
              write(false, formatter.formatHelpDoc(helpDoc)).pipe(
                Effect.andThen(write(true, formatter.formatErrors(errors))),
              ),
            Version: ({ name, version: shownVersion }) =>
              write(false, formatter.formatVersion(name, shownVersion)),
          }),
      }),
      Effect.exit,
    );
    return { exit, writes };
  });

const printBuffered = ({
  writes,
  includeOutput,
}: {
  readonly writes: readonly { readonly isError: boolean; readonly text: string }[];
  readonly includeOutput: boolean;
}) =>
  Effect.gen(function* () {
    const { printLine, printErrorLine } = yield* linePrinter;
    yield* Effect.forEach(
      writes.filter((write) => write.isError || includeOutput),
      (write) => (write.isError ? printErrorLine(write.text) : printLine(write.text)),
      { discard: true },
    );
  });

export const runNudge = Effect.gen(function* () {
  yield* Effect.void.pipe(Effect.withSpan("nudge.start"));
  const words = yield* commandWords;
  const unknownShortFlag = findUnknownShortFlagError(words);
  if (Option.isSome(unknownShortFlag)) {
    return yield* reportFailure(unknownShortFlag.value);
  }
  const { exit, writes } = yield* bufferCliOutput(
    Command.runWith(nudge, { version: versionWithCommit, renderErrors: false })(
      wordsToParse(words),
    ),
  );
  if (Exit.isSuccess(exit)) {
    return yield* printBuffered({ writes, includeOutput: true });
  }
  const failure = Cause.findErrorOption(exit.cause);
  const isShowHelp = Option.isSome(failure) && Schema.is(CliError.ShowHelp)(failure.value);
  const isHelpOnly = isShowHelp && failure.value.errors.length === 0;
  const isUsageFailure = isShowHelp && !isHelpOnly;
  yield* printBuffered({ writes, includeOutput: !isUsageFailure });
  if (Option.isNone(failure)) {
    return yield* Effect.failCause(exit.cause);
  }
  if (isHelpOnly) {
    return;
  }
  if (Schema.is(FailureReported)(failure.value)) {
    return yield* failure.value;
  }
  return yield* reportFailure(failure.value);
}).pipe(Effect.withSpan("nudge", { attributes: { "nudge.version": version } }));
