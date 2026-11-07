import { connect, createServer } from "node:net";
import { createInterface } from "node:readline";

import { Cause, Effect, Option, Queue, Result, Schedule, Schema } from "effect";
import type { FileSystem, Path } from "effect";
import { SecureRandom } from "effect/crypto";

import { codeOf } from "../../../shared/error-code.ts";
import { toOneLine } from "../../../shared/print-line.ts";
import type { Session } from "../../../shared/session.ts";
import { waitUntil } from "../../../shared/wait-until.ts";
import type { Platform } from "../../platform/index.ts";
import type { makeSessionFileReader } from "./claude-discovery.ts";
import { describeSession, isProcessAlive } from "./claude-session-files.ts";
import { isPeerMessage, isQueued, transcriptPaths } from "./claude-transcript.ts";
import type { makeNewRecordCheck } from "./claude-transcript.ts";
import {
  ClaudeFileNotPrivate,
  ClaudeMessageNotQueued,
  ClaudeMessageTooLarge,
  ClaudePeerKeyNotFound,
  ClaudePeerProtocolUnsupported,
  ClaudeProcessChanged,
  ClaudeReplyUnreadable,
  ClaudeSessionEnded,
  ClaudeSessionEndedBeforeDelivery,
  ClaudeSessionHasNoSocket,
  ClaudeSocketFailed,
  ClaudeSocketPathRelative,
  MessageDenied,
  MessageDropped,
  MessageExpired,
  MessageHeld,
  MessageRefused,
} from "./errors.ts";

const PEER_PROTOCOL = 1;

const CLAUDE_LINE_LIMIT = 1_048_576;

const QUEUE_WAIT = "30 seconds";

const SOCKET_WAIT = "10 seconds";

const SOCKET_POLL = "250 millis";

const GROUP_AND_OTHER_PERMISSIONS = 0o077;

const OWNER_READ_WRITE = 0o600;

const PeerKey = Schema.fromJsonString(
  Schema.Struct({
    peerToken: Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/iu)),
    procStart: Schema.String,
    pidDomain: Schema.String,
  }),
);

const Receipt = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.Literal("control"),
    action: Schema.Literal("peer_message_status"),
    originalMessageId: Schema.String,
    status: Schema.Literals(["held", "refused", "dropped", "denied", "expired", "delivered"]),
    statusDetail: Schema.optional(Schema.String),
    reason: Schema.optional(Schema.String),
  }).pipe(Schema.encodeKeys({ originalMessageId: "orig_msg_id", statusDetail: "status_detail" })),
);

const ReplySocketFrame = Schema.fromJsonString(
  Schema.Struct({ type: Schema.String, action: Schema.optional(Schema.String) }),
);

const RECEIPT_ACTION = "peer_message_status";

const decodeReplySocketFrame = Schema.decodeResult(ReplySocketFrame);

const decodeReceipt = Schema.decodeResult(Receipt);

const UserFrame = Schema.Struct({
  type: Schema.Literal("user"),
  messageVersion: Schema.Literal(PEER_PROTOCOL),
  messageId: Schema.String,
  message: Schema.Struct({ role: Schema.Literal("user"), content: Schema.String }),
  priority: Schema.Literal("next"),
  from: Schema.String,
}).pipe(Schema.encodeKeys({ messageVersion: "msgV", messageId: "msg_id" }));

const RenameFrame = Schema.Struct({
  type: Schema.Literal("control"),
  action: Schema.Literal("rename"),
  name: Schema.String,
  from: Schema.String,
});

const AuthFrame = Schema.Struct({ type: Schema.Literal("auth"), token: Schema.String });

const encodeFrame = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Union([UserFrame, RenameFrame, AuthFrame])),
);

const NOT_DELIVERED = {
  refused: MessageRefused,
  denied: MessageDenied,
  expired: MessageExpired,
  dropped: MessageDropped,
} as const;

