import { Array as EffectArray, Effect, FileSystem, Option, Schema } from "effect";
import type { Context } from "effect";

import type { Output } from "../../../shared/output.ts";
import { toOneLine } from "../../../shared/print-line.ts";
import {
  foldLinesFromEnd,
  makeAppendedLineReader,
  readByteLength,
  START_OF_FILE,
} from "../../../shared/transcript.ts";
import { ClaudeTranscriptHasNoDirectory, ClaudeTranscriptLineUnreadable } from "./errors.ts";

const TranscriptEntry = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.String,
    subtype: Schema.optional(Schema.String),
    cwd: Schema.optional(Schema.String),
    timestamp: Schema.optional(Schema.String),
  }),
);

export const AssistantEntry = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.Literal("assistant"),
    isApiErrorMessage: Schema.optional(Schema.Boolean),
    requestRef: Schema.optional(Schema.NullOr(Schema.String)),
    effort: Schema.optional(Schema.NullOr(Schema.String)),
    message: Schema.Struct({
      model: Schema.optional(Schema.String),
      stop_reason: Schema.optional(Schema.NullOr(Schema.String)),
      content: Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) })),
      usage: Schema.optional(
        Schema.NullOr(Schema.Struct({ speed: Schema.optional(Schema.NullOr(Schema.String)) })),
      ),
    }),
  }),
);

const ReplySpeed = Schema.Literals(["fast", "standard"]);

const isReplySpeed = Schema.is(ReplySpeed);

export const replySpeedOf = (reply: typeof AssistantEntry.Type) =>
  Option.filter(Option.fromNullishOr(reply.message.usage?.speed), isReplySpeed);

const TRANSCRIPT_EXTENSION = ".jsonl";

const TURN_DURATION = "turn_duration";

const MessageIdOrigin = Schema.Struct({ messageId: Schema.String }).pipe(
  Schema.encodeKeys({ messageId: "msg_id" }),
);

const QueuedPrompt = Schema.Struct({
  type: Schema.Literal("queue-operation"),
  operation: Schema.Literal("enqueue"),
  content: Schema.String,
});

const TypedPrompt = Schema.Struct({
  type: Schema.Literal("user"),
  message: Schema.Struct({ content: Schema.String }),
});

const DeliveryRecord = Schema.Union([
  Schema.Struct({ origin: MessageIdOrigin }),
  Schema.Struct({ attachment: Schema.Struct({ origin: MessageIdOrigin }) }),
  QueuedPrompt,
  TypedPrompt,
]);

const decodeDeliveryRecord = Schema.decodeOption(Schema.fromJsonString(DeliveryRecord));

export const isPeerMessage = ({
  record,
  messageId,
}: {
  readonly record: typeof DeliveryRecord.Type;
  readonly messageId: string;
}) =>
  ("origin" in record && record.origin.messageId === messageId) ||
  ("attachment" in record && record.attachment.origin.messageId === messageId);

export const isQueued = ({
  record,
  content,
}: {
  readonly record: typeof DeliveryRecord.Type;
  readonly content: string;
}) => "operation" in record && record.content === content;

export const isTyped = ({
  record,
  content,
}: {
  readonly record: typeof DeliveryRecord.Type;
  readonly content: string;
}) => "message" in record && record.message.content === content;

const transcriptLength = (transcript: Option.Option<string>) =>
  Option.match(transcript, {
    onNone: () => Effect.succeed(START_OF_FILE),
    onSome: readByteLength,
  });

const globProjects = ({
  root,
  fileSystem,
  pattern,
}: {
  readonly root: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly pattern: string;
}) =>
  fileSystem.glob(`projects/${pattern}`, { root }).pipe(
    Effect.map((found) => found.map((relativePath) => `${root}/${relativePath}`)),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])),
  );

export const findTranscript = ({
  root,
  fileSystem,
  id,
}: {
  readonly root: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly id: string;
}) =>
  Effect.map(
    globProjects({ root, fileSystem, pattern: `*/${id}${TRANSCRIPT_EXTENSION}` }),
    EffectArray.head,
  );

export const listTranscripts = ({
  root,
  fileSystem,
}: {
  readonly root: string;
  readonly fileSystem: FileSystem.FileSystem;
}) =>
  Effect.map(
    globProjects({ root, fileSystem, pattern: `*/*${TRANSCRIPT_EXTENSION}` }),
    (transcripts) =>
      new Map(
        transcripts
          .toSorted((left, right) => left.localeCompare(right))
          .map((transcript) => [
            transcript.slice(transcript.lastIndexOf("/") + 1, -TRANSCRIPT_EXTENSION.length),
            transcript,
          ]),
      ),
  );

