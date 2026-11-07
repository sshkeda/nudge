import {
  Clock,
  Context,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Ref,
  Result,
  Schema,
} from "effect";
import { SecureRandom } from "effect/crypto";
import type { ChildProcessSpawner } from "effect/process";

import { envelopeForCodex, envelopeForNewSession } from "../../../shared/message-envelope.ts";
import type { Sender } from "../../../shared/message-envelope.ts";
import { Output } from "../../../shared/output.ts";
import { toOneLine } from "../../../shared/print-line.ts";
import { CODEX_HOME, CODEX_THREAD_ID } from "../../../shared/read-environment.ts";
import type { SessionStatus } from "../../../shared/session.ts";
import type { Speed } from "../../../shared/speed.ts";
import {
  makeAppendedLineReader,
  readByteLength,
  START_OF_FILE,
} from "../../../shared/transcript.ts";
import { waitFor, waitUntil } from "../../../shared/wait-until.ts";
import type { Platform } from "../../platform/index.ts";
import { callTool, turnIdFor } from "./call-app-tool.ts";
import { chooseProject } from "./choose-project.ts";
import { askCodexDesktop, requireSuccess, ThreadRuntimeStatus } from "./codex-desktop-ipc.ts";
import { CodexRollout, CodexSession } from "./codex-session.ts";
import { queryCodexDatabase } from "./codex-state-database.ts";
import {
  findFullAccessCaller,
  requireFirstTurnFullAccess,
  startFullAccessCaller,
} from "./desktop-permissions.ts";
import {
  CodexArchiveStillLocked,
  CodexHasNoTask,
  CodexHelperStillUnarchived,
  CodexIndexLineUnreadable,
  CodexStateDatabaseMissing,
  CodexSubagentRootNotFound,
  CodexTaskNotGivenFullAccess,
  CodexUnarchiveNotApplied,
} from "./errors.ts";
import type { CodexArchiveDatabaseLocked } from "./errors.ts";
import { listOfferedModels, requireKnownModel } from "./model-catalog.ts";
import { readDefaultPermissions } from "./read-default-permissions.ts";
import { readThreadProjects } from "./read-thread-projects.ts";
import {
  readLatestChoice,
  readLatestModel,
  readLatestTier,
  settleFirstTurnSpeed,
  settleSpeedAfterSend,
  STARTED_A_TURN,
  STEERED_A_TURN,
  switchSpeedBeforeSend,
} from "./service-tier.ts";
import { startMessageWithSpeed } from "./start-message-with-speed.ts";

export const describeRuntimeStatus = (
  status: typeof ThreadRuntimeStatus.Type,
): typeof SessionStatus.Type => {
  if (status.type !== "active") {
    return status.type === "systemError" ? "failed" : "idle";
  }
  const flags = status.activeFlags;
  if (flags.includes("waitingOnApproval")) {
    return "waiting-for-approval";
  }
  if (flags.includes("waitingOnUserInput")) {
    return "waiting-for-input";
  }
  return "running";
};

const STATUS_READ_CONCURRENCY = 8;

const Created = Schema.fromJsonString(Schema.Struct({ threadId: Schema.String }));

const MILLISECONDS_PER_SECOND = 1000;

const DELIVERED = "delivered";

const ACCEPTED = "accepted";

const MAXIMUM_SUBAGENT_DEPTH = 100;

const DESKTOP_THREAD_SOURCE = "vscode";

const SUBAGENT_SOURCE_PATTERN = '{"subagent"%';

const nameThread = ({
  id,
  name,
  title,
  indexName,
}: {
  readonly id: string;
  readonly name: string | null;
  readonly title: string;
  readonly indexName: string | undefined;
}) => {
  const ownName = name?.trim() ?? "";
  const isOwnNameGiven = ownName !== "" && ownName !== title.trim();
  const givenName = isOwnNameGiven ? ownName : indexName;
  return { givenName, shownName: givenName ?? (ownName === "" ? id : ownName) };
};

const ThreadRow = Schema.Struct({
  id: Schema.String,
  name: Schema.NullOr(Schema.String),
  title: Schema.String,
  source: Schema.String,
  is_subagent: Schema.Int,
  cwd: Schema.String,
  rollout_path: Schema.String,
  last_active: Schema.Finite,
  project: Schema.NullOr(Schema.String),
  section: Schema.NullOr(Schema.String),
});