const failOnReceipt = ({
  session,
  messageId,
  receipts,
}: {
  readonly session: typeof Session.Type;
  readonly messageId: string;
  readonly receipts: Queue.Dequeue<typeof Receipt.Type, ClaudeReplyUnreadable>;
}) => {
  const takeStatus: Effect.Effect<
    Pick<typeof Receipt.Type, "reason" | "status">,
    ClaudeReplyUnreadable
  > = Queue.take(receipts).pipe(
    Effect.flatMap((receipt) => {
      if (receipt.originalMessageId !== messageId) {
        return takeStatus;
      }
      const isRefusedExpiry = receipt.status === "expired" && receipt.statusDetail === "refused";
      return Effect.succeed({
        status: isRefusedExpiry ? "refused" : receipt.status,
        reason: receipt.reason,
      });
    }),
  );
  const settle = ({
    status,
    reason,
  }: Pick<typeof Receipt.Type, "reason" | "status">): Effect.Effect<
    never,
    | ClaudeReplyUnreadable
    | InstanceType<(typeof NOT_DELIVERED)[keyof typeof NOT_DELIVERED]>
    | MessageHeld
  > => {
    switch (status) {
      case "delivered": {
        return Effect.never;
      }
      case "held": {
        return Effect.fail(
          new MessageHeld({ session: describeSession(session), messageId, reason }),
        );
      }
      case "refused":
      case "denied":
      case "expired":
      case "dropped": {
        return Effect.fail(
          new NOT_DELIVERED[status]({ session: describeSession(session), messageId, reason }),
        );
      }
    }
  };
  return Effect.flatMap(takeStatus, settle);
};

const requirePrivate = Effect.fn("claude.requirePrivate")(function* ({
  fileSystem,
  file,
  type,
}: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly file: string;
  readonly type: typeof ClaudeFileNotPrivate.fields.type.Type;
}) {
  const status = yield* fileSystem.stat(file);
  const owner = process.getuid?.();
  const isPrivate =
    status.type === type &&
    owner !== undefined &&
    Option.getOrUndefined(status.uid) === owner &&
    (status.mode & GROUP_AND_OTHER_PERMISSIONS) === 0;
  yield* Effect.annotateCurrentSpan({
    "nudge.claude.file.type": type,
    "nudge.claude.file.private": isPrivate,
    "nudge.claude.file.mode": status.mode,
    "nudge.claude.file.ownerMatches":
      owner !== undefined && Option.getOrUndefined(status.uid) === owner,
  });
  if (!isPrivate) {
    return yield* new ClaudeFileNotPrivate({ path: file, type });
  }
});

const findPeerKey = Effect.fn("claude.findPeerKey")(function* ({
  fileSystem,
  platform,
  sessions,
  session,
  pid,
  procStart,
}: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly platform: Platform["Service"];
  readonly sessions: string;
  readonly session: typeof Session.Type;
  readonly pid: number;
  readonly procStart: string;
}) {
  const pattern = new RegExp(`^${pid}\\.[0-9a-f]{64}\\.key$`, "iu");
  const pidDomain = yield* platform.readPidDomain;
  const keys = yield* Effect.forEach(
    (yield* fileSystem.readDirectory(sessions)).filter((name) => pattern.test(name)),
    (name) =>
      Effect.gen(function* () {
        const file = `${sessions}/${name}`;
        yield* requirePrivate({ fileSystem, file, type: "File" });
        return yield* Schema.decodeEffect(PeerKey)(yield* fileSystem.readFileString(file));
      }),
  );
  const matches = keys.filter((key) => key.procStart === procStart && key.pidDomain === pidDomain);
  yield* Effect.annotateCurrentSpan({
    "nudge.session.id": session.id,
    "nudge.claude.peerKey.candidate.count": keys.length,
    "nudge.claude.peerKey.match.count": matches.length,
  });
  const [key] = matches;
  const isOneMatch = key !== undefined && matches.length === 1;
  if (!isOneMatch) {
    return yield* new ClaudePeerKeyNotFound({
      session: describeSession(session),
      directory: sessions,
      pid,
      matches: matches.length,
    });
  }
  return key;
});

