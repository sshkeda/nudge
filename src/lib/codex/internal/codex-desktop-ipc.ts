import * as BunSocket from "@effect/platform-bun/BunSocket";
import { Effect, Option, Ref, Schema, Stream } from "effect";
import { SecureRandom } from "effect/crypto";
import type { Socket } from "effect/socket";

import { codeOf } from "../../../shared/error-code.ts";
import { CodexDesktopIpcRefused, CodexDesktopIpcUnreachable } from "./errors.ts";

const FRAME_LENGTH_BYTES = 4;

const INITIALIZE_REQUEST_ID = "nudge-initialize";

const CLOSED_BEFORE_ANSWERING = "Codex Desktop closed the connection before answering";

const CLOSED_BY_PEER_CODES: ReadonlySet<string | undefined> = new Set(["ECONNRESET", "EPIPE"]);

const describeSocketError = (error: Socket.SocketError) => {
  const cause = "cause" in error.reason ? error.reason.cause : undefined;
  if (!(cause instanceof Error)) {
    return { reason: error.message };
  }
  const code = codeOf(cause);
  return CLOSED_BY_PEER_CODES.has(code)
    ? { reason: CLOSED_BEFORE_ANSWERING }
    : { code, reason: cause.message };
};

const Request = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.Literal("request"),
    requestId: Schema.String,
    sourceClientId: Schema.String,
    targetClientId: Schema.optional(Schema.String),
    version: Schema.Int,
    method: Schema.String,
    parameters: Schema.Unknown,
  }).pipe(Schema.encodeKeys({ parameters: "params" })),
);

const DiscoveryResponse = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.Literal("client-discovery-response"),
    requestId: Schema.String,
    response: Schema.Struct({ canHandle: Schema.Boolean }),
  }),
);

const Answer = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("response"),
    requestId: Schema.String,
    resultType: Schema.Literal("error"),
    error: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("response"),
    requestId: Schema.String,
    resultType: Schema.Literal("success"),
    result: Schema.Unknown,
    handledByClientId: Schema.optional(Schema.String),
  }),
]);

const Incoming = Schema.fromJsonString(
  Schema.Union([
    Answer,
    Schema.Struct({ type: Schema.Literal("client-discovery-request"), requestId: Schema.String }),
    Schema.Struct({
      type: Schema.Literal("broadcast"),
      method: Schema.String,
      sourceClientId: Schema.String,
      parameters: Schema.Unknown,
    }).pipe(Schema.encodeKeys({ parameters: "params" })),
  ]),
);

const Initialized = Schema.Struct({ clientId: Schema.String });

export const ThreadRuntimeStatus = Schema.Union([
  Schema.Struct({ type: Schema.Literal("active"), activeFlags: Schema.Array(Schema.String) }),
  Schema.Struct({ type: Schema.Literals(["idle", "notLoaded", "systemError"]) }),
]);

const StreamChange = Schema.Struct({
  conversationId: Schema.String,
  change: Schema.Struct({ type: Schema.String }),
});

const ThreadSnapshot = Schema.Struct({
  change: Schema.Struct({
    conversationState: Schema.Struct({ threadRuntimeStatus: ThreadRuntimeStatus }),
  }),
});

const ClientStatus = Schema.Struct({ clientId: Schema.String, status: Schema.String });

const encodeFollowing = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literal("broadcast"),
      method: Schema.Literal("thread-stream-following-changed"),
      sourceClientId: Schema.String,
      targetClientIds: Schema.optional(Schema.Array(Schema.String)),
      version: Schema.Literal(1),
      parameters: Schema.Struct({
        hostId: Schema.Literal("local"),
        conversationId: Schema.String,
        following: Schema.Boolean,
      }),
    }).pipe(Schema.encodeKeys({ parameters: "params" })),
  ),
);

const threadStatusAnswer = (requestId: string, status: typeof ThreadRuntimeStatus.Type) =>
  Option.some<typeof Answer.Type>({
    type: "response",
    requestId,
    resultType: "success",
    result: status,
  });

const encodeRequest = Schema.encodeEffect(Request);

const encodeDiscoveryResponse = Schema.encodeEffect(DiscoveryResponse);

export const frame = (body: string) => {
  const bytes = Buffer.from(body);
  const head = Buffer.alloc(FRAME_LENGTH_BYTES);
  head.writeUInt32LE(bytes.length, 0);
  return new Uint8Array(Buffer.concat([head, bytes]));
};

