import { spawn } from "node:child_process";
import { connect, createServer, Socket } from "node:net";

import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import * as BunStdio from "@effect/platform-bun/BunStdio";
import { Deferred, Effect, FileSystem, Layer, Option, Schema } from "effect";
import type { Path, PlatformError } from "effect";
import { HttpClient } from "effect/http";

import {
  APP_TOOLS_METHOD,
  APP_TOOLS_NAMESPACE,
  CodexHelperReply,
  FORWARDED_APP_TOOLS,
  RECORD_TRACES_METHOD,
  RecordTracesRequest,
} from "../../../shared/codex-helper.ts";
import { toOneLine } from "../../../shared/print-line.ts";
import {
  makeAppendingHttpClient,
  openTodaysTraceFile,
  otlpTracerLayer,
  TRACE_FILE_URL,
} from "../../../shared/trace-file.ts";
import { Platform, platformLayer } from "../../platform/index.ts";
import { serveMcp } from "./serve-mcp.ts";

const FRAME_LENGTH_BYTES = 4;
const OWNER_ONLY_UMASK = 0o077;
const OWNER_ONLY_DIRECTORY_MODE = 0o700;
const CODEX_ANSWER_TIMEOUT = "1 minute";

const ClientRequest = Schema.fromJsonString(
  Schema.Struct({ method: Schema.String, parameters: Schema.optional(Schema.Unknown) }).pipe(
    Schema.encodeKeys({ parameters: "params" }),
  ),
);

const UpstreamRequest = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.Int,
    jsonrpc: Schema.Literal("2.0"),
    method: Schema.String,
    parameters: Schema.optional(Schema.Unknown),
  }).pipe(Schema.encodeKeys({ parameters: "params" })),
);

const UpstreamReply = Schema.fromJsonString(Schema.Struct({ id: Schema.Int }));

const AppToolCall = Schema.Struct({ namespace: Schema.String, tool: Schema.String });

const decodeAppToolCall = Schema.decodeUnknownOption(AppToolCall);

const FORWARDED_TOOLS: ReadonlySet<string> = new Set(FORWARDED_APP_TOOLS);

const refuseUnlessForwarded = ({
  method,
  parameters,
}: {
  readonly method: string;
  readonly parameters?: unknown;
}) => {
  if (method !== APP_TOOLS_METHOD) {
    return Option.some(
      `the Codex helper forwards only ${APP_TOOLS_METHOD} requests, not ${toOneLine(method)}`,
    );
  }
  const call = decodeAppToolCall(parameters);
  if (Option.isNone(call)) {
    return Option.some("the Codex helper can't read the tool call");
  }
  const { namespace, tool } = call.value;
  if (namespace !== APP_TOOLS_NAMESPACE) {
    return Option.some(
      `the Codex helper forwards only ${APP_TOOLS_NAMESPACE} tools, not ${toOneLine(namespace)} tools`,
    );
  }
  if (!FORWARDED_TOOLS.has(tool)) {
    return Option.some(
      `the Codex helper doesn't forward Codex's ${toOneLine(tool)} tool, only ${FORWARDED_APP_TOOLS.join(", ")}`,
    );
  }
  return Option.none();
};

const decodeClientRequest = Schema.decodeUnknownOption(ClientRequest);
const encodeUpstreamRequest = Schema.encodeOption(UpstreamRequest);
const decodeUpstreamReply = Schema.decodeUnknownOption(UpstreamReply);

class CodexHelperFailed extends Schema.TaggedError<CodexHelperFailed>()("CodexHelperFailed", {
  operation: Schema.String,
  reason: Schema.String,
}) {
  public override get message() {
    return `the Codex helper couldn't ${this.operation}: ${this.reason}`;
  }
}

const logUnrecordedFailure = (message: string) =>
  Effect.logError(`error: can't record the Codex helper's error: ${message}`);

const helperTraceFile = Layer.effect(
  HttpClient.HttpClient,
  makeAppendingHttpClient((line) =>
    Effect.scoped(Effect.flatMap(openTodaysTraceFile(), ({ append }) => append(line))).pipe(
      Effect.catchTags({
        ConfigError: (error) => logUnrecordedFailure(error.message),
        PlatformError: (error) => logUnrecordedFailure(error.message),
      }),
    ),
  ),
);

const recordHelperFailure = ({
  operation,
  reason,
}: {
  readonly operation: string;
  readonly reason: string;
}) =>
  Effect.runPromise(
    Effect.fail(new CodexHelperFailed({ operation, reason: toOneLine(reason) })).pipe(
      Effect.withSpan("codexHelper.failure", {
        attributes: {
          "nudge.helper.operation": operation,
          "nudge.helper.error": toOneLine(reason),
        },
      }),
      Effect.catchTag("CodexHelperFailed", () => Effect.void),
      Effect.provide(
        otlpTracerLayer({ url: TRACE_FILE_URL, httpClient: helperTraceFile }).pipe(
          Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)),
        ),
      ),
    ),
  );

