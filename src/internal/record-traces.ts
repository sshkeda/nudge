import { Duration, Effect, Layer, Option, Ref, Result, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";

import {
  CodexHelperReply,
  isBlockedByCodexSandbox,
  RECORD_TRACES_METHOD,
  RecordTracesRequest,
  sendToCodexHelper,
} from "../shared/codex-helper.ts";
import { Output } from "../shared/output.ts";
import { CODEX_BRIDGE_SOCKET, OTEL_EXPORTER_OTLP_ENDPOINT } from "../shared/read-environment.ts";
import { messageOf, prose, Report } from "../shared/report.ts";
import {
  makeAppendingHttpClient,
  openTodaysTraceFile,
  otlpTracerLayer,
  TRACE_FILE_URL,
} from "../shared/trace-file.ts";

const COLLECTOR_SHUTDOWN_TIMEOUT = Duration.seconds(1);

const TRAILING_SLASHES = /\/+$/u;

const encodeRecordTracesRequest = Schema.encodeEffect(Schema.fromJsonString(RecordTracesRequest));

const decodeCodexHelperReply = Schema.decodeEffect(Schema.fromJsonString(CodexHelperReply));

class CodexHelperRefusedTraces extends Schema.TaggedError<CodexHelperRefusedTraces>()(
  "CodexHelperRefusedTraces",
  { reason: Schema.String },
) {
  public override get message() {
    return `the Codex helper couldn't record them: ${this.reason}`;
  }
}

const recordThroughCodexHelper = (line: Uint8Array) =>
  Effect.gen(function* () {
    const reply = yield* sendToCodexHelper({
      socket: yield* CODEX_BRIDGE_SOCKET,
      request: yield* encodeRecordTracesRequest({
        method: RECORD_TRACES_METHOD,
        parameters: { line: new TextDecoder().decode(line) },
      }),
    });
    const decoded = yield* decodeCodexHelperReply(reply);
    if ("error" in decoded) {
      return yield* new CodexHelperRefusedTraces({ reason: decoded.error.message });
    }
  });

class TracesNotRecorded extends Schema.TaggedError<TracesNotRecorded>()("TracesNotRecorded", {
  reason: Schema.String,
}) {
  public get report(): Report {
    return new Report({ message: prose`nudge didn't record traces: ${this.reason}` });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

const makeWarnOnce = Effect.gen(function* () {
  const output = yield* Output;
  const warned = yield* Ref.make(false);
  return (reason: string) =>
    Ref.getAndSet(warned, true).pipe(
      Effect.flatMap((wasWarned) =>
        wasWarned
          ? Effect.void
          : output
              .warn(new TracesNotRecorded({ reason }))
              .pipe(Effect.catchTag("PlatformError", () => Effect.void)),
      ),
    );
});

const appendThroughCodexHelper = ({
  fileFailure,
  warnOnce,
}: {
  readonly fileFailure: string;
  readonly warnOnce: Effect.Success<typeof makeWarnOnce>;
}) => {
  const warnBoth = (helperFailure: string) => warnOnce(`${fileFailure}, and ${helperFailure}`);
  return (line: Uint8Array) =>
    recordThroughCodexHelper(line).pipe(
      Effect.onInterrupt(() => warnBoth("the Codex helper didn't reply before nudge exited")),
      Effect.catchTag("CodexHelperUnreachable", (unreachable) =>
        Effect.flatMap(isBlockedByCodexSandbox(unreachable), (isBlocked) =>
          isBlocked ? Effect.void : warnBoth(unreachable.message),
        ),
      ),
      Effect.catchTags({
        CodexHelperClosedWithoutReply: (helperError) => warnBoth(helperError.message),
        CodexHelperRefusedTraces: (helperError) => warnBoth(helperError.message),
        ConfigError: (helperError) => warnBoth(helperError.message),
        SchemaError: (helperError) => warnBoth(helperError.message),
      }),
    );
};

const traceFileClient = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const warnOnce = yield* makeWarnOnce;
    const opened = yield* openTodaysTraceFile().pipe(
      Effect.map(Result.succeed),
      Effect.catchTags({
        ConfigError: (error) => Effect.succeed(Result.fail(error.message)),
        PlatformError: (error) => Effect.succeed(Result.fail(error.message)),
      }),
    );
    if (Result.isFailure(opened)) {
      return yield* makeAppendingHttpClient(
        appendThroughCodexHelper({ fileFailure: opened.failure, warnOnce }),
      );
    }
    const { file, append } = opened.success;
    return yield* makeAppendingHttpClient((line: Uint8Array) =>
      append(line).pipe(
        Effect.catchTag("PlatformError", (error) =>
          warnOnce(`can't write ${file}: ${error.message}`),
        ),
      ),
    );
  }),
);

export const traceLayer = Layer.unwrap(
  Effect.gen(function* () {
    const endpoint = yield* OTEL_EXPORTER_OTLP_ENDPOINT;
    return Option.match(endpoint, {
      onNone: () =>
        otlpTracerLayer({
          url: TRACE_FILE_URL,
          httpClient: traceFileClient,
        }),
      onSome: (baseUrl) =>
        otlpTracerLayer({
          url: `${baseUrl.replace(TRAILING_SLASHES, "")}/v1/traces`,
          httpClient: FetchHttpClient.layer,
          shutdownTimeout: COLLECTOR_SHUTDOWN_TIMEOUT,
        }),
    });
  }).pipe(
    Effect.catchTag("ConfigError", (error) =>
      Effect.gen(function* () {
        yield* (yield* Output).warn(new TracesNotRecorded({ reason: error.message }));
        return Layer.empty;
      }),
    ),
  ),
);