const RecordedEntry = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.String,
    timestamp: Schema.optional(Schema.String),
    agentName: Schema.optional(Schema.String),
  }),
);

const decodeRecordedEntry = Schema.decodeUnknownOption(RecordedEntry);

const MESSAGE_TYPES: ReadonlySet<string> = new Set(["assistant", "user"]);

const AGENT_NAME = "agent-name";

const findFromEnd = <Found>({
  path,
  find,
}: {
  readonly path: string;
  readonly find: (entry: typeof RecordedEntry.Type) => Option.Option<Found>;
}) =>
  foldLinesFromEnd({
    path,
    initial: Option.none<Found>(),
    step: (_nothingYet, line) => {
      const found = Option.flatMap(decodeRecordedEntry(line), find);
      return Effect.succeed({ state: found, isDone: Option.isSome(found) });
    },
  });

export const readLastMessageTime = (path: string) =>
  findFromEnd({
    path,
    find: (entry) =>
      MESSAGE_TYPES.has(entry.type)
        ? Option.filter(
            Option.map(Option.fromUndefinedOr(entry.timestamp), Date.parse),
            Number.isFinite,
          )
        : Option.none(),
  });

export const readAgentName = (path: string) =>
  findFromEnd({
    path,
    find: (entry) =>
      entry.type === AGENT_NAME
        ? Option.filter(
            Option.map(Option.fromUndefinedOr(entry.agentName), (name) => name.trim()),
            (name) => name !== "",
          )
        : Option.none(),
  });

const BridgeRecord = Schema.fromJsonString(
  Schema.Struct({ type: Schema.Literal("bridge-session"), bridgeSessionId: Schema.String }),
);

const decodeBridgeRecord = Schema.decodeUnknownOption(BridgeRecord);

export const readLastBridgeId = (path: string) =>
  foldLinesFromEnd({
    path,
    initial: Option.none<string>(),
    step: (_nothingYet, line) => {
      const found = Option.map(decodeBridgeRecord(line), (record) => record.bridgeSessionId);
      return Effect.succeed({ state: found, isDone: Option.isSome(found) });
    },
  });

const HEAD_BYTES = 65_536;

const OriginEntry = Schema.fromJsonString(
  Schema.Struct({
    entrypoint: Schema.optional(Schema.String),
    sessionKind: Schema.optional(Schema.String),
    parentUuid: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);

const decodeOriginEntry = Schema.decodeUnknownOption(OriginEntry);

const PROGRAMMATIC_ENTRYPOINTS: ReadonlySet<string> = new Set(["sdk-cli", "sdk-ts", "sdk-py"]);

const PROGRAMMATIC_KINDS: ReadonlySet<string> = new Set(["daemon", "daemon-worker"]);

export const isProgrammaticRun = ({
  entrypoint,
  kind,
}: {
  readonly entrypoint: string | undefined;
  readonly kind: string | undefined;
}) =>
  (entrypoint !== undefined && PROGRAMMATIC_ENTRYPOINTS.has(entrypoint)) ||
  (kind !== undefined && PROGRAMMATIC_KINDS.has(kind));

export const isProgrammaticTranscript = (path: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const head = yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fileSystem.open(path);
        return yield* file.readAlloc(HEAD_BYTES);
      }),
    ).pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone));
    const entries = Option.match(head, {
      onNone: () => [],
      onSome: (bytes) =>
        new TextDecoder()
          .decode(bytes)
          .split("\n")
          .flatMap((line) => Option.toArray(decodeOriginEntry(line))),
    });
    const entrypoint = entries.find((entry) => entry.entrypoint !== undefined)?.entrypoint;
    const kind = entries.find((entry) => entry.parentUuid !== undefined)?.sessionKind;
    return isProgrammaticRun({ entrypoint, kind });
  });

export const transcriptPaths = ({
  root,
  fileSystem,
  id,
}: {
  readonly root: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly id: string;
}) =>
  Effect.gen(function* () {
    const transcript = yield* findTranscript({ root, fileSystem, id });
    if (Option.isSome(transcript)) {
      return [transcript.value];
    }
    return [`${root}/projects`, ...(yield* globProjects({ root, fileSystem, pattern: "*" }))];
  });

