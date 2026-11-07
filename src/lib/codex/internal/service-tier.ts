import { Effect, Option, Ref, Schema } from "effect";

import { isFastRequest } from "../../../shared/speed.ts";
import type { Speed } from "../../../shared/speed.ts";
import {
  foldLinesFromEnd,
  makeAppendedLineReader,
  readByteLength,
  START_OF_FILE,
} from "../../../shared/transcript.ts";
import { waitFor } from "../../../shared/wait-until.ts";
import {
  askForResult,
  decodeTurnEndLine,
  PermissionsUpdated,
  UPDATE_THREAD_PERMISSIONS,
  waitForRollout,
} from "./desktop-permissions.ts";
import type { CodexDesktopIpcRefused, CodexDesktopIpcUnreachable } from "./errors.ts";
import {
  CodexDesktopChoseFast,
  CodexSpeedAfterThisTurn,
  CodexSpeedNotSwitched,
  CodexSpeedUnconfirmed,
} from "./errors.ts";

const FAST_TIER = "priority";

const STANDARD_TIER = "default";

export const FAST_TIERS: ReadonlySet<string> = new Set([FAST_TIER, "fast", "ultrafast"]);

const SPEED_NAMES: ReadonlyMap<string, string> = new Map([
  [STANDARD_TIER, "Standard"],
  [FAST_TIER, "Fast"],
  ["fast", "Fast"],
  ["ultrafast", "Ultrafast"],
  ["flex", "Flex"],
]);

const TIERS = { fast: FAST_TIER, standard: STANDARD_TIER } as const satisfies Record<
  typeof Speed.Type,
  string
>;

const isFastTier = (tier: string) => FAST_TIERS.has(tier);

const NO_CLIENT_FOUND = "no-client-found";

export const describeSpeed = (tier: string) => SPEED_NAMES.get(tier) ?? tier;

const APPLIED_MARKER = '"type":"thread_settings_applied"';

const SWITCH_WAIT = "30 seconds";

const NEW_TURN_WAIT = "3 seconds";

export const STARTED_A_TURN = "started a turn";

export const STEERED_A_TURN = "steered a turn";

const AppliedLine = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.Literal("event_msg"),
    payload: Schema.Struct({
      type: Schema.Literal("thread_settings_applied"),
      thread_settings: Schema.Struct({
        model: Schema.optional(Schema.NullOr(Schema.String)),
        service_tier: Schema.optional(Schema.NullOr(Schema.String)),
        reasoning_effort: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    }),
  }),
);

const decodeAppliedLine = Schema.decodeUnknownOption(AppliedLine);

const appliedOf = (line: string) =>
  line.includes(APPLIED_MARKER)
    ? Option.map(decodeAppliedLine(line), ({ payload }) => payload.thread_settings)
    : Option.none();

const tierOf = (line: string) =>
  Option.map(appliedOf(line), (applied) => applied.service_tier ?? STANDARD_TIER);

const readLatest = (rollout: string, find: (line: string) => Option.Option<string>) =>
  foldLinesFromEnd({
    path: rollout,
    initial: Option.none<string>(),
    step: (latest, line) => {
      const found = find(line);
      return Effect.succeed(
        Option.isSome(found) ? { state: found, isDone: true } : { state: latest, isDone: false },
      );
    },
  });

export const readLatestTier = Effect.fn("codex.readLatestTier")(function* (rollout: string) {
  return yield* readLatest(rollout, tierOf);
});

export const readLatestChoice = Effect.fn("codex.readLatestChoice")(function* (rollout: string) {
  const applied = yield* foldLinesFromEnd({
    path: rollout,
    initial: Option.none<typeof AppliedLine.Type.payload.thread_settings>(),
    step: (found, line) => {
      const latest = appliedOf(line);
      return Effect.succeed(
        Option.isSome(latest) ? { state: latest, isDone: true } : { state: found, isDone: false },
      );
    },
  });
  return {
    model: Option.flatMap(applied, ({ model }) => Option.fromNullishOr(model)),
    effort: Option.flatMap(applied, (found) => Option.fromNullishOr(found.reasoning_effort)),
    speed: Option.map(applied, (found) => describeSpeed(found.service_tier ?? STANDARD_TIER)),
  };
});

