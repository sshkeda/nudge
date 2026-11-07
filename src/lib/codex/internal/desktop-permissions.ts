import { Cause, Effect, Exit, Fiber, FileSystem, Option, Schema } from "effect";

import { readLastCompleteLines } from "../../../shared/transcript.ts";
import { waitFor } from "../../../shared/wait-until.ts";
import { callTool } from "./call-app-tool.ts";
import { askCodexDesktop, requireSuccess } from "./codex-desktop-ipc.ts";
import { queryCodexDatabase } from "./codex-state-database.ts";
import {
  CodexDesktopIpcRefused,
  CodexTaskNotGivenFullAccess,
  CodexTurnNotStopped,
} from "./errors.ts";
import { FULL_ACCESS } from "./read-default-permissions.ts";

const OWNER_DISCOVERY = { method: "thread-owner-discovery", version: 1 } as const;

export const UPDATE_THREAD_PERMISSIONS = {
  method: "thread-follower-update-thread-settings",
  version: 2,
} as const;

const INTERRUPT_TURN = { method: "thread-follower-interrupt-turn", version: 3 } as const;

const INTERRUPT_UNCONFIRMED = `${INTERRUPT_TURN.method}-timeout`;

const UNCONFIRMED_STOP_WAIT = "30 seconds";

const HELPER_CREATE_WAIT_AFTER_FAILURE = "10 seconds";

const NO_CLIENT_FOUND = "no-client-found";

const FULL_ACCESS_PERMISSIONS = {
  permissions: FULL_ACCESS.profile,
  approvalPolicy: FULL_ACCESS.approvalPolicy,
  approvalsReviewer: "user",
} as const;

const CALLER_CANDIDATES = 20;

const APPROVAL_POLICIES_FOR_TRACE = new Set(["never", "on-request", "on-failure", "untrusted"]);

const SANDBOXES_FOR_TRACE = new Set([
  "danger-full-access",
  "workspace-write",
  "read-only",
  "external-sandbox",
]);

const approvalPolicyForTrace = (value: string) =>
  APPROVAL_POLICIES_FOR_TRACE.has(value) ? value : "unknown";

const sandboxForTrace = (value: string) => (SANDBOXES_FOR_TRACE.has(value) ? value : "unknown");

const profileForTrace = (value: string | undefined) => {
  if (value === FULL_ACCESS.profile) {
    return FULL_ACCESS.profile;
  }
  return value === undefined ? "missing" : "other";
};

const HELPER_TITLE = "Nudge permissions helper";

const HELPER_FIRST_PROMPT =
  "Nudge started this session to give the session it starts next your default permissions, and archives it afterwards. Don't do anything.";

const HELPER_SWITCH_PROMPT =
  "Nudge switched this session to your default permissions. Don't do anything.";

const Created = Schema.fromJsonString(Schema.Struct({ threadId: Schema.String }));

const TurnContextLine = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.Literal("turn_context"),
    payload: Schema.Struct({
      turn_id: Schema.String,
      approval_policy: Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.Unknown)]),
      sandbox_policy: Schema.Struct({ type: Schema.String }),
      active_permission_profile: Schema.optional(Schema.Struct({ id: Schema.String })),
    }),
  }),
);

const TurnEndLine = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.Literal("event_msg"),
    payload: Schema.Struct({
      type: Schema.Literals(["task_complete", "turn_aborted"]),
      turn_id: Schema.String,
    }),
  }),
);

const decodeTurnContextLine = Schema.decodeUnknownOption(TurnContextLine);

export const decodeTurnEndLine = Schema.decodeUnknownOption(TurnEndLine);

export const PermissionsUpdated = Schema.Struct({ applied: Schema.Literal(true) });

const Interrupted = Schema.Struct({ ok: Schema.Literal(true) });