const decodeTurnEvent = Schema.decodeOption(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literal("event_msg"),
      payload: Schema.Struct({
        type: Schema.Literals(["task_started", "task_complete", "turn_aborted"]),
      }),
    }),
  ),
);

const escapeLikeCodexDelegation = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const decodeDeliveryRecord = Schema.decodeOption(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({
        type: Schema.Literal("event_msg"),
        payload: Schema.Struct({
          type: Schema.Literal("task_started"),
          turn_attribution: Schema.Struct({ parent_turn_id: Schema.String }),
        }),
      }),
      Schema.Struct({
        type: Schema.Literal("response_item"),
        payload: Schema.Struct({
          type: Schema.Literal("function_call_output"),
          name: Schema.String,
          output: Schema.Union([
            Schema.String,
            Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) })),
          ]),
        }),
      }),
    ]),
  ),
);

export const deliveryFinder =
  ({
    tool,
    callId,
    prompt,
  }: {
    readonly tool: string;
    readonly callId: string;
    readonly prompt: string;
  }) =>
  (line: string): Option.Option<string> => {
    const turnId = turnIdFor(callId);
    const input = `<input>${escapeLikeCodexDelegation(prompt)}</input>`;
    return Option.flatMap(decodeDeliveryRecord(line), ({ payload }) => {
      if ("turn_attribution" in payload) {
        return payload.turn_attribution.parent_turn_id === turnId
          ? Option.some(STARTED_A_TURN)
          : Option.none();
      }
      const output =
        typeof payload.output === "string"
          ? payload.output
          : payload.output.map((item) => item.text ?? "").join("");
      const isThisMessage = payload.name === tool && output.includes(input);
      return isThisMessage ? Option.some(STEERED_A_TURN) : Option.none();
    });
  };

const ARCHIVE_RETRY_SPACING = "1 second";

const ARCHIVE_RETRY_DEADLINE = "30 seconds";

export const archiveWithRetries = (archive: ReturnType<typeof callTool>, threadId: string) =>
  archive.pipe(
    Effect.catchTag("CodexArchiveDatabaseLocked", (firstLock) =>
      Effect.gen(function* () {
        const deadline =
          (yield* Clock.currentTimeMillis) + Duration.toMillis(ARCHIVE_RETRY_DEADLINE);
        const retry = (
          lastLock: CodexArchiveDatabaseLocked,
        ): Effect.Effect<
          void,
          CodexArchiveStillLocked | Effect.Error<ReturnType<typeof callTool>>,
          Effect.Services<ReturnType<typeof callTool>>
        > =>
          Effect.gen(function* () {
            const remaining = deadline - (yield* Clock.currentTimeMillis);
            const waiting = yield* Effect.void.pipe(
              Effect.delay(ARCHIVE_RETRY_SPACING),
              Effect.timeoutOption(Duration.millis(Math.max(0, remaining))),
            );
            const deadlineReached =
              Option.isNone(waiting) || (yield* Clock.currentTimeMillis) >= deadline;
            if (deadlineReached) {
              return yield* new CodexArchiveStillLocked({
                threadId,
                retriedFor: ARCHIVE_RETRY_DEADLINE,
                failure: lastLock.failure,
              });
            }
            yield* archive.pipe(Effect.catchTag("CodexArchiveDatabaseLocked", retry));
          });
        yield* retry(firstLock);
      }),
    ),
  );

const STATE_DATABASE_NAME = /^state_\d+\.sqlite$/u;

const findStateDatabase = (root: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.readDirectory(root).pipe(
      Effect.map((names) => {
        const [newest] = names
          .filter((name) => STATE_DATABASE_NAME.test(name))
          .toSorted((left, right) => right.localeCompare(left, undefined, { numeric: true }));
        return Option.map(Option.fromNullishOr(newest), (file) => `${root}/${file}`);
      }),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
    );
  });

const IndexEntry = Schema.fromJsonString(
  Schema.Struct({ id: Schema.String, thread_name: Schema.String }),
);