export const readLatestModel = Effect.fn("codex.readLatestModel")(function* (rollout: string) {
  return (yield* readLatestChoice(rollout)).model;
});

const tierOrTurnEnd = (line: string): Option.Option<Option.Option<string>> => {
  const tier = tierOf(line);
  if (Option.isSome(tier)) {
    return Option.some(tier);
  }
  return Option.isSome(decodeTurnEndLine(line)) ? Option.some(Option.none()) : Option.none();
};

const waitForFirstTier = (rollout: string) =>
  Effect.gen(function* () {
    const readAppendedLines = yield* makeAppendedLineReader(START_OF_FILE);
    return yield* waitFor({
      watch: Effect.succeed([rollout]),
      check: Effect.map(
        readAppendedLines(rollout),
        (lines) =>
          lines.map((line) => tierOrTurnEnd(line)).find((found) => Option.isSome(found)) ??
          Option.none(),
      ),
    });
  });

const switchTier = Effect.fn("codex.switchTier")(function* ({
  socket,
  rollout,
  threadId,
  tier,
  current,
  outcome,
}: {
  readonly socket: string;
  readonly rollout: string;
  readonly threadId: string;
  readonly tier: string;
  readonly current: string;
  readonly outcome: typeof CodexSpeedNotSwitched.fields.outcome.Type;
}) {
  const startOffset = yield* readByteLength(rollout);
  const isBeforeSending = outcome === "not-sent";
  const notSwitched = (reason: string) =>
    new CodexSpeedNotSwitched({
      threadId,
      speed: describeSpeed(tier),
      current: describeSpeed(current),
      isStillFast: isFastTier(current) && !isFastTier(tier),
      reason,
      outcome,
    });
  yield* askForResult({
    socket,
    request: UPDATE_THREAD_PERMISSIONS,
    parameters: { conversationId: threadId, threadSettings: { serviceTier: tier } },
    result: PermissionsUpdated,
  }).pipe(
    Effect.catchTags({
      CodexDesktopIpcRefused: (refused) => {
        const isNotLoadedBeforeSending =
          isBeforeSending && refused.error.startsWith(NO_CLIENT_FOUND);
        return Effect.fail<CodexDesktopIpcRefused | CodexSpeedNotSwitched>(
          isNotLoadedBeforeSending ? refused : notSwitched(refused.message),
        );
      },
      CodexDesktopIpcUnreachable: (unreachable) =>
        Effect.fail<CodexDesktopIpcUnreachable | CodexSpeedNotSwitched>(
          isBeforeSending ? notSwitched(unreachable.message) : unreachable,
        ),
    }),
  );
  const readAppendedLines = yield* makeAppendedLineReader(startOffset);
  const lastRecorded = yield* Ref.make(Option.none<string>());
  const isRecorded = yield* waitFor({
    watch: Effect.succeed([rollout]),
    check: Effect.gen(function* () {
      const recorded = (yield* readAppendedLines(rollout)).flatMap((line) =>
        Option.toArray(tierOf(line)),
      );
      const latest = recorded.at(-1);
      if (latest !== undefined) {
        yield* Ref.set(lastRecorded, Option.some(latest));
      }
      return latest === tier ? Option.some(true) : Option.none();
    }),
  }).pipe(Effect.timeoutOrElse({ duration: SWITCH_WAIT, orElse: () => Effect.succeed(false) }));
  if (!isRecorded) {
    return yield* notSwitched(
      Option.match(yield* Ref.get(lastRecorded), {
        onNone: () => `Codex recorded no new speed within ${SWITCH_WAIT}`,
        onSome: (recorded) => `Codex recorded ${describeSpeed(recorded)} instead`,
      }),
    );
  }
});