const listenForReceipts = Effect.fn("claude.listenForReceipts")(function* ({
  fileSystem,
  session,
  socket,
}: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly session: typeof Session.Type;
  readonly socket: string;
}) {
  const receipts = yield* Queue.unbounded<typeof Receipt.Type, ClaudeReplyUnreadable>();
  const receiveLine = (line: string) =>
    Result.match(
      Result.flatMap(decodeReplySocketFrame(line), (frame) =>
        frame.action === RECEIPT_ACTION
          ? Result.map(decodeReceipt(line), Option.some)
          : Result.succeed(Option.none()),
      ),
      {
        onFailure: (error) =>
          Queue.failCauseUnsafe(
            receipts,
            Cause.fail(new ClaudeReplyUnreadable({ socket, reason: toOneLine(error.message) })),
          ),
        onSuccess: Option.map((receipt) => Queue.offerUnsafe(receipts, receipt)),
      },
    );
  yield* Effect.acquireRelease(
    Effect.callback<ReturnType<typeof createServer>, ClaudeSocketFailed>((resume) => {
      const server = createServer((connection) => {
        createInterface({ input: connection }).on("line", (line) => {
          receiveLine(line);
        });
      });
      server.on("error", (error) => {
        resume(
          Effect.fail(
            new ClaudeSocketFailed({
              session: describeSession(session),
              socket,
              operation: "listen for replies on",
              code: codeOf(error),
              reason: error.message,
            }),
          ),
        );
      });
      server.listen(socket, () => {
        resume(Effect.succeed(server));
      });
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => {
          resume(Effect.void);
        });
      }),
  );
  yield* fileSystem.chmod(socket, OWNER_READ_WRITE);
  return receipts;
});

export const readOnceItHasASocket = ({
  readSessionFile,
  registration,
  session,
}: {
  readonly readSessionFile: ReturnType<typeof makeSessionFileReader>;
  readonly registration: string;
  readonly session: typeof Session.Type;
}) =>
  Effect.gen(function* () {
    const ended = new ClaudeSessionEnded({ session: describeSession(session) });
    const first = yield* readSessionFile(registration);
    if (Option.isNone(first)) {
      return yield* ended;
    }
    const { pid, sessionId } = first.value;
    const sameSession = (file: Effect.Success<ReturnType<typeof readSessionFile>>) =>
      Option.filter(file, (found) => found.pid === pid && found.sessionId === sessionId);
    const isSettled = (file: Effect.Success<ReturnType<typeof readSessionFile>>) => {
      const hasMessagingSocket = Option.exists(
        sameSession(file),
        ({ messagingSocketPath, procStart }) =>
          messagingSocketPath !== undefined && procStart !== undefined,
      );
      const isReplacedOrEnded = Option.isNone(sameSession(file));
      return hasMessagingSocket || isReplacedOrEnded || !isProcessAlive(pid);
    };
    const latest = isSettled(first)
      ? first
      : yield* readSessionFile(registration).pipe(
          Effect.repeat({ schedule: Schedule.spaced(SOCKET_POLL), until: isSettled }),
          Effect.timeoutOrElse({ duration: SOCKET_WAIT, orElse: () => Effect.succeed(first) }),
        );
    const current = sameSession(latest);
    if (Option.isNone(current)) {
      return yield* ended;
    }
    return current.value;
  });