const readIndexEntries = (root: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = `${root}/session_index.jsonl`;
    const text = yield* fileSystem
      .readFileString(path)
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed("")));
    return yield* Effect.forEach(
      text
        .split("\n")
        .slice(0, -1)
        .filter((line) => line !== ""),
      (line) =>
        Schema.decodeEffect(IndexEntry)(line).pipe(
          Effect.mapBoth({
            onFailure: (error) =>
              new CodexIndexLineUnreadable({ path, reason: toOneLine(error.message) }),
            onSuccess: Result.succeed,
          }),
          Effect.catchTag("CodexIndexLineUnreadable", (unreadable) =>
            Effect.succeed(Result.fail(unreadable)),
          ),
        ),
    );
  });

const findTopLevelThread = (database: string, threadId: string) =>
  Effect.gen(function* () {
    const [top] = yield* queryCodexDatabase({
      database,
      query: (sql) => sql`WITH RECURSIVE ancestors(id, depth) AS (
          SELECT ${threadId}, 0
          UNION
          SELECT e.parent_thread_id, a.depth + 1
          FROM thread_spawn_edges e JOIN ancestors a ON e.child_thread_id = a.id
          WHERE a.depth < ${MAXIMUM_SUBAGENT_DEPTH}
        )
        SELECT id, depth FROM ancestors ORDER BY depth DESC LIMIT 1`,
      row: Schema.Struct({ id: Schema.String, depth: Schema.Int }),
    });
    const isTooDeep = top === undefined || top.depth >= MAXIMUM_SUBAGENT_DEPTH;
    if (isTooDeep) {
      return yield* new CodexSubagentRootNotFound({ threadId, database });
    }
    return top.id;
  });

const findNewestTopLevelThread = (database: string) =>
  queryCodexDatabase({
    database,
    query: (sql) => sql`SELECT id FROM threads
      WHERE archived = 0 AND id NOT IN (SELECT child_thread_id FROM thread_spawn_edges)
        AND source NOT LIKE ${SUBAGENT_SOURCE_PATTERN}
      ORDER BY updated_at DESC LIMIT 1`,
    row: Schema.Struct({ id: Schema.String }),
  }).pipe(
    Effect.flatMap(([newest]) =>
      newest === undefined
        ? Effect.fail(new CodexHasNoTask({ database }))
        : Effect.succeed(newest.id),
    ),
  );

const matchingTarget = (target: string) => (names: ReadonlyMap<string, string>) =>
  Option.some({
    ids: [target, ...[...names].filter(([, name]) => name === target).map(([id]) => id)],
    name: target,
  });