export const splitFrames = ({
  buffer,
  bodies,
}: {
  readonly buffer: Buffer;
  readonly bodies: readonly string[];
}): { readonly buffer: Buffer; readonly bodies: readonly string[] } => {
  const hasLength = buffer.length >= FRAME_LENGTH_BYTES;
  const end = hasLength ? FRAME_LENGTH_BYTES + buffer.readUInt32LE(0) : Number.POSITIVE_INFINITY;
  if (buffer.length < end) {
    return { buffer, bodies };
  }
  return splitFrames({
    buffer: buffer.subarray(end),
    bodies: [...bodies, buffer.subarray(FRAME_LENGTH_BYTES, end).toString()],
  });
};

export const askCodexDesktop = Effect.fn("codex.askDesktop")(
  function* ({
    socket,
    method,
    version,
    parameters,
    followThread,
  }: {
    readonly socket: string;
    readonly method: string;
    readonly version: number;
    readonly parameters: unknown;
    readonly followThread?: string;
  }) {
    yield* Effect.annotateCurrentSpan({
      "nudge.codex.ipcMethod": method,
      "nudge.codex.ipcResult": "error",
    });
    const callRequestId = yield* (yield* SecureRandom.SecureRandom).uuidV4();
    const snapshotRequestId = `${callRequestId}-snapshot`;
    const unreachable = (reason: string) =>
      new CodexDesktopIpcUnreachable({ socket, method, reason });
    const connection = yield* BunSocket.makeNet({ path: socket });
    const reader = yield* connection.reader;
    const writer = yield* connection.writer;
    const send = (body: string) => writer.write(frame(body));
    const snapshots = yield* Ref.make(new Map<string, typeof ThreadRuntimeStatus.Type>());
    const clientId = yield* Ref.make("initializing-client");
    const ownerClientId = yield* Ref.make(Option.none<string>());
    yield* send(
      yield* encodeRequest({
        type: "request",
        requestId: INITIALIZE_REQUEST_ID,
        sourceClientId: "initializing-client",
        version: 0,
        method: "initialize",
        parameters: { clientType: "nudge" },
      }),
    );
    const answer = yield* Stream.fromIterableEffectRepeat(reader.pull).pipe(
      Stream.mapAccum(
        (): Buffer => Buffer.alloc(0),
        (pending: Buffer, chunk) => {
          const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
          const split = splitFrames({ buffer: Buffer.concat([pending, bytes]), bodies: [] });
          return [split.buffer, split.bodies] as const;
        },
      ),
      Stream.mapEffect((body) =>
        Schema.decodeEffect(Incoming)(body).pipe(
          Effect.mapError((error) =>
            unreachable(`Codex Desktop sent a message nudge can't read: ${error.message}`),
          ),
        ),
      ),
      Stream.mapEffect((incoming) =>
        Effect.gen(function* () {
          const isFollowingBroadcast = incoming.type === "broadcast" && followThread !== undefined;
          if (isFollowingBroadcast) {
            const owner = Option.getOrUndefined(yield* Ref.get(ownerClientId));
            if (incoming.method === "thread-stream-state-changed") {
              const change = yield* Schema.decodeUnknownEffect(StreamChange)(incoming.parameters);
              const isFollowedSnapshot =
                change.conversationId === followThread && change.change.type === "snapshot";
              if (isFollowedSnapshot) {
                const snapshot = yield* Schema.decodeUnknownEffect(ThreadSnapshot)(
                  incoming.parameters,
                );
                const status = snapshot.change.conversationState.threadRuntimeStatus;
                yield* Ref.update(
                  snapshots,
                  (known) => new Map([...known, [incoming.sourceClientId, status]]),
                );
                if (incoming.sourceClientId === owner) {
                  return threadStatusAnswer(callRequestId, status);
                }
              }
            }
            if (incoming.method === "client-status-changed") {
              const changed = yield* Schema.decodeUnknownEffect(ClientStatus)(incoming.parameters);
              const ownerDisconnected =
                changed.clientId === owner && changed.status === "disconnected";
              if (ownerDisconnected) {
                return yield* unreachable(
                  "the thread stream owner disconnected before sending its status",
                );
              }
            }
          }
          if (incoming.type === "client-discovery-request") {
            yield* send(
              yield* encodeDiscoveryResponse({
                type: "client-discovery-response",
                requestId: incoming.requestId,
                response: { canHandle: false },
              }),
            );
            return Option.none<typeof Answer.Type>();
          }
          const isInitialized =
            incoming.type === "response" && incoming.requestId === INITIALIZE_REQUEST_ID;
          if (isInitialized) {
            const initialized =
              incoming.resultType === "success"
                ? yield* Schema.decodeUnknownEffect(Initialized)(incoming.result)
                : yield* new CodexDesktopIpcRefused({
                    method: "initialize",
                    error: incoming.error,
                  });
            yield* Ref.set(clientId, initialized.clientId);
            if (followThread !== undefined) {
              yield* send(
                yield* encodeFollowing({
                  type: "broadcast",
                  method: "thread-stream-following-changed",
                  sourceClientId: initialized.clientId,
                  version: 1,
                  parameters: { hostId: "local", conversationId: followThread, following: true },
                }),
              );
            }
            yield* send(
              yield* encodeRequest({
                type: "request",
                requestId: callRequestId,
                sourceClientId: initialized.clientId,
                version,
                method,
                parameters,
              }),
            );
            return Option.none<typeof Answer.Type>();
          }
          const isAnswer = incoming.type === "response" && incoming.requestId === callRequestId;
          const foundOwner =
            isAnswer && followThread !== undefined && incoming.resultType === "success";
          if (foundOwner) {
            const owner = incoming.handledByClientId;
            if (owner === undefined) {
              return yield* unreachable("owner discovery didn't identify the thread stream owner");
            }
            const status = (yield* Ref.get(snapshots)).get(owner);
            if (status !== undefined) {
              return threadStatusAnswer(callRequestId, status);
            }
            yield* Ref.set(ownerClientId, Option.some(owner));
            yield* send(
              yield* encodeRequest({
                type: "request",
                requestId: snapshotRequestId,
                method: "thread-follower-load-complete-history",
                sourceClientId: yield* Ref.get(clientId),
                targetClientId: owner,
                version: 1,
                parameters: { hostId: "local", conversationId: followThread },
              }),
            );
            return Option.none<typeof Answer.Type>();
          }
          const isSnapshotReply =
            incoming.type === "response" && incoming.requestId === snapshotRequestId;
          if (isSnapshotReply) {
            if (incoming.resultType === "error") {
              return Option.some(incoming);
            }
            return Option.none<typeof Answer.Type>();
          }
          return isAnswer ? Option.some(incoming) : Option.none<typeof Answer.Type>();
        }),
      ),
      Stream.filter(Option.isSome),
      Stream.runHead,
      Effect.catchTags({
        SchemaError: (error) =>
          Effect.fail(
            unreachable(`Codex Desktop sent a message nudge can't read: ${error.message}`),
          ),
      }),
    );
    if (Option.isNone(answer)) {
      return yield* unreachable(CLOSED_BEFORE_ANSWERING);
    }
    yield* Effect.annotateCurrentSpan("nudge.codex.ipcResult", answer.value.value.resultType);
    return answer.value.value;
  },
  Effect.scoped,
  (effect, { socket, method }) =>
    effect.pipe(
      Effect.catchReason("SocketError", "SocketCloseError", () =>
        Effect.fail(
          new CodexDesktopIpcUnreachable({ socket, method, reason: CLOSED_BEFORE_ANSWERING }),
        ),
      ),
      Effect.catchTag("SocketError", (error) =>
        Effect.fail(
          new CodexDesktopIpcUnreachable({ socket, method, ...describeSocketError(error) }),
        ),
      ),
      Effect.timeoutOrElse({
        duration: "30 seconds",
        orElse: () =>
          Effect.fail(
            new CodexDesktopIpcUnreachable({
              socket,
              method,
              reason: `Codex Desktop did not answer ${method} within 30 seconds`,
            }),
          ),
      }),
    ),
);

export const requireSuccess = ({
  method,
  answer,
}: {
  readonly method: string;
  readonly answer: Effect.Success<ReturnType<typeof askCodexDesktop>>;
}) =>
  answer.resultType === "success"
    ? Effect.succeed(answer.result)
    : Effect.fail(new CodexDesktopIpcRefused({ method, error: answer.error }));