const isWantedTier = ({
  applied,
  wanted,
  speed,
}: {
  readonly applied: Option.Option<string>;
  readonly wanted: string;
  readonly speed: Option.Option<typeof Speed.Type>;
}) =>
  Option.match(applied, {
    onNone: () => !isFastTier(wanted),
    onSome: (tier) => tier === wanted || (isFastRequest(speed) && isFastTier(tier)),
  });

const settleSpeed = ({
  socket,
  rollout,
  threadId,
  applied,
  turnTier,
  wanted,
  speed,
  isNewTask,
}: {
  readonly socket: string;
  readonly rollout: string;
  readonly threadId: string;
  readonly applied: Option.Option<string>;
  readonly turnTier: Option.Option<string>;
  readonly wanted: string;
  readonly speed: Option.Option<typeof Speed.Type>;
  readonly isNewTask: boolean;
}) =>
  Effect.gen(function* () {
    if (isWantedTier({ applied, wanted, speed })) {
      return [];
    }
    const current = Option.getOrElse(applied, () => STANDARD_TIER);
    yield* switchTier({
      socket,
      rollout,
      threadId,
      tier: wanted,
      current,
      outcome: isNewTask ? "started" : "sent",
    });
    const ranIn = Option.getOrElse(turnTier, () => STANDARD_TIER);
    const isLeavingFast = isFastTier(ranIn) && !isFastTier(wanted);
    return isLeavingFast
      ? [
          new CodexDesktopChoseFast({
            threadId,
            applied: describeSpeed(ranIn),
            speed: describeSpeed(wanted),
            isNewTask,
            isRequested: Option.isSome(speed),
          }),
        ]
      : [];
  });

export const settleFirstTurnSpeed = Effect.fn("codex.settleFirstTurnSpeed")(function* ({
  root,
  socket,
  database,
  threadId,
  speed,
}: {
  readonly root: string;
  readonly socket: string;
  readonly database: string;
  readonly threadId: string;
  readonly speed: typeof Speed.Type;
}) {
  const rollout = yield* waitForRollout({ root, database, threadId });
  const applied = yield* waitForFirstTier(rollout);
  return yield* settleSpeed({
    socket,
    rollout,
    threadId,
    applied,
    turnTier: applied,
    wanted: TIERS[speed],
    speed: Option.some(speed),
    isNewTask: true,
  });
});

const sentTurnOf = (
  lines: readonly string[],
  deliveryOf: (line: string) => Option.Option<string>,
): Option.Option<Option.Option<string>> => {
  const deliveries = lines.map((line) => deliveryOf(line));
  const started = deliveries.findIndex((delivery) => Option.contains(delivery, STARTED_A_TURN));
  if (started === -1) {
    const isSteered = deliveries.some((delivery) => Option.contains(delivery, STEERED_A_TURN));
    return isSteered ? Option.some(Option.none()) : Option.none();
  }
  const tiers = lines.map((line) => tierOf(line));
  const tier =
    tiers.slice(0, started).findLast((found) => Option.isSome(found)) ??
    tiers.slice(started + 1).find((found) => Option.isSome(found));
  return tier === undefined ? Option.none() : Option.some(tier);
};

const waitForSentTurn = ({
  rollout,
  startOffset,
  deliveryOf,
}: {
  readonly rollout: string;
  readonly startOffset: bigint;
  readonly deliveryOf: (line: string) => Option.Option<string>;
}) =>
  Effect.gen(function* () {
    const readAppendedLines = yield* makeAppendedLineReader(startOffset);
    const seen = yield* Ref.make<readonly string[]>([]);
    return yield* waitFor({
      watch: Effect.succeed([rollout]),
      check: Effect.gen(function* () {
        const appended = yield* readAppendedLines(rollout);
        const lines = yield* Ref.updateAndGet(seen, (earlier) => [...earlier, ...appended]);
        return Option.map(sentTurnOf(lines, deliveryOf), (tier) => Option.some(tier));
      }),
    }).pipe(Effect.timeoutOrElse({ duration: NEW_TURN_WAIT, orElse: () => Effect.succeedNone }));
  });