const readTurnPermissions = (rollout: string) =>
  Effect.map(readLastCompleteLines(rollout), (lines) =>
    Option.getOrElse(lines, () => []).flatMap((line) => {
      if (!line.includes('"type":"turn_context"')) {
        return [];
      }
      return Option.match(decodeTurnContextLine(line), {
        onNone: () => [],
        onSome: ({ payload }) => [
          {
            turnId: payload.turn_id,
            approvalPolicy:
              typeof payload.approval_policy === "string"
                ? payload.approval_policy
                : Object.keys(payload.approval_policy).join(" "),
            sandbox: payload.sandbox_policy.type,
            profile: payload.active_permission_profile?.id,
          },
        ],
      });
    }),
  );

const isFullAccess = (turn: Effect.Success<ReturnType<typeof readTurnPermissions>>[number]) =>
  turn.approvalPolicy === FULL_ACCESS.approvalPolicy && turn.sandbox === FULL_ACCESS.sandbox;

const canDelegateFullAccess = (
  turn: Effect.Success<ReturnType<typeof readTurnPermissions>>[number],
) => isFullAccess(turn) && turn.profile === FULL_ACCESS.profile;

const requireFullAccess = ({
  threadId,
  turn,
}: {
  readonly threadId: string;
  readonly turn: Effect.Success<ReturnType<typeof readTurnPermissions>>[number];
}) =>
  isFullAccess(turn)
    ? Effect.void
    : Effect.fail(
        new CodexTaskNotGivenFullAccess({
          threadId,
          approvalPolicy: turn.approvalPolicy,
          sandbox: turn.sandbox,
        }),
      );

export const waitForRollout = ({
  root,
  database,
  threadId,
}: {
  readonly root: string;
  readonly database: string;
  readonly threadId: string;
}) =>
  waitFor({
    watch: Effect.map(
      queryCodexDatabase({
        database,
        query: (sql) => sql`SELECT rollout_path FROM threads WHERE id = ${threadId}`,
        row: Schema.Struct({ rollout_path: Schema.String }),
      }),
      (rows) => [root, ...rows.map((row) => row.rollout_path)],
    ),
    check: Effect.gen(function* () {
      const [row] = yield* queryCodexDatabase({
        database,
        query: (sql) => sql`SELECT rollout_path FROM threads WHERE id = ${threadId}`,
        row: Schema.Struct({ rollout_path: Schema.String }),
      });
      const fileSystem = yield* FileSystem.FileSystem;
      const exists = row !== undefined && (yield* fileSystem.exists(row.rollout_path));
      return exists ? Option.some(row.rollout_path) : Option.none();
    }),
  });

const waitForNextTurn = ({
  rollout,
  seenTurns,
}: {
  readonly rollout: string;
  readonly seenTurns: number;
}) =>
  waitFor({
    watch: Effect.succeed([rollout]),
    check: Effect.map(readTurnPermissions(rollout), (turns) =>
      Option.fromNullishOr(turns[seenTurns]),
    ),
  });

const waitForTurnEnd = ({
  rollout,
  turnId,
}: {
  readonly rollout: string;
  readonly turnId: string;
}) =>
  waitFor({
    watch: Effect.succeed([rollout]),
    check: Effect.map(readLastCompleteLines(rollout), (lines) =>
      Option.getOrElse(lines, () => []).some((line) =>
        Option.exists(decodeTurnEndLine(line), ({ payload }) => payload.turn_id === turnId),
      )
        ? Option.some(true)
        : Option.none(),
    ),
  });

export const askForResult = <ResultSchema extends Schema.Top>({
  socket,
  request,
  parameters,
  result,
}: {
  readonly socket: string;
  readonly request: { readonly method: string; readonly version: number };
  readonly parameters: unknown;
  readonly result: ResultSchema;
}) =>
  askCodexDesktop({ socket, ...request, parameters }).pipe(
    Effect.flatMap((answer) => requireSuccess({ method: request.method, answer })),
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(result)(value).pipe(
        Effect.mapError(
          (error) =>
            new CodexDesktopIpcRefused({
              method: request.method,
              error: `its answer doesn't match what nudge expects: ${error.message}`,
            }),
        ),
      ),
    ),
  );