const runHelperStep = ({
  operation,
  step,
}: {
  readonly operation: string;
  readonly step: Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem>;
}) =>
  Effect.runPromise(
    step.pipe(
      Effect.catchTag("PlatformError", (error) =>
        Effect.promise(() => recordHelperFailure({ operation, reason: error.message })),
      ),
      Effect.provide(BunFileSystem.layer),
    ),
  );

const removeSocket = (socket: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* FileSystem.FileSystem).remove(socket, { force: true });
    }).pipe(Effect.provide(BunFileSystem.layer)),
  );

const frameOf = (body: string) => {
  const bytes = Buffer.from(body);
  const frame = Buffer.alloc(FRAME_LENGTH_BYTES + bytes.length);
  frame.writeUInt32LE(bytes.length, 0);
  bytes.copy(frame, FRAME_LENGTH_BYTES);
  return frame;
};

const randomId = () => crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;

const encodeReply = Schema.encodeEffect(Schema.fromJsonString(CodexHelperReply));

const sendReply = ({
  client,
  reply,
}: {
  readonly client: Socket;
  readonly reply: Effect.Effect<
    typeof CodexHelperReply.Type,
    never,
    FileSystem.FileSystem | Path.Path
  >;
}) =>
  Effect.runFork(
    reply.pipe(
      Effect.flatMap(encodeReply),
      Effect.flatMap((text) => Effect.sync(() => client.end(`${text}\n`))),
      Effect.catchTag("SchemaError", (error) => Effect.sync(() => client.destroy(error))),
      Effect.provide([BunFileSystem.layer, BunPath.layer]),
    ),
  );

const replyWithError = ({
  client,
  message,
}: {
  readonly client: Socket;
  readonly message: string;
}) => sendReply({ client, reply: Effect.succeed({ error: { message } }) });

const errorReply = (message: string) => ({ error: { message: toOneLine(message) } });

const recordTraces = ({ client, request }: { readonly client: Socket; readonly request: string }) =>
  sendReply({
    client,
    reply: Schema.decodeEffect(Schema.fromJsonString(RecordTracesRequest))(request).pipe(
      Effect.flatMap(({ parameters }) =>
        Effect.scoped(
          Effect.flatMap(openTodaysTraceFile(), ({ append }) =>
            append(new TextEncoder().encode(parameters.line)),
          ),
        ),
      ),
      Effect.as({ result: {} }),
      Effect.catchTags({
        ConfigError: (error) => Effect.succeed(errorReply(error.message)),
        PlatformError: (error) => Effect.succeed(errorReply(error.message)),
        SchemaError: (error) => Effect.succeed(errorReply(error.message)),
      }),
    ),
  });

const forwardCompleteFrames = ({
  buffer,
  forward,
}: {
  readonly buffer: Buffer;
  readonly forward: (body: string) => void;
}): Buffer => {
  const hasLength = buffer.length >= FRAME_LENGTH_BYTES;
  const end = hasLength ? FRAME_LENGTH_BYTES + buffer.readUInt32LE(0) : Number.POSITIVE_INFINITY;
  if (buffer.length < end) {
    return buffer;
  }
  forward(buffer.subarray(FRAME_LENGTH_BYTES, end).toString());
  return forwardCompleteFrames({ buffer: buffer.subarray(end), forward });
};

const lockTheAppToolsPipe = (directory: string) =>
  Effect.gen(function* () {
    yield* (yield* FileSystem.FileSystem)
      .makeDirectory(directory, { recursive: true, mode: OWNER_ONLY_DIRECTORY_MODE })
      .pipe(
        Effect.catchTag("PlatformError", (error) =>
          Effect.fail(
            new CodexHelperFailed({ operation: `make ${directory}`, reason: error.message }),
          ),
        ),
      );
    return yield* (yield* Platform)
      .lockCodexBridge(`${directory}codex.lock`)
      .pipe(
        Effect.catchTag("CodexBridgeLockFailed", ({ file, reason }) =>
          Effect.fail(new CodexHelperFailed({ operation: `lock ${file}`, reason })),
        ),
      );
  });

const lockTheAppToolsPipeOrExit = (directory: string) =>
  Effect.runPromise(
    lockTheAppToolsPipe(directory).pipe(
      Effect.tapError((error) =>
        Effect.promise(() =>
          recordHelperFailure({ operation: error.operation, reason: error.reason }),
        ),
      ),
      Effect.provide(platformLayer.pipe(Layer.provideMerge(BunServices.layer))),
      Effect.catchTags({
        CodexHelperFailed: () => Effect.succeedNone,
        PlatformUnsupported: () => Effect.succeedNone,
      }),
    ),
  ).then((lock) => {
    if (Option.isNone(lock)) {
      process.exit(0);
    }
    return lock.value;
  });

