import { Effect, FileSystem, Option, Schema } from "effect";
import type { PlatformError } from "effect";

import { toOneLine } from "../../../shared/print-line.ts";
import type { Session } from "../../../shared/session.ts";
import { waitFor } from "../../../shared/wait-until.ts";
import { Platform } from "../../platform/index.ts";
import { ClaudeSessionFileUnreadable } from "./errors.ts";

const LATEST_DATE = 8_640_000_000_000_000;

const DateInMilliseconds = Schema.Finite.check(
  Schema.isBetween({ minimum: -LATEST_DATE, maximum: LATEST_DATE }),
);

const ClaudeSessionFile = Schema.fromJsonString(
  Schema.Struct({
    pid: Schema.Int,
    sessionId: Schema.String,
    name: Schema.optional(Schema.String),
    startedAt: DateInMilliseconds,
    updatedAt: Schema.optional(DateInMilliseconds),
    status: Schema.optional(Schema.String),
    waitingFor: Schema.optional(Schema.String),
    cwd: Schema.optional(Schema.String),
    procStart: Schema.optional(Schema.String),
    peerProtocol: Schema.optional(Schema.Int),
    messagingSocketPath: Schema.optional(Schema.String),
    jobId: Schema.optional(Schema.String),
    kind: Schema.optional(Schema.String),
    entrypoint: Schema.optional(Schema.String),
    bridgeSessionId: Schema.optional(Schema.String),
  }),
);

export const describeSession = ({ id, name }: typeof Session.Type) => ({ id, name });

const HALF_WRITTEN_FILE_WAIT = "5 seconds";

const ProcessGone = Schema.Struct({ code: Schema.Literal("ESRCH") });

const ProcessNotSignalable = Schema.Struct({ code: Schema.Literal("EPERM") });

export const isProcessAlive = (pid: number) => {
  try {
    return process.kill(pid, 0);
  } catch (error) {
    if (Schema.is(ProcessGone)(error)) {
      return false;
    }
    if (Schema.is(ProcessNotSignalable)(error)) {
      return true;
    }
    throw error;
  }
};

const SESSION_FILE_NAME = /(?<pid>\d+)\.json$/u;

const isWrittenByALiveProcess = (path: string) => {
  const pid = SESSION_FILE_NAME.exec(path)?.groups?.["pid"];
  return pid !== undefined && isProcessAlive(Number(pid));
};

export const readClaudeSessionFile = (path: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const read = fileSystem
      .readFileString(path)
      .pipe(Effect.flatMap(Schema.decodeEffect(ClaudeSessionFile)));
    const unreadable = (error: PlatformError.PlatformError | Schema.SchemaError) =>
      new ClaudeSessionFileUnreadable({ path, reason: toOneLine(error.message) });
    const readOnceClaudeFinishesWritingIt = waitFor({
      watch: Effect.succeed([path]),
      check: read.pipe(
        Effect.map((file) => Option.some(Option.some(file))),
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedSome(Option.none())),
        Effect.catchTag("SchemaError", (stillTorn) =>
          isWrittenByALiveProcess(path) ? Effect.succeedNone : Effect.fail(stillTorn),
        ),
        Effect.mapError(unreadable),
      ),
    });
    return yield* read.pipe(
      Effect.asSome,
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
      Effect.catchTags({
        SchemaError: (torn) =>
          isWrittenByALiveProcess(path)
            ? readOnceClaudeFinishesWritingIt.pipe(
                Effect.timeoutOrElse({
                  duration: HALF_WRITTEN_FILE_WAIT,
                  orElse: () => Effect.fail(unreadable(torn)),
                }),
              )
            : Effect.fail(unreadable(torn)),
        PlatformError: (error) => Effect.fail(unreadable(error)),
      }),
    );
  });

export const listClaudeSessionFiles = (sessions: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.readDirectory(sessions).pipe(
      Effect.map((names) =>
        names.filter((name) => name.endsWith(".json")).map((name) => `${sessions}/${name}`),
      ),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])),
    );
  });

const NO_SESSION_PERSISTENCE = "--no-session-persistence";

export const runsASavedSession = (pid: number) =>
  Effect.gen(function* () {
    const processArguments = yield* (yield* Platform).readProcessArguments(pid);
    return Option.exists(processArguments, (found) => !found.includes(NO_SESSION_PERSISTENCE));
  });