const isLoadedInDesktop = ({
  socket,
  threadId,
}: {
  readonly socket: string;
  readonly threadId: string;
}) =>
  askCodexDesktop({
    socket,
    ...OWNER_DISCOVERY,
    parameters: { hostId: "local", conversationId: threadId },
  }).pipe(
    Effect.flatMap((answer) => {
      const isNotLoaded = answer.resultType === "error" && answer.error === NO_CLIENT_FOUND;
      return isNotLoaded
        ? Effect.succeed(false)
        : Effect.as(requireSuccess({ method: OWNER_DISCOVERY.method, answer }), true);
    }),
  );

const stopTurn = Effect.fn("codex.stopTurn")(function* ({
  socket,
  rollout,
  threadId,
  turnId,
}: {
  readonly socket: string;
  readonly rollout: string;
  readonly threadId: string;
  readonly turnId: string;
}) {
  const confirmed = yield* askForResult({
    socket,
    request: INTERRUPT_TURN,
    parameters: { conversationId: threadId, expectedTurnId: turnId },
    result: Interrupted,
  }).pipe(
    Effect.as(true),
    Effect.catchTag("CodexDesktopIpcRefused", (error) =>
      error.error === INTERRUPT_UNCONFIRMED ? Effect.succeed(false) : Effect.fail(error),
    ),
  );
  yield* Effect.annotateCurrentSpan("nudge.codex.interrupt.confirmed", confirmed);
  if (confirmed) {
    return yield* waitForTurnEnd({ rollout, turnId });
  }
  return yield* waitForTurnEnd({ rollout, turnId }).pipe(
    Effect.timeoutOrElse({
      duration: UNCONFIRMED_STOP_WAIT,
      orElse: () =>
        Effect.fail(new CodexTurnNotStopped({ threadId, turnId, waited: UNCONFIRMED_STOP_WAIT })),
    }),
  );
});

export const findFullAccessCaller = Effect.fn("codex.findFullAccessCaller")(function* ({
  socket,
  database,
}: {
  readonly socket: string;
  readonly database: string;
}) {
  const rows = yield* queryCodexDatabase({
    database,
    query: (sql) => sql`SELECT id, rollout_path FROM threads
      WHERE archived = 0 AND id NOT IN (SELECT child_thread_id FROM thread_spawn_edges)
      ORDER BY updated_at DESC LIMIT ${CALLER_CANDIDATES}`,
    row: Schema.Struct({ id: Schema.String, rollout_path: Schema.String }),
  });
  const candidates = rows.map((candidate) => ({
    id: candidate.id,
    rollout_path: candidate.rollout_path,
    trace: {
      reason: "not-checked",
      approvalPolicy: "not-read",
      sandbox: "not-read",
      profile: "not-read",
    },
  }));
  const annotateCandidates = () =>
    Effect.annotateCurrentSpan({
      "nudge.codex.candidate.ids": candidates.map((candidate) => candidate.id),
      "nudge.codex.candidate.reasons": candidates.map((candidate) => candidate.trace.reason),
      "nudge.codex.candidate.approvalPolicies": candidates.map(
        (candidate) => candidate.trace.approvalPolicy,
      ),
      "nudge.codex.candidate.sandboxes": candidates.map((candidate) => candidate.trace.sandbox),
      "nudge.codex.candidate.profiles": candidates.map((candidate) => candidate.trace.profile),
    });
  yield* annotateCandidates();
  yield* Effect.annotateCurrentSpan({
    "nudge.codex.candidate.count": candidates.length,
    "nudge.codex.helper.started": false,
  });
  const fullAccessCandidates = yield* Effect.filter(candidates, (candidate) =>
    Effect.gen(function* () {
      const turns = yield* readTurnPermissions(candidate.rollout_path);
      const lastTurn = turns.at(-1);
      const fullAccess = lastTurn !== undefined && isFullAccess(lastTurn);
      const canDelegate = lastTurn !== undefined && canDelegateFullAccess(lastTurn);
      candidate.trace.reason = "not-full-access-in-last-turn";
      if (fullAccess) {
        candidate.trace.reason = "missing-full-access-profile";
      }
      if (canDelegate) {
        candidate.trace.reason = "checking-desktop";
      }
      candidate.trace.approvalPolicy =
        lastTurn === undefined ? "missing" : approvalPolicyForTrace(lastTurn.approvalPolicy);
      candidate.trace.sandbox =
        lastTurn === undefined ? "missing" : sandboxForTrace(lastTurn.sandbox);
      candidate.trace.profile =
        lastTurn === undefined ? "missing" : profileForTrace(lastTurn.profile);
      yield* annotateCandidates();
      return canDelegate;
    }),
  );
  if (fullAccessCandidates.length === 0) {
    yield* Effect.annotateCurrentSpan("nudge.codex.caller.reason", "no-full-access-candidates");
    return Option.none<string>();
  }
  return yield* Effect.raceAll(
    fullAccessCandidates.map((candidate) =>
      isLoadedInDesktop({ socket, threadId: candidate.id }).pipe(
        Effect.tap((loaded) => {
          candidate.trace.reason = loaded ? "loaded-full-access" : "not-loaded-in-desktop";
          return annotateCandidates();
        }),
        Effect.onInterrupt(() => {
          candidate.trace.reason = "desktop-check-interrupted";
          return annotateCandidates();
        }),
        Effect.filterOrFail(
          (isLoaded) => isLoaded,
          () => new Cause.NoSuchElementError(),
        ),
        Effect.as(candidate.id),
      ),
    ),
  ).pipe(
    Effect.tap((caller) =>
      Effect.annotateCurrentSpan({
        "nudge.codex.caller.id": caller,
        "nudge.codex.caller.reason": "loaded-full-access-task",
      }),
    ),
    Effect.asSome,
    Effect.catchTag("NoSuchElementError", () =>
      Effect.annotateCurrentSpan(
        "nudge.codex.caller.reason",
        "no-loaded-full-access-candidates",
      ).pipe(Effect.andThen(Effect.succeedNone)),
    ),
  );
});