const serveTheAppToolsPipe = (directory: string) => {
  process.umask(OWNER_ONLY_UMASK);
  const socket = `${directory}codex.sock`;
  const upstream = new Socket({ fd: 3, readable: true, writable: true });
  const pending = new Map<number, (reply: string) => void>();
  const received: Buffer[] = [];
  const locks: { readonly release: Effect.Effect<void> }[] = [];

  const forwardReply = (body: string) => {
    Option.map(decodeUpstreamReply(body), ({ id }) => {
      pending.get(id)?.(body);
      pending.delete(id);
    });
  };

  upstream.on("data", (data) => {
    received.push(Buffer.from(data));
    const remainder = forwardCompleteFrames({
      buffer: Buffer.concat(received),
      forward: forwardReply,
    });
    received.splice(0, received.length, remainder);
  });
  upstream.on("close", () => {
    void Promise.all(
      locks.map((lock) => removeSocket(socket).then(() => Effect.runPromise(lock.release))),
    ).finally(() => process.exit(0));
  });

  const server = createServer((client) => {
    client.setEncoding("utf8");
    const chunks: string[] = [];
    client.on("data", (chunk) => {
      chunks.push(String(chunk));
      const request = chunks.join("");
      if (!request.includes("\n")) {
        return;
      }
      const decoded = decodeClientRequest(request.trim());
      if (Option.isNone(decoded)) {
        replyWithError({ client, message: "the Codex helper can't read the request" });
        return;
      }
      if (decoded.value.method === RECORD_TRACES_METHOD) {
        recordTraces({ client, request: request.trim() });
        return;
      }
      const refusal = refuseUnlessForwarded(decoded.value);
      if (Option.isSome(refusal)) {
        replyWithError({ client, message: refusal.value });
        return;
      }
      const id = randomId();
      const body = encodeUpstreamRequest({
        id,
        jsonrpc: "2.0",
        method: decoded.value.method,
        parameters: decoded.value.parameters,
      });
      if (Option.isNone(body)) {
        replyWithError({ client, message: "the Codex helper can't forward the request" });
        return;
      }
      pending.set(id, (reply) => {
        client.end(`${reply}\n`);
      });
      client.on("close", () => {
        pending.delete(id);
      });
      upstream.write(frameOf(body.value));
    });
  });
  server.on("error", (error) => {
    void recordHelperFailure({ operation: "serve nudge's socket", reason: error.message }).then(
      () => process.exit(1),
    );
  });
  const staging = `${socket}.${process.pid}`;
  const listen = (lock: { readonly release: Effect.Effect<void> }) => {
    locks.push(lock);
    void removeSocket(staging).then(() =>
      server.listen(staging, () => {
        void runHelperStep({
          operation: `move its socket to ${socket}`,
          step: Effect.gen(function* () {
            yield* (yield* FileSystem.FileSystem).rename(staging, socket);
          }),
        });
      }),
    );
  };
  const codexAccepted = randomId();
  const answered = Deferred.makeUnsafe<void>();
  pending.set(codexAccepted, () => {
    Deferred.doneUnsafe(answered, Effect.void);
  });
  void Effect.runPromise(
    Deferred.await(answered).pipe(
      Effect.as(true),
      Effect.timeoutOrElse({ duration: CODEX_ANSWER_TIMEOUT, orElse: () => Effect.succeed(false) }),
    ),
  ).then((didAnswer) => {
    if (!didAnswer) {
      void recordHelperFailure({
        operation: "hear from Codex Desktop on its app tools pipe",
        reason: `Codex Desktop didn't answer tools/list within ${CODEX_ANSWER_TIMEOUT}`,
      }).finally(() => process.exit(1));
      return;
    }
    void lockTheAppToolsPipeOrExit(directory).then(listen);
  });
  Option.map(
    encodeUpstreamRequest({ id: codexAccepted, jsonrpc: "2.0", method: "tools/list" }),
    (body) => upstream.write(frameOf(body)),
  );
};

const startHolder = (pipe: string) => {
  const upstream = connect(pipe);
  upstream.on("connect", () => {
    spawn(process.execPath, process.argv.slice(1), {
      detached: true,
      stdio: ["ignore", "ignore", "ignore", upstream],
      env: { ...process.env, NUDGE_CODEX_HOLDER: "1" },
    }).unref();
    upstream.destroy();
  });
  upstream.on("error", (error) => {
    void recordHelperFailure({
      operation: `connect to Codex's app tools at ${pipe}`,
      reason: error.message,
    });
  });
};

export const startHelper = () => {
  const pipe = process.env["CODEX_APP_TOOLS_PIPE_PATH"];
  const directory = `${process.env["HOME"]}/.local/state/nudge/codex/`;
  const hasPipe = pipe !== undefined && pipe !== "";
  if (process.env["NUDGE_CODEX_HOLDER"] === "1") {
    serveTheAppToolsPipe(directory);
  } else {
    if (hasPipe) {
      startHolder(pipe);
    }
    BunRuntime.runMain(serveMcp.pipe(Effect.provide(BunStdio.layer)));
  }
};
