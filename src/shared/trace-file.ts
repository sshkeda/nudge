import { DateTime, Duration, Effect, FileSystem, Layer, Path } from "effect";
import type { Duration as DurationInput } from "effect";
import { HttpBody, HttpClient, HttpClientResponse } from "effect/http";
import { OtlpSerialization, OtlpTracer } from "effect/observability";

import { name, version } from "../../package.json" with { type: "json" };
import { NUDGE_STATE_DIRECTORY } from "./read-environment.ts";

const TRACE_RETENTION_DAYS = 14;

const TRACE_FILE_NAME = /^(?<date>\d{4}-\d{2}-\d{2})\.jsonl$/u;

const PRIVATE_FILE_MODE = 0o600;

const PRIVATE_DIRECTORY_MODE = 0o700;

const NEWLINE = new TextEncoder().encode("\n");

const deleteOldTraceFiles = Effect.fn("deleteOldTraceFiles")(function* ({
  directory,
  today,
}: {
  readonly directory: string;
  readonly today: DateTime.Zoned;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const oldest = DateTime.formatIsoDate(
    DateTime.subtractDuration(today, Duration.days(TRACE_RETENTION_DAYS)),
  );
  const names = yield* fileSystem.readDirectory(directory);
  const isOld = (fileName: string) => {
    const date = TRACE_FILE_NAME.exec(fileName)?.groups?.["date"];
    return date !== undefined && date < oldest;
  };
  yield* Effect.annotateCurrentSpan(
    "nudge.trace.expired.count",
    names.filter((fileName) => isOld(fileName)).length,
  );
  yield* Effect.forEach(
    names.filter((fileName) => isOld(fileName)),
    (fileName) =>
      fileSystem
        .remove(path.join(directory, fileName))
        .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void)),
    { discard: true },
  );
});

export const openTodaysTraceFile = Effect.fn("openTodaysTraceFile")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const directory = `${yield* NUDGE_STATE_DIRECTORY}/traces`;
  const today = DateTime.setZone(yield* DateTime.now, DateTime.zoneMakeLocal());
  const file = `${directory}/${DateTime.formatIsoDate(today)}.jsonl`;
  yield* fileSystem.makeDirectory(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  yield* deleteOldTraceFiles({ directory, today });
  const handle = yield* fileSystem.open(file, { flag: "a", mode: PRIVATE_FILE_MODE });
  const append = (line: Uint8Array) => handle.writeAll(new Uint8Array([...line, ...NEWLINE]));
  return { file, append };
});

const NO_CONTENT_STATUS = 204;

const EXCEPTION_EVENT = "exception";

const EXCEPTION_TYPE = "exception.type";

const EXPORT_INTERVAL = "200 millis";

const RESOURCE = { serviceName: name, serviceVersion: version };

const withoutErrorText = (data: OtlpTracer.TraceData): OtlpTracer.TraceData => ({
  resourceSpans: data.resourceSpans.map((resourceSpan) => ({
    ...resourceSpan,
    scopeSpans: resourceSpan.scopeSpans.map((scopeSpan) => ({
      ...scopeSpan,
      spans: scopeSpan.spans.map((span) => {
        const events = span.events.map((event) =>
          event.name === EXCEPTION_EVENT
            ? {
                ...event,
                attributes: event.attributes.filter(
                  (attribute) => attribute.key === EXCEPTION_TYPE,
                ),
              }
            : event,
        );
        const [firstErrorType] = events.flatMap((event) =>
          event.attributes.flatMap((attribute) => {
            const errorType = "stringValue" in attribute.value ? attribute.value.stringValue : null;
            const isErrorType = attribute.key === EXCEPTION_TYPE && typeof errorType === "string";
            return isErrorType ? [errorType] : [];
          }),
        );
        const message = firstErrorType === undefined ? {} : { message: firstErrorType };
        return { ...span, events, status: { code: span.status.code, ...message } };
      }),
    })),
  })),
});

const errorTextFreeJson = Layer.succeed(OtlpSerialization.OtlpSerialization, {
  traces: (data) => HttpBody.jsonUnsafe(withoutErrorText(data)),
  metrics: (data) => HttpBody.jsonUnsafe(data),
  logs: (data) => HttpBody.jsonUnsafe(data),
});

export const TRACE_FILE_URL = "nudge:trace-file";

export const otlpTracerLayer = <Failure, Requirements>({
  url,
  httpClient,
  shutdownTimeout,
}: {
  readonly url: string;
  readonly httpClient: Layer.Layer<HttpClient.HttpClient, Failure, Requirements>;
  readonly shutdownTimeout?: DurationInput.Input;
}) =>
  OtlpTracer.layer({
    url,
    resource: RESOURCE,
    exportInterval: EXPORT_INTERVAL,
    ...(shutdownTimeout === undefined ? {} : { shutdownTimeout }),
  }).pipe(Layer.provide(httpClient), Layer.provide(errorTextFreeJson));

export const makeAppendingHttpClient = <Requirements>(
  appendLine: (line: Uint8Array) => Effect.Effect<void, never, Requirements>,
) =>
  Effect.map(Effect.context<Requirements>(), (context) =>
    HttpClient.make((request) =>
      (request.body instanceof HttpBody.Uint8Array
        ? appendLine(request.body.body)
        : Effect.void
      ).pipe(
        Effect.provide(context),
        Effect.as(
          HttpClientResponse.fromWeb(request, new Response(null, { status: NO_CONTENT_STATUS })),
        ),
      ),
    ),
  );