export const decodeTranscriptLines = ({
  nudgeOutput,
  path,
  lines,
}: {
  readonly nudgeOutput: Output["Service"];
  readonly path: string;
  readonly lines: readonly string[];
}) =>
  Effect.forEach(lines, (line) =>
    Schema.decodeEffect(TranscriptEntry)(line).pipe(
      Effect.flatMap((entry) =>
        entry.type === "assistant"
          ? Schema.decodeEffect(AssistantEntry)(line).pipe(
              Effect.map((assistant) => ({ ...entry, assistant: Option.some(assistant) })),
            )
          : Effect.succeed({ ...entry, assistant: Option.none() }),
      ),
      Effect.asSome,
      Effect.catchTag("SchemaError", (error) =>
        nudgeOutput
          .warnOnce({
            key: path,
            warning: new ClaudeTranscriptLineUnreadable({
              path,
              reason: toOneLine(error.message),
            }),
          })
          .pipe(Effect.as(Option.none())),
      ),
    ),
  ).pipe(Effect.map(EffectArray.getSomes));

const turnEndOf = (entry: Effect.Success<ReturnType<typeof decodeTranscriptLines>>[number]) => {
  const endsTurn = entry.type === "system" && entry.subtype === TURN_DURATION;
  if (endsTurn) {
    return Option.some(true);
  }
  if (entry.type === "user") {
    return Option.some(false);
  }
  return Option.map(entry.assistant, (assistant) => assistant.message.stop_reason !== "tool_use");
};

export const isTurnFinished = ({
  nudgeOutput,
  services,
  transcript,
}: {
  readonly nudgeOutput: Output["Service"];
  readonly services: Context.Context<FileSystem.FileSystem>;
  readonly transcript: Option.Option<string>;
}) =>
  Option.match(transcript, {
    onNone: () => Effect.succeed(true),
    onSome: (path) =>
      foldLinesFromEnd({
        path,
        initial: Option.none<{ readonly timestamp: string; readonly isFinished: boolean }>(),
        step: (latest, line) =>
          Effect.map(decodeTranscriptLines({ nudgeOutput, path, lines: [line] }), ([entry]) => {
            if (entry?.timestamp === undefined) {
              return { state: latest, isDone: false };
            }
            const { timestamp } = entry;
            const isOlderThanLatest = Option.exists(
              latest,
              (found) => timestamp.localeCompare(found.timestamp) <= 0,
            );
            if (isOlderThanLatest) {
              return { state: latest, isDone: true };
            }
            const turnEnd = turnEndOf(entry);
            return {
              state: Option.isSome(turnEnd)
                ? Option.some({ timestamp, isFinished: turnEnd.value })
                : latest,
              isDone: false,
            };
          }),
      }).pipe(Effect.map(Option.exists((latest) => latest.isFinished)), Effect.provide(services)),
  });

export const readWorkingDirectory = ({
  fileSystem,
  nudgeOutput,
  transcript,
}: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly nudgeOutput: Output["Service"];
  readonly transcript: string;
}) =>
  Effect.gen(function* () {
    const text = yield* fileSystem.readFileString(transcript);
    const lines = text.split("\n").slice(0, -1);
    const entries = yield* decodeTranscriptLines({ nudgeOutput, path: transcript, lines });
    const workingDirectory = entries.find((entry) => entry.cwd !== undefined)?.cwd;
    if (workingDirectory === undefined) {
      return yield* new ClaudeTranscriptHasNoDirectory({ transcript });
    }
    return workingDirectory;
  });

export const makeNewRecordCheck = ({
  root,
  fileSystem,
  id,
}: {
  readonly root: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly id: string;
}) =>
  Effect.gen(function* () {
    const transcriptBefore = yield* findTranscript({ root, fileSystem, id });
    const readNewLines = yield* makeAppendedLineReader(yield* transcriptLength(transcriptBefore));
    return (isDelivery: (record: typeof DeliveryRecord.Type) => boolean) =>
      Effect.gen(function* () {
        const transcript = Option.isSome(transcriptBefore)
          ? transcriptBefore
          : yield* findTranscript({ root, fileSystem, id });
        if (Option.isNone(transcript)) {
          return false;
        }
        return (yield* readNewLines(transcript.value)).some((line) =>
          Option.exists(decodeDeliveryRecord(line), (record) => isDelivery(record)),
        );
      });
  });
