import { Effect, Option, Schema } from "effect";

import { toOneLine } from "../../../shared/print-line.ts";
import { runCommand } from "../../../shared/run-command.ts";
import {
  ClaudeModelListFailed,
  ClaudeModelListMissing,
  ClaudeNotOnPath,
  orClaudeMissing,
} from "./errors.ts";

const LIST_MODELS = [
  "claude",
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
] as const;

const DEFAULT_MODEL = "default";

const encodeInitializeRequest = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literal("control_request"),
      requestId: Schema.String,
      request: Schema.Struct({ subtype: Schema.Literal("initialize") }),
    }).pipe(Schema.encodeKeys({ requestId: "request_id" })),
  ),
);

const decodeInitializeAnswer = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literal("control_response"),
      response: Schema.Struct({
        response: Schema.Struct({
          models: Schema.Array(
            Schema.Struct({
              value: Schema.String,
              supportedEffortLevels: Schema.optional(Schema.Array(Schema.String)),
              supportsFastMode: Schema.optional(Schema.Boolean),
            }),
          ),
        }),
      }),
    }),
  ),
);

export const listClaudeModels = Effect.fn("claude.listModels")(function* () {
  const [program, ...programArguments] = LIST_MODELS;
  const failed = (failure: string) =>
    new ClaudeModelListFailed({ command: LIST_MODELS, failure: toOneLine(failure) });
  const request = yield* encodeInitializeRequest({
    type: "control_request",
    requestId: "nudge-models",
    request: { subtype: "initialize" },
  });
  const output = yield* runCommand(program, programArguments, { input: `${request}\n` }).pipe(
    Effect.catchReason("PlatformError", "NotFound", (notFound) =>
      orClaudeMissing(notFound, () => new ClaudeNotOnPath({ attempt: "listing-models" })),
    ),
    Effect.catchTags({
      CommandFailed: (command) =>
        Effect.fail(
          failed(
            command.standardError.trim() === ""
              ? `exit code ${command.exitCode}`
              : command.standardError,
          ),
        ),
      PlatformError: (error) => Effect.fail(failed(error.message)),
    }),
  );
  const answer = output
    .split("\n")
    .flatMap((line) => Option.toArray(decodeInitializeAnswer(line)))
    .at(0);
  if (answer === undefined) {
    return yield* new ClaudeModelListMissing({ command: LIST_MODELS });
  }
  return answer.response.response.models
    .filter((offered) => offered.value !== DEFAULT_MODEL)
    .map((offered) => ({
      model: offered.value,
      efforts: offered.supportedEffortLevels ?? [],
      fast: offered.supportsFastMode === true,
    }));
});