export const sendToSessionSocket = Effect.fn("claude.sendToSessionSocket")(function* ({
  fileSystem,
  paths,
  platform,
  sessions,
  readSessionFile,
  session,
  registration,
  frame,
}: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly paths: Path.Path;
  readonly platform: Platform["Service"];
  readonly sessions: string;
  readonly readSessionFile: ReturnType<typeof makeSessionFileReader>;
  readonly session: typeof Session.Type;
  readonly registration: string;
  readonly frame: (replyTo: string) => typeof RenameFrame.Type | typeof UserFrame.Type;
}) {
  yield* requirePrivate({ fileSystem, file: sessions, type: "Directory" });
  const file = yield* readOnceItHasASocket({ readSessionFile, registration, session });
  const socket = file.messagingSocketPath;
  const procStart = file.procStart;
  const hasMessagingSocket = socket !== undefined && procStart !== undefined;
  if (!hasMessagingSocket) {
    return yield* new ClaudeSessionHasNoSocket({ session: describeSession(session) });
  }
  const { pid } = file;
  if (file.peerProtocol !== PEER_PROTOCOL) {
    return yield* new ClaudePeerProtocolUnsupported({
      session: describeSession(session),
      protocol: file.peerProtocol,
      supported: PEER_PROTOCOL,
    });
  }
  if (!paths.isAbsolute(socket)) {
    return yield* new ClaudeSocketPathRelative({ session: describeSession(session), socket });
  }
  const socketDirectory = paths.dirname(socket);
  yield* requirePrivate({ fileSystem, file: socketDirectory, type: "Directory" });
  yield* requirePrivate({ fileSystem, file: socket, type: "Socket" });
  const key = yield* findPeerKey({ fileSystem, platform, sessions, session, pid, procStart });
  const runningSince = yield* platform.readProcessStart(pid);
  if (Option.isNone(runningSince)) {
    return yield* new ClaudeSessionEnded({ session: describeSession(session) });
  }
  if (runningSince.value !== procStart) {
    return yield* new ClaudeProcessChanged({
      session: describeSession(session),
      pid,
      expected: procStart,
      found: runningSince.value,
    });
  }
  const replySocket = `${socketDirectory}/${yield* (yield* SecureRandom.SecureRandom).uuidV4()}.sock`;
  const frameLine = yield* encodeFrame(frame(`uds:${replySocket}`));
  const characters = `${frameLine}\n`.length;
  if (characters > CLAUDE_LINE_LIMIT) {
    return yield* new ClaudeMessageTooLarge({
      session: describeSession(session),
      characters,
      maximum: CLAUDE_LINE_LIMIT,
    });
  }
  const payload = [yield* encodeFrame({ type: "auth", token: key.peerToken }), frameLine, ""].join(
    "\n",
  );
  const receipts = yield* listenForReceipts({ fileSystem, session, socket: replySocket });
  yield* Effect.callback<void, ClaudeSocketFailed>((resume) => {
    const client = connect(socket);
    client.on("connect", () => {
      client.end(payload, () => {
        resume(Effect.void);
      });
    });
    client.on("error", (error) => {
      resume(
        Effect.fail(
          new ClaudeSocketFailed({
            session: describeSession(session),
            socket,
            operation: "send to",
            code: codeOf(error),
            reason: error.message,
          }),
        ),
      );
    });
  });
  return receipts;
});

export const deliverThroughSocket = ({
  root,
  fileSystem,
  paths,
  platform,
  sessions,
  readSessionFile,
  session,
  registration,
  messageId,
  content,
  hasNewRecord,
}: {
  readonly root: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly paths: Path.Path;
  readonly platform: Platform["Service"];
  readonly sessions: string;
  readonly readSessionFile: ReturnType<typeof makeSessionFileReader>;
  readonly session: typeof Session.Type;
  readonly registration: string;
  readonly messageId: string;
  readonly content: string;
  readonly hasNewRecord: Effect.Success<ReturnType<typeof makeNewRecordCheck>>;
}) =>
  Effect.gen(function* () {
    const receipts = yield* sendToSessionSocket({
      fileSystem,
      paths,
      platform,
      sessions,
      readSessionFile,
      session,
      registration,
      frame: (from) => ({
        type: "user",
        messageVersion: PEER_PROTOCOL,
        messageId,
        message: { role: "user", content },
        priority: "next",
        from,
      }),
    });
    const isDelivered = Effect.gen(function* () {
      const isRecorded = yield* hasNewRecord(
        (record) => isPeerMessage({ record, messageId }) || isQueued({ record, content }),
      );
      if (isRecorded) {
        return true;
      }
      if (Option.isNone(yield* readSessionFile(registration))) {
        return yield* new ClaudeSessionEndedBeforeDelivery({
          session: describeSession(session),
        });
      }
      return false;
    });
    yield* Effect.raceFirst(
      waitUntil({
        watch: Effect.map(transcriptPaths({ root, fileSystem, id: session.id }), (transcript) => [
          registration,
          ...transcript,
        ]),
        done: isDelivered,
      }),
      failOnReceipt({ session, messageId, receipts }),
    ).pipe(
      Effect.timeoutOrElse({
        duration: QUEUE_WAIT,
        orElse: () =>
          Effect.fail(
            new ClaudeMessageNotQueued({
              session: describeSession(session),
              waited: QUEUE_WAIT,
            }),
          ),
      }),
    );
  });