const keepSpeedAfterSend = Effect.fn("codex.keepSpeedAfterSend")(function* ({
  socket,
  rollout,
  threadId,
  startOffset,
  deliveryOf,
  before,
  speed,
}: {
  readonly socket: string;
  readonly rollout: string;
  readonly threadId: string;
  readonly startOffset: bigint;
  readonly deliveryOf: (line: string) => Option.Option<string>;
  readonly before: Option.Option<string>;
  readonly speed: Option.Option<typeof Speed.Type>;
}) {
  const sentTurn = yield* waitForSentTurn({ rollout, startOffset, deliveryOf });
  const wanted = Option.match(speed, {
    onNone: () => Option.getOrElse(before, () => STANDARD_TIER),
    onSome: (requested) => TIERS[requested],
  });
  if (Option.isNone(sentTurn)) {
    return [
      new CodexSpeedUnconfirmed({ threadId, speed: describeSpeed(wanted), wait: NEW_TURN_WAIT }),
    ];
  }
  const applied = yield* readLatestTier(rollout);
  return yield* settleSpeed({
    socket,
    rollout,
    threadId,
    applied,
    turnTier: Option.orElse(sentTurn.value, () => applied),
    wanted,
    speed,
    isNewTask: false,
  });
});

const SWITCHED_BEFORE_SENDING = "switched";

const SWITCH_NOT_NEEDED = "not-needed";

const NOT_LOADED_IN_DESKTOP = "not-loaded";

export const switchSpeedBeforeSend = Effect.fn("codex.switchSpeedBeforeSend")(function* ({
  socket,
  rollout,
  threadId,
  before,
  speed,
}: {
  readonly socket: string;
  readonly rollout: string;
  readonly threadId: string;
  readonly before: Option.Option<string>;
  readonly speed: Option.Option<typeof Speed.Type>;
}) {
  if (Option.isNone(speed)) {
    return SWITCH_NOT_NEEDED;
  }
  const wanted = TIERS[speed.value];
  if (isWantedTier({ applied: before, wanted, speed })) {
    return SWITCH_NOT_NEEDED;
  }
  const current = Option.getOrElse(before, () => STANDARD_TIER);
  return yield* switchTier({
    socket,
    rollout,
    threadId,
    tier: wanted,
    current,
    outcome: "not-sent",
  }).pipe(
    Effect.as(SWITCHED_BEFORE_SENDING),
    Effect.catchTag("CodexDesktopIpcRefused", () => Effect.succeed(NOT_LOADED_IN_DESKTOP)),
  );
});

export const settleSpeedAfterSend = Effect.fn("codex.settleSpeedAfterSend")(function* ({
  switched,
  wasTurnRunning,
  ...sent
}: Parameters<typeof keepSpeedAfterSend>[0] & {
  readonly switched: Effect.Success<ReturnType<typeof switchSpeedBeforeSend>>;
  readonly wasTurnRunning: boolean;
}) {
  const isSwitchedDuringTurn =
    switched === SWITCHED_BEFORE_SENDING && wasTurnRunning && Option.isSome(sent.speed);
  if (isSwitchedDuringTurn) {
    return [
      new CodexSpeedAfterThisTurn({
        threadId: sent.threadId,
        speed: describeSpeed(
          Option.match(sent.speed, {
            onNone: () => STANDARD_TIER,
            onSome: (speed) => TIERS[speed],
          }),
        ),
        current: describeSpeed(Option.getOrElse(sent.before, () => STANDARD_TIER)),
      }),
    ];
  }
  return yield* keepSpeedAfterSend(sent);
});