const archiveOnceCreated = <CreateError, ArchiveRequirement>({
  creating,
  archiveAfterFailure,
}: {
  readonly creating: Fiber.Fiber<string, CreateError>;
  readonly archiveAfterFailure: (
    threadId: string,
  ) => Effect.Effect<void, never, ArchiveRequirement>;
}) =>
  Fiber.await(creating).pipe(
    Effect.timeoutOption(HELPER_CREATE_WAIT_AFTER_FAILURE),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.annotateCurrentSpan("nudge.codex.helper.createUnanswered", true).pipe(
            Effect.andThen(Fiber.interrupt(creating)),
          ),
        onSome: (created) =>
          Exit.isSuccess(created) ? archiveAfterFailure(created.value) : Effect.void,
      }),
    ),
  );

export const startFullAccessCaller = Effect.fn("codex.startFullAccessCaller")(function* <
  ArchiveRequirement,
>({
  root,
  socket,
  database,
  creator,
  archiveAfterFailure,
}: {
  readonly root: string;
  readonly socket: string;
  readonly database: string;
  readonly creator: string;
  readonly archiveAfterFailure: (
    threadId: string,
  ) => Effect.Effect<void, never, ArchiveRequirement>;
}) {
  const creating = yield* Effect.acquireRelease(
    Effect.forkScoped(
      callTool({
        callerOutsideTasks: creator,
        call: {
          tool: "create_thread",
          toolArguments: {
            prompt: HELPER_FIRST_PROMPT,
            target: { type: "projectless" },
            title: HELPER_TITLE,
          },
        },
      }).pipe(
        Effect.flatMap((created) => Schema.decodeEffect(Created)(created)),
        Effect.map((created) => created.threadId),
      ),
    ),
    (fiber, exit) =>
      Exit.isFailure(exit)
        ? archiveOnceCreated({ creating: fiber, archiveAfterFailure })
        : Effect.void,
  );
  const threadId = yield* Fiber.join(creating);
  yield* Effect.annotateCurrentSpan("nudge.codex.helperThreadId", threadId);
  const rollout = yield* waitForRollout({ root, database, threadId });
  const firstTurn = yield* waitForNextTurn({ rollout, seenTurns: 0 });
  yield* Effect.annotateCurrentSpan({
    "nudge.codex.helper.started": true,
    "nudge.codex.caller.id": threadId,
    "nudge.codex.permission.approvalPolicy": approvalPolicyForTrace(firstTurn.approvalPolicy),
    "nudge.codex.permission.sandbox": sandboxForTrace(firstTurn.sandbox),
    "nudge.codex.permission.profile": profileForTrace(firstTurn.profile),
    "nudge.codex.permission.updateRequired": !canDelegateFullAccess(firstTurn),
    "nudge.codex.permission.delegationVerified": canDelegateFullAccess(firstTurn),
  });
  yield* stopTurn({ socket, rollout, threadId, turnId: firstTurn.turnId });
  if (canDelegateFullAccess(firstTurn)) {
    return threadId;
  }
  yield* askForResult({
    socket,
    request: UPDATE_THREAD_PERMISSIONS,
    parameters: { conversationId: threadId, threadSettings: FULL_ACCESS_PERMISSIONS },
    result: PermissionsUpdated,
  });
  yield* Effect.annotateCurrentSpan({
    "nudge.codex.permission.applied": true,
    "nudge.codex.permission.appliedApprovalPolicy": FULL_ACCESS.approvalPolicy,
    "nudge.codex.permission.appliedSandbox": FULL_ACCESS.sandbox,
  });
  yield* callTool({
    callerOutsideTasks: threadId,
    call: {
      tool: "send_message_to_thread",
      toolArguments: { threadId, prompt: HELPER_SWITCH_PROMPT },
    },
  });
  const switchedTurn = yield* waitForNextTurn({ rollout, seenTurns: 1 });
  yield* stopTurn({ socket, rollout, threadId, turnId: switchedTurn.turnId });
  yield* Effect.annotateCurrentSpan({
    "nudge.codex.permission.verified": isFullAccess(switchedTurn),
    "nudge.codex.permission.approvalPolicy": approvalPolicyForTrace(switchedTurn.approvalPolicy),
    "nudge.codex.permission.sandbox": sandboxForTrace(switchedTurn.sandbox),
    "nudge.codex.permission.profile": profileForTrace(switchedTurn.profile),
    "nudge.codex.permission.delegationVerified": canDelegateFullAccess(switchedTurn),
  });
  yield* requireFullAccess({ threadId, turn: switchedTurn });
  if (!canDelegateFullAccess(switchedTurn)) {
    return yield* new CodexDesktopIpcRefused({
      method: UPDATE_THREAD_PERMISSIONS.method,
      error: `session ${threadId} ran without the ${FULL_ACCESS.profile} profile after nudge applied it`,
    });
  }
  return threadId;
});

export const requireFirstTurnFullAccess = Effect.fn("codex.requireFirstTurnFullAccess")(function* ({
  root,
  socket,
  database,
  threadId,
}: {
  readonly root: string;
  readonly socket: string;
  readonly database: string;
  readonly threadId: string;
}) {
  const rollout = yield* waitForRollout({ root, database, threadId });
  const firstTurn = yield* waitForNextTurn({ rollout, seenTurns: 0 });
  yield* Effect.annotateCurrentSpan({
    "nudge.session.id": threadId,
    "nudge.codex.permission.approvalPolicy": approvalPolicyForTrace(firstTurn.approvalPolicy),
    "nudge.codex.permission.sandbox": sandboxForTrace(firstTurn.sandbox),
    "nudge.codex.permission.profile": profileForTrace(firstTurn.profile),
    "nudge.codex.permission.verified": isFullAccess(firstTurn),
  });
  if (!isFullAccess(firstTurn)) {
    yield* stopTurn({ socket, rollout, threadId, turnId: firstTurn.turnId });
  }
  yield* requireFullAccess({ threadId, turn: firstTurn });
});