const make = Effect.gen(function* () {
  const root = yield* CODEX_HOME;
  const fileSystem = yield* FileSystem.FileSystem;
  const socket = `${root}/ipc/ipc.sock`;
  const describeTurn = (threadId: string) =>
    Effect.gen(function* () {
      const writerLock = `${root}/thread-writer-locks/${threadId}.lock`;
      const hasNoDesktopWriter =
        !(yield* fileSystem.exists(writerLock)) || !(yield* fileSystem.exists(socket));
      if (hasNoDesktopWriter) {
        return "idle" as const;
      }
      const method = "thread-owner-discovery";
      const answer = yield* askCodexDesktop({
        socket,
        method,
        version: 1,
        parameters: { hostId: "local", conversationId: threadId },
        followThread: threadId,
      });
      const hasNoOwner =
        !(yield* fileSystem.exists(writerLock)) ||
        (answer.resultType === "error" && answer.error === "no-client-found");
      if (hasNoOwner) {
        return "idle" as const;
      }
      const status = yield* Schema.decodeUnknownEffect(ThreadRuntimeStatus)(
        yield* requireSuccess({ method, answer }),
      );
      return describeRuntimeStatus(status);
    }).pipe(
      Effect.catchTag("CodexDesktopIpcUnreachable", (error) =>
        Effect.gen(function* () {
          if (yield* fileSystem.exists(`${root}/thread-writer-locks/${threadId}.lock`)) {
            return yield* error;
          }
          return "idle" as const;
        }),
      ),
    );
  const services = yield* Effect.context<
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Platform
  >();

  const output = yield* Output;

  const requireStateDatabase = findStateDatabase(root).pipe(
    Effect.flatMap(Effect.fromOption),
    Effect.catchTag("NoSuchElementError", () =>
      Effect.fail(new CodexStateDatabaseMissing({ directory: root })),
    ),
  );

  const readThreadNames = Effect.gen(function* () {
    const names = new Map<string, string>();
    for (const read of yield* readIndexEntries(root)) {
      if (Result.isFailure(read)) {
        yield* output.warnOnce({ key: read.failure.path, warning: read.failure });
      } else if (read.success.thread_name.trim() !== "") {
        names.set(read.success.id, read.success.thread_name.trim());
      }
    }
    return names;
  });

  const findReplyThread = (threadId: string) =>
    Effect.gen(function* () {
      const database = yield* findStateDatabase(root);
      if (Option.isNone(database)) {
        return Option.none();
      }
      const [known] = yield* queryCodexDatabase({
        database: database.value,
        query: (sql) => sql`SELECT id FROM threads WHERE id = ${threadId}`,
        row: Schema.Struct({ id: Schema.String }),
      });
      if (known === undefined) {
        return Option.none();
      }
      const id = yield* findTopLevelThread(database.value, threadId);
      const [row] = yield* queryCodexDatabase({
        database: database.value,
        query: (sql) => sql`SELECT name, title FROM threads WHERE id = ${id}`,
        row: Schema.Struct({ name: Schema.NullOr(Schema.String), title: Schema.String }),
      });
      const { shownName } = nameThread({
        id,
        name: row?.name ?? null,
        title: row?.title ?? "",
        indexName: (yield* readThreadNames).get(id),
      });
      return Option.some({ id, name: shownName });
    });

  const listThreads = ({
    archived,
    matching,
  }: {
    readonly archived: boolean;
    readonly matching: (
      names: ReadonlyMap<string, string>,
    ) => Option.Option<{ readonly ids: readonly string[]; readonly name: string }>;
  }) =>
    Effect.gen(function* () {
      const database = yield* findStateDatabase(root);
      if (Option.isNone(database)) {
        return [];
      }
      const names = yield* readThreadNames;
      const filter = matching(names);
      const rows = yield* queryCodexDatabase({
        database: database.value,
        query: (sql) => sql`SELECT t.id, t.name, t.title, t.source, t.cwd, t.rollout_path,
              (t.id IN (SELECT child_thread_id FROM thread_spawn_edges)
                OR t.source LIKE ${SUBAGENT_SOURCE_PATTERN}) AS is_subagent,
              CASE WHEN t.recency_at > 0 THEN t.recency_at ELSE t.updated_at END AS last_active,
              p.name AS project, s.name AS section
            FROM threads t
            LEFT JOIN projects p ON p.id = t.project_id
            LEFT JOIN thread_sections s ON s.id = t.thread_section_id
            WHERE t.archived = ${archived ? 1 : 0} AND ${Option.match(filter, {
              onNone: () => sql.and([]),
              onSome: ({ ids, name }) => sql.or([sql.in("t.id", ids), sql`trim(t.name) = ${name}`]),
            })}`,
        row: ThreadRow,
      });
      const projects = yield* readThreadProjects(root);
      const found = yield* Effect.forEach(
        rows,
        (row) =>
          Effect.gen(function* () {
            const { givenName, shownName } = nameThread({
              id: row.id,
              name: row.name,
              title: row.title,
              indexName: names.get(row.id),
            });
            const isSubagent = row.is_subagent === 1;
            const isDesktopTask = row.source === DESKTOP_THREAD_SOURCE && !isSubagent;
            const isListed =
              (givenName !== undefined && !isSubagent) ||
              isDesktopTask ||
              Option.exists(filter, ({ ids }) => ids.includes(row.id));
            if (!isListed) {
              return [];
            }
            const session = CodexSession.make({
              provider: "Codex",
              id: row.id,
              name: shownName,
              status: archived ? "archived" : yield* describeTurn(row.id),
              project: row.project ?? projects.get(row.id) ?? "",
              section: row.section ?? "",
              directory: row.cwd,
              transcript: Option.some(row.rollout_path),
              lastActiveAt: new Date(row.last_active * MILLISECONDS_PER_SECOND).toISOString(),
              handle: CodexRollout.make({ file: row.rollout_path }),
            });
            return [session];
          }),
        { concurrency: STATUS_READ_CONCURRENCY },
      );
      return found.flat();
    });

  const isThreadArchived = ({
    database,
    threadId,
    archived,
  }: {
    readonly database: string;
    readonly threadId: string;
    readonly archived: boolean;
  }) =>
    Effect.gen(function* () {
      const [row] = yield* queryCodexDatabase({
        database,
        query: (sql) => sql`SELECT archived, rollout_path FROM threads WHERE id = ${threadId}`,
        row: Schema.Struct({ archived: Schema.Int, rollout_path: Schema.String }),
      });
      if (row === undefined) {
        return false;
      }
      const archivedFlag = archived ? 1 : 0;
      return row.archived === archivedFlag && (yield* fileSystem.exists(row.rollout_path));
    });

  const waitUntilThreadSettles = (thread: {
    readonly database: string;
    readonly threadId: string;
    readonly archived: boolean;
  }) =>
    waitUntil({
      watch: Effect.map(
        queryCodexDatabase({
          database: thread.database,
          query: (sql) => sql`SELECT rollout_path FROM threads WHERE id = ${thread.threadId}`,
          row: Schema.Struct({ rollout_path: Schema.String }),
        }),
        (rows) => [root, ...rows.map((row) => row.rollout_path)],
      ),
      done: isThreadArchived(thread),
    });

  const waitForDelivery = <Failure, Requirements>({
    rollout,
    startOffset,
    wasTurnRunning,
    tool,
    callId,
    prompt,
  }: {
    readonly rollout: Effect.Effect<Option.Option<string>, Failure, Requirements>;
    readonly startOffset: bigint;
    readonly wasTurnRunning: boolean;
    readonly tool: string;
    readonly callId: string;
    readonly prompt: string;
  }) =>
    Effect.gen(function* () {
      const readAppendedLines = yield* makeAppendedLineReader(startOffset);
      const isTurnRunningNow = yield* Ref.make(wasTurnRunning);
      const deliveryOf = deliveryFinder({ tool, callId, prompt });
      return yield* waitFor({
        watch: Effect.map(rollout, (path) => (Option.isSome(path) ? [path.value] : [root])),
        check: Effect.gen(function* () {
          const path = yield* rollout;
          const lines = Option.isSome(path) ? yield* readAppendedLines(path.value) : [];
          const lastTurnEvent = lines
            .flatMap((line) => Option.toArray(decodeTurnEvent(line)))
            .at(-1);
          if (lastTurnEvent !== undefined) {
            yield* Ref.set(isTurnRunningNow, lastTurnEvent.payload.type === "task_started");
          }
          if (lines.some((line) => Option.isSome(deliveryOf(line)))) {
            return Option.some(DELIVERED);
          }
          return (yield* Ref.get(isTurnRunningNow)) ? Option.some(ACCEPTED) : Option.none();
        }),
      });
    });

  const archiveThread = ({
    database,
    threadId,
  }: {
    readonly database: string;
    readonly threadId: string;
  }) => {
    const archive = callTool({
      callerOutsideTasks: threadId,
      call: {
        tool: "set_thread_archived",
        toolArguments: { threadId, source: "codex", hostId: "local", archived: true },
      },
    });
    return archiveWithRetries(archive, threadId).pipe(
      Effect.catchTag("CodexArchiveStillLocked", (locked) =>
        Effect.flatMap(isThreadArchived({ database, threadId, archived: true }), (archived) =>
          archived ? Effect.void : Effect.fail(locked),
        ),
      ),
      Effect.andThen(waitUntilThreadSettles({ database, threadId, archived: true })),
    );
  };

  const archiveHelperAfterFailure = Effect.fn("codex.archiveHelperAfterFailure")(function* ({
    database,
    threadId,
  }: {
    readonly database: string;
    readonly threadId: string;
  }) {
    const archived = yield* Effect.exit(archiveThread({ database, threadId }));
    yield* Effect.annotateCurrentSpan({
      "nudge.codex.helperThreadId": threadId,
      "nudge.codex.helper.archived": Exit.isSuccess(archived),
    });
  });

  const archiveHelperAfterStart = Effect.fn("codex.archiveHelperAfterStart")(function* ({
    database,
    threadId,
  }: {
    readonly database: string;
    readonly threadId: string;
  }) {
    const archived = yield* Effect.exit(archiveThread({ database, threadId }));
    yield* Effect.annotateCurrentSpan({
      "nudge.codex.helperThreadId": threadId,
      "nudge.codex.helper.archived": Exit.isSuccess(archived),
    });
    return Exit.isSuccess(archived) ? [] : [new CodexHelperStillUnarchived({ threadId })];
  });

  const chooseCaller = Effect.fn("codex.chooseCaller")(function* ({
    database,
    isFullAccess,
  }: {
    readonly database: string;
    readonly isFullAccess: boolean;
  }) {
    yield* Effect.annotateCurrentSpan({
      "nudge.codex.caller.fullAccessRequired": isFullAccess,
      "nudge.codex.helper.started": false,
    });
    if (!isFullAccess) {
      const caller = yield* findNewestTopLevelThread(database);
      yield* Effect.annotateCurrentSpan({
        "nudge.codex.caller.id": caller,
        "nudge.codex.caller.reason": "newest-top-level-task",
      });
      return { caller, helper: Option.none<string>() };
    }
    const loaded = yield* findFullAccessCaller({ socket, database });
    if (Option.isSome(loaded)) {
      yield* Effect.annotateCurrentSpan({
        "nudge.codex.caller.id": loaded.value,
        "nudge.codex.caller.reason": "loaded-full-access-task",
      });
      return { caller: loaded.value, helper: Option.none<string>() };
    }
    const helper = yield* startFullAccessCaller({
      root,
      socket,
      database,
      creator: yield* findNewestTopLevelThread(database),
      archiveAfterFailure: (threadId) => archiveHelperAfterFailure({ database, threadId }),
    });
    yield* Effect.annotateCurrentSpan({
      "nudge.codex.caller.id": helper,
      "nudge.codex.caller.reason": "started-helper",
      "nudge.codex.helper.started": true,
    });
    return { caller: helper, helper: Option.some(helper) };
  });

  const readStartingPoint = Effect.gen(function* () {
    const path = yield* requireStateDatabase;
    const isOutsideTasks = Option.isNone(yield* CODEX_THREAD_ID);
    return { path, isOutsideTasks };
  });

  const app = {
    list: listThreads({ archived: false, matching: () => Option.none() }).pipe(
      Effect.provide(services),
    ),

    listArchived: listThreads({ archived: true, matching: () => Option.none() }).pipe(
      Effect.provide(services),
    ),

    findReplyThread: (threadId: string) => findReplyThread(threadId).pipe(Effect.provide(services)),

    findTarget: (target: string) =>
      listThreads({ archived: false, matching: matchingTarget(target) }).pipe(
        Effect.provide(services),
      ),

    findArchived: (target: string) =>
      listThreads({ archived: true, matching: matchingTarget(target) }).pipe(
        Effect.provide(services),
      ),

    unarchive: Effect.fn("codex.unarchive")(function* (session: typeof CodexSession.Type) {
      const database = yield* requireStateDatabase;
      const desktopFailure = yield* callTool({
        callerOutsideTasks: session.id,
        call: {
          tool: "set_thread_archived",
          toolArguments: {
            threadId: session.id,
            source: "codex",
            hostId: "local",
            archived: false,
          },
        },
      }).pipe(
        Effect.as(Option.none()),
        Effect.catchTag("CodexDesktopDidNotLoadUnarchivedThread", (error) =>
          Effect.succeedSome(error.message),
        ),
      );
      const isUnarchived = yield* isThreadArchived({
        database,
        threadId: session.id,
        archived: false,
      });
      yield* Effect.annotateCurrentSpan({
        "nudge.session.id": session.id,
        "nudge.codex.unarchive.applied": isUnarchived,
        "nudge.codex.unarchive.desktopFailure": Option.isSome(desktopFailure),
      });
      if (!isUnarchived) {
        const reply = Option.getOrElse(desktopFailure, () => "set_thread_archived succeeded");
        return yield* new CodexUnarchiveNotApplied({ threadId: session.id, database, reply });
      }
    }, Effect.provide(services)),

    listModels: Effect.gen(function* () {
      yield* readStartingPoint;
      return yield* listOfferedModels();
    }).pipe(Effect.provide(services)),

    create: Effect.fn("codex.create")(function* ({
      prompt,
      sender,
      name,
      model,
      effort,
      speed,
    }: {
      readonly prompt: string;
      readonly sender: Option.Option<typeof Sender.Type>;
      readonly name: Option.Option<string>;
      readonly model: Option.Option<string>;
      readonly effort: Option.Option<string>;
      readonly speed: typeof Speed.Type;
    }) {
      const { path, isOutsideTasks } = yield* readStartingPoint;
      const callId = yield* (yield* SecureRandom.SecureRandom).uuidV4();
      const firstPrompt = envelopeForNewSession({ prompt, sender });
      const chosenProject = yield* chooseProject({
        caller: yield* findNewestTopLevelThread(path),
        here: process.cwd(),
      });
      yield* Effect.annotateCurrentSpan("nudge.codex.inProject", Option.isSome(chosenProject));
      const defaults = isOutsideTasks
        ? yield* readDefaultPermissions({
            root,
            directory: Option.filter(
              Option.map(chosenProject, (found) => found.path),
              (projectPath) => projectPath !== "",
            ),
            model,
            workspaceKind: Option.isSome(chosenProject) ? "project" : "projectless",
          })
        : { isFullAccess: false };
      const { threadId, helperWarnings } = yield* Effect.scoped(
        Effect.gen(function* () {
          const { caller, helper } = yield* chooseCaller({
            database: path,
            isFullAccess: defaults.isFullAccess,
          });
          yield* Effect.annotateCurrentSpan({
            "nudge.codex.caller.id": caller,
            "nudge.codex.helper.started": Option.isSome(helper),
            "nudge.codex.permission.source": isOutsideTasks ? "desktop-defaults" : "calling-task",
            "nudge.codex.permission.fullAccessRequired": defaults.isFullAccess,
          });
          const reply = yield* callTool({
            callerOutsideTasks: caller,
            callId,
            call: {
              tool: "create_thread",
              toolArguments: {
                prompt: firstPrompt,
                target: Option.match(chosenProject, {
                  onNone: () => ({ type: "projectless" as const }),
                  onSome: (found) => ({
                    type: "project" as const,
                    projectId: found.id,
                    environment: { type: "local" as const },
                  }),
                }),
                title: Option.getOrUndefined(name),
                model: Option.getOrUndefined(model),
                thinking: Option.getOrUndefined(effort),
              },
            },
          });
          const created = yield* Schema.decodeEffect(Created)(reply);
          const helperLeftOpen = Option.isSome(helper)
            ? yield* archiveHelperAfterStart({ database: path, threadId: helper.value })
            : [];
          return {
            threadId: created.threadId,
            helperWarnings: helperLeftOpen,
          };
        }),
      );
      yield* Effect.annotateCurrentSpan("nudge.session.id", threadId);
      yield* waitForDelivery({
        rollout: queryCodexDatabase({
          database: path,
          query: (sql) => sql`SELECT rollout_path FROM threads WHERE id = ${threadId}`,
          row: Schema.Struct({ rollout_path: Schema.String }),
        }).pipe(
          Effect.map(([row]) =>
            Option.map(Option.fromNullishOr(row), (found) => found.rollout_path),
          ),
        ),
        startOffset: START_OF_FILE,
        wasTurnRunning: false,
        tool: "create_thread",
        callId,
        prompt: firstPrompt,
      });
      if (defaults.isFullAccess) {
        yield* requireFirstTurnFullAccess({ root, socket, database: path, threadId }).pipe(
          Effect.catchTag("CodexTaskNotGivenFullAccess", (error) =>
            Effect.gen(function* () {
              yield* Effect.annotateCurrentSpan({
                "nudge.codex.rejected.reason": "not-full-access",
                "nudge.codex.rejected.archived": false,
              });
              yield* archiveThread({ database: path, threadId });
              yield* Effect.annotateCurrentSpan("nudge.codex.rejected.archived", true);
              return yield* new CodexTaskNotGivenFullAccess({
                threadId: error.threadId,
                approvalPolicy: error.approvalPolicy,
                sandbox: error.sandbox,
                archived: true,
              });
            }),
          ),
        );
      }
      const speedWarnings = yield* settleFirstTurnSpeed({
        root,
        socket,
        database: path,
        threadId,
        speed,
      });
      const [thread] = yield* queryCodexDatabase({
        database: path,
        query: (sql) => sql`SELECT cwd FROM threads WHERE id = ${threadId}`,
        row: Schema.Struct({ cwd: Schema.String }),
      });
      return {
        id: threadId,
        name,
        directory: thread?.cwd ?? "",
        isOutsideAnyProject: Option.isNone(chosenProject),
        warnings: [...helperWarnings, ...speedWarnings],
      };
    }, Effect.provide(services)),

    checkSend: Effect.fn("codex.checkSend")(function* ({
      session,
      model,
      effort,
      speed,
    }: {
      readonly session: typeof CodexSession.Type;
      readonly model: Option.Option<string>;
      readonly effort: Option.Option<string>;
      readonly speed: Option.Option<typeof Speed.Type>;
    }) {
      yield* requireKnownModel({
        model,
        effort,
        speed,
        currentModel: readLatestModel(session.handle.file),
      });
    }, Effect.provide(services)),

    send: Effect.fn("codex.send")(function* ({
      session,
      message,
      sender,
      model,
      effort,
      speed,
    }: {
      readonly session: typeof CodexSession.Type;
      readonly message: string;
      readonly sender: Option.Option<typeof Sender.Type>;
      readonly model: Option.Option<string>;
      readonly effort: Option.Option<string>;
      readonly speed: Option.Option<typeof Speed.Type>;
    }) {
      const prompt = envelopeForCodex({ message, sender });
      const tierBefore = yield* readLatestTier(session.handle.file);
      const switched = yield* switchSpeedBeforeSend({
        socket,
        rollout: session.handle.file,
        threadId: session.id,
        before: tierBefore,
        speed,
      });
      const startOffset = yield* readByteLength(session.handle.file);
      const wasTurnRunning =
        session.status === "running" ||
        session.status === "waiting-for-input" ||
        session.status === "waiting-for-approval";
      const messageId = yield* (yield* SecureRandom.SecureRandom).uuidV4();
      const isStartingWithSpeed =
        Option.isSome(speed) && !wasTurnRunning && switched !== "not-loaded";
      const startedWithSpeed = isStartingWithSpeed
        ? yield* startMessageWithSpeed({
            socket,
            threadId: session.id,
            messageId,
            prompt,
            tier: yield* readLatestTier(session.handle.file),
            model,
            effort,
          })
        : false;
      const isUnloadedBeforeDelivery = isStartingWithSpeed && !startedWithSpeed;
      const switchedBeforeDelivery = isUnloadedBeforeDelivery ? "not-loaded" : switched;
      yield* Effect.annotateCurrentSpan({
        "nudge.message.id": messageId,
        "nudge.session.id": session.id,
        "nudge.delivery.path": startedWithSpeed ? "desktop-ipc" : "desktop-app-tool",
        "nudge.delivery.turnRunning": wasTurnRunning,
        "nudge.codex.speedBeforeSend": switchedBeforeDelivery,
      });
      if (!startedWithSpeed) {
        yield* callTool({
          callerOutsideTasks: session.id,
          callId: messageId,
          call: {
            tool: "send_message_to_thread",
            toolArguments: {
              threadId: session.id,
              prompt,
              model: Option.getOrUndefined(model),
              thinking: Option.getOrUndefined(effort),
            },
          },
        });
      }
      const status = yield* waitForDelivery({
        rollout: Effect.succeedSome(session.handle.file),
        startOffset,
        wasTurnRunning,
        tool: "send_message_to_thread",
        callId: messageId,
        prompt,
      });
      yield* Effect.annotateCurrentSpan("nudge.status", status);
      const warnings = yield* settleSpeedAfterSend({
        switched: switchedBeforeDelivery,
        wasTurnRunning,
        socket,
        rollout: session.handle.file,
        threadId: session.id,
        startOffset,
        deliveryOf: deliveryFinder({ tool: "send_message_to_thread", callId: messageId, prompt }),
        before: tierBefore,
        speed,
      });
      return { messageId, status, warnings };
    }, Effect.provide(services)),

    readModelChoice: (session: typeof CodexSession.Type) =>
      readLatestChoice(session.handle.file).pipe(Effect.provide(services)),

    rename: Effect.fn("codex.rename")(function* ({
      session,
      name,
    }: {
      readonly session: typeof CodexSession.Type;
      readonly name: string;
    }) {
      yield* callTool({
        callerOutsideTasks: session.id,
        call: { tool: "set_thread_title", toolArguments: { threadId: session.id, title: name } },
      });
    }, Effect.provide(services)),

    archive: Effect.fn("codex.archive")(function* (session: typeof CodexSession.Type) {
      yield* archiveThread({ database: yield* requireStateDatabase, threadId: session.id });
    }, Effect.provide(services)),
  };
  return app;
});

export class Codex extends Context.Service<Codex, Effect.Success<typeof make>>()("nudge/Codex") {}

export const codexLayer = Layer.effect(Codex, make);
