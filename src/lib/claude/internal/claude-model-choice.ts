import { Effect, Option, Schema } from "effect";

import { foldLinesFromEnd } from "../../../shared/transcript.ts";
import { AssistantEntry, replySpeedOf } from "./claude-transcript.ts";

const REQUEST_MARKER = '"type":"api-request"';

const REPLY_MARKER = '"type":"assistant"';

const SYNTHETIC_MODEL = "<synthetic>";

const SPEED_NAMES = { fast: "Fast", standard: "Standard" } as const;

const RequestedChoice = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.Literal("api-request"),
    id: Schema.optional(Schema.NullOr(Schema.String)),
    params: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          output_config: Schema.optional(
            Schema.NullOr(Schema.Struct({ effort: Schema.optional(Schema.NullOr(Schema.String)) })),
          ),
        }),
      ),
    ),
  }),
);

const decodeRequestedChoice = Schema.decodeUnknownOption(RequestedChoice);

const decodeReply = Schema.decodeUnknownOption(AssistantEntry);

const requestOf = (line: string) =>
  line.includes(REQUEST_MARKER) ? decodeRequestedChoice(line) : Option.none();

const replyOf = (line: string) =>
  line.includes(REPLY_MARKER)
    ? Option.filter(decodeReply(line), (reply) => {
        const isFromTheApi = reply.message.model !== SYNTHETIC_MODEL;
        return isFromTheApi && reply.isApiErrorMessage !== true;
      })
    : Option.none();

const NOTHING_FOUND = {
  reply: Option.none<typeof AssistantEntry.Type>(),
  request: Option.none<typeof RequestedChoice.Type>(),
};

const effortOfReply = (reply: typeof AssistantEntry.Type) => Option.fromNullishOr(reply.effort);

const isRequestOf = ({
  reply,
  request,
}: {
  readonly reply: typeof AssistantEntry.Type;
  readonly request: typeof RequestedChoice.Type;
}) =>
  Option.match(Option.fromNullishOr(reply.requestRef), {
    onNone: () => true,
    onSome: (requestRef) => request.id === requestRef,
  });

const stepBackThroughTranscript = (found: typeof NOTHING_FOUND, line: string) => {
  if (Option.isNone(found.reply)) {
    const reply = replyOf(line);
    const needsRequest = Option.isSome(reply) && Option.isNone(effortOfReply(reply.value));
    return { state: { ...found, reply }, isDone: Option.isSome(reply) && !needsRequest };
  }
  const reply = found.reply.value;
  const request = Option.filter(requestOf(line), (candidate) =>
    isRequestOf({ reply, request: candidate }),
  );
  return { state: { ...found, request }, isDone: Option.isSome(request) };
};

const choiceOf = ({ reply, request }: typeof NOTHING_FOUND) => ({
  model: Option.flatMap(reply, ({ message }) => Option.fromNullishOr(message.model)),
  effort: Option.orElse(Option.flatMap(reply, effortOfReply), () =>
    Option.flatMap(request, ({ params: parameters }) =>
      Option.fromNullishOr(parameters?.output_config?.effort),
    ),
  ),
  speed: Option.map(Option.flatMap(reply, replySpeedOf), (speed) => SPEED_NAMES[speed]),
});

export const readClaudeModelChoice = (transcript: Option.Option<string>) =>
  Option.match(transcript, {
    onNone: () => Effect.succeed(choiceOf(NOTHING_FOUND)),
    onSome: (path) =>
      Effect.map(
        foldLinesFromEnd({
          path,
          initial: NOTHING_FOUND,
          step: (found, line) => Effect.succeed(stepBackThroughTranscript(found, line)),
        }),
        choiceOf,
      ),
  });
