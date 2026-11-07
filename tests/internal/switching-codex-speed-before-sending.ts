import assert from "node:assert/strict";

import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunSocketServer from "@effect/platform-bun/BunSocketServer";
import { Task } from "@sshkeda/task";
import {
  Deferred,
  ConfigProvider,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Match,
  Option,
  Ref,
  Result,
  Schema,
  Stream,
} from "effect";
import type { Socket } from "effect/socket";
import { TestClock } from "effect/testing";

import { frame, splitFrames } from "../../src/lib/codex/internal/codex-desktop-ipc.ts";
import {
  readLatestTier,
  settleSpeedAfterSend,
  switchSpeedBeforeSend,
} from "../../src/lib/codex/internal/service-tier.ts";
import { startMessageWithSpeed } from "../../src/lib/codex/internal/start-message-with-speed.ts";
import { platformLayer } from "../../src/lib/platform/index.ts";
import type { Speed } from "../../src/shared/speed.ts";
import { resultOf } from "../shared/failure-as-value.ts";

const THREAD_ID = "01a1b000-0000-7000-8000-000000000002";

const UPDATE_METHOD = "thread-follower-update-thread-settings";

const SWITCH_WAIT = "30 seconds";

const FAST_TIER = "priority";

const STANDARD_TIER = "default";

const START_METHOD = "thread-follower-start-turn";

const MESSAGE_ID = "speed-message";

const PROMPT = "go <fast> & keep the attribution";

const StartParameters = Schema.Struct({
  conversationId: Schema.String,
  turnStart: Schema.Struct({
    request: Schema.Struct({
      serviceTier: Schema.optional(Schema.String),
      parentTurnId: Schema.String,
      toolOutput: Schema.Struct({
        name: Schema.String,
        namespace: Schema.String,
        output: Schema.String,
      }),
    }),
  }),
});

const Request = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.String,
    method: Schema.optional(Schema.String),
    requestId: Schema.optional(Schema.String),
    params: Schema.optional(Schema.Unknown),
  }),
);

const UpdateParameters = Schema.Struct({
  conversationId: Schema.String,
  threadSettings: Schema.Struct({
    serviceTier: Schema.optional(Schema.String),
    model: Schema.optional(Schema.String),
    effort: Schema.optional(Schema.String),
  }),
});

const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

const appliedRecord = (tier: string) =>
  `{"type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{"model":"gpt-test","service_tier":"${tier}"}}}\n`;

const TURN_STARTED_RECORD = '{"type":"event_msg","payload":{"type":"task_started"}}\n';

const DESKTOP_ANSWERS = [
  "applies",
  "applies-without-recording",
  "not-loaded",
  "refuses",
  "silent",
] as const;

const REFUSALS: ReadonlyMap<(typeof DESKTOP_ANSWERS)[number], string> = new Map([
  ["not-loaded", "no-client-found"],
  ["refuses", "the setting isn't supported"],
] as const);

const pretendToBeCodexDesktop =
  ({
    answer,
    rollout,
    updates,
    received,
    closed,
    starts,
  }: {
    readonly answer: (typeof DESKTOP_ANSWERS)[number];
    readonly rollout: string;
    readonly updates: Ref.Ref<readonly (typeof UpdateParameters.Type)[]>;
    readonly received: Deferred.Deferred<void>;
    readonly closed: Deferred.Deferred<void>;
    readonly starts: Ref.Ref<readonly (typeof StartParameters.Type)[]>;
  }) =>
  (socket: Socket.Socket) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const reader = yield* socket.reader;
      const writer = yield* socket.writer;
      const reply = (message: Schema.Json) =>
        Effect.flatMap(encode(message), (body) => writer.write(frame(body)));
      yield* Stream.fromIterableEffectRepeat(reader.pull).pipe(
        Stream.mapAccum(
          (): Buffer => Buffer.alloc(0),
          (pending, chunk) => {
            const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
            const split = splitFrames({ buffer: Buffer.concat([pending, bytes]), bodies: [] });
            return [split.buffer, split.bodies] as const;
          },
        ),
        Stream.mapEffect((body) => Schema.decodeEffect(Request)(body)),
        Stream.runForEach((request) =>
          Effect.gen(function* () {
            const requestId = request.requestId ?? "";
            if (request.method === "initialize") {
              return yield* reply({
                type: "response",
                requestId,
                resultType: "success",
                result: { clientId: "nudge" },
              });
            }
            if (request.method === START_METHOD) {
              const start = yield* Schema.decodeUnknownEffect(StartParameters)(request.params);
              yield* Ref.update(starts, (earlier) => [...earlier, start]);
              const refusal = REFUSALS.get(answer);
              if (refusal !== undefined) {
                return yield* reply({
                  type: "response",
                  requestId,
                  resultType: "error",
                  error: refusal,
                });
              }
              const tier = start.turnStart.request.serviceTier ?? STANDARD_TIER;
              yield* fileSystem.writeFileString(
                rollout,
                TURN_STARTED_RECORD + appliedRecord(tier),
                { flag: "a" },
              );
              return yield* reply({
                type: "response",
                requestId,
                resultType: "success",
                result: { result: { status: "accepted" } },
              });
            }
            if (request.method !== UPDATE_METHOD) {
              return;
            }
            const update = yield* Schema.decodeUnknownEffect(UpdateParameters)(request.params);
            yield* Ref.update(updates, (earlier) => [...earlier, update]);
            yield* Deferred.done(received, Exit.void);
            if (answer === "silent") {
              return;
            }
            const refusal = REFUSALS.get(answer);
            if (refusal !== undefined) {
              return yield* reply({
                type: "response",
                requestId,
                resultType: "error",
                error: refusal,
              });
            }
            const recordsTier =
              answer === "applies" && update.threadSettings.serviceTier !== undefined;
            if (recordsTier) {
              yield* fileSystem.writeFileString(
                rollout,
                appliedRecord(update.threadSettings.serviceTier),
                { flag: "a" },
              );
            }
            return yield* reply({
              type: "response",
              requestId,
              resultType: "success",
              result: { applied: true },
            });
          }),
        ),
      );
    }).pipe(
      Effect.catchTags({ SocketError: () => Effect.void }),
      Effect.ensuring(Deferred.done(closed, Exit.void)),
      Effect.scoped,
    );

const switchAgainst = ({
  directory,
  answer,
  before,
  speed,
  isTurnRunning,
  send = false,
  model = Option.none<string>(),
  effort = Option.none<string>(),
}: {
  readonly directory: string;
  readonly answer: (typeof DESKTOP_ANSWERS)[number];
  readonly before: Option.Option<string>;
  readonly speed: Option.Option<typeof Speed.Type>;
  readonly isTurnRunning: boolean;
  readonly send?: boolean;
  readonly model?: Option.Option<string>;
  readonly effort?: Option.Option<string>;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const socket = `${directory}/${answer}.sock`;
      const rollout = `${directory}/${answer}-${Option.getOrElse(speed, () => "none")}.jsonl`;
      yield* fileSystem.writeFileString(
        rollout,
        [
          ...Option.toArray(Option.map(before, appliedRecord)),
          ...(isTurnRunning ? [TURN_STARTED_RECORD] : []),
        ].join(""),
      );
      const updates = yield* Ref.make<readonly (typeof UpdateParameters.Type)[]>([]);
      const starts = yield* Ref.make<readonly (typeof StartParameters.Type)[]>([]);
      const received = yield* Deferred.make<void>();
      const closed = yield* Deferred.make<void>();
      const server = yield* BunSocketServer.make({ path: socket });
      const isDone = yield* Ref.make(false);
      const started = yield* Ref.make(false);
      const switching = resultOf(
        switchSpeedBeforeSend({ socket, rollout, threadId: THREAD_ID, before, speed }),
      ).pipe(
        Effect.tap((switched) =>
          Effect.gen(function* () {
            const isReadyToSend = send && Result.isSuccess(switched);
            if (isReadyToSend) {
              const sent = yield* startMessageWithSpeed({
                socket,
                threadId: THREAD_ID,
                messageId: MESSAGE_ID,
                prompt: PROMPT,
                tier: yield* readLatestTier(rollout),
                model,
                effort,
              }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({}))));
              yield* Ref.set(started, sent);
            }
          }),
        ),
        Effect.tap(() => Ref.set(isDone, true)),
      );
      const advanceUntilDone: Effect.Effect<void> = Effect.gen(function* () {
        if (yield* Ref.get(isDone)) {
          return;
        }
        yield* TestClock.adjust(SWITCH_WAIT);
        yield* Effect.yieldNow;
        return yield* advanceUntilDone;
      });
      const advancing = Match.value(answer).pipe(
        Match.when("silent", () => Effect.andThen(Deferred.await(received), advanceUntilDone)),
        Match.when("applies-without-recording", () =>
          Effect.andThen(Deferred.await(closed), advanceUntilDone),
        ),
        Match.orElse(() => Effect.void),
      );
      const [switched] = yield* Effect.all(
        [
          switching.pipe(
            Effect.raceFirst(
              server.run(
                pretendToBeCodexDesktop({ answer, rollout, updates, received, closed, starts }),
              ),
            ),
          ),
          advancing,
        ],
        { concurrency: "unbounded" },
      );
      return {
        switched,
        started: yield* Ref.get(started),
        updates: yield* Ref.get(updates),
        starts: yield* Ref.get(starts),
        rollout,
      };
    }),
  );

const failureMessage = <Success>(
  switched: Result.Result<Success, { readonly message: string }>,
) => {
  assert.ok(Result.isFailure(switched), "nudge switched although Codex Desktop didn't");
  return switched.failure.message;
};

const notSwitched = (reason: string) =>
  `nudge couldn't switch Codex session ${THREAD_ID} to Fast: ${reason}, so nudge didn't send the message`;

export const switchingCodexSpeedBeforeSending = Task.make(
  "switching-codex-speed-before-sending",
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ directory: "/tmp" });

      const toFast = yield* switchAgainst({
        directory,
        answer: "applies",
        before: Option.some(STANDARD_TIER),
        speed: Option.some("fast"),
        isTurnRunning: false,
        send: true,
        model: Option.some("gpt-test"),
        effort: Option.some("high"),
      });
      assert.deepEqual(toFast.switched, Result.succeed("switched"));
      assert.deepEqual(toFast.updates, [
        { conversationId: THREAD_ID, threadSettings: { serviceTier: FAST_TIER } },
        { conversationId: THREAD_ID, threadSettings: { model: "gpt-test", effort: "high" } },
      ]);
      assert.equal(Option.getOrNull(yield* readLatestTier(toFast.rollout)), FAST_TIER);
      assert.equal(toFast.starts.length, 1);
      assert.equal(toFast.starts[0]?.conversationId, THREAD_ID);
      assert.equal(toFast.starts[0].turnStart.request.serviceTier, FAST_TIER);
      assert.equal(toFast.starts[0].turnStart.request.parentTurnId, `nudge-${MESSAGE_ID}`);
      assert.deepEqual(toFast.starts[0].turnStart.request.toolOutput, {
        name: "send_message_to_thread",
        namespace: "codex_app",
        output: `<codex_delegation>\n  <source_thread_id>${THREAD_ID}</source_thread_id>\n  <input>go &lt;fast&gt; &amp; keep the attribution</input>\n</codex_delegation>`,
      });

      const toStandard = yield* switchAgainst({
        directory,
        answer: "applies",
        before: Option.some(FAST_TIER),
        speed: Option.some("standard"),
        isTurnRunning: false,
        send: true,
      });
      assert.deepEqual(toStandard.switched, Result.succeed("switched"));
      assert.equal(toStandard.starts[0]?.turnStart.request.serviceTier, STANDARD_TIER);
      assert.deepEqual(
        toStandard.updates,
        [{ conversationId: THREAD_ID, threadSettings: { serviceTier: STANDARD_TIER } }],
        "nudge must ask for Standard explicitly, since null makes the session inherit Codex's default",
      );

      for (const unchanged of [
        { before: Option.some(FAST_TIER), speed: Option.some("fast" as const) },
        { before: Option.none(), speed: Option.some("standard" as const) },
        { before: Option.some(FAST_TIER), speed: Option.none() },
      ]) {
        const kept = yield* switchAgainst({
          directory,
          answer: "applies",
          isTurnRunning: false,
          ...unchanged,
        });
        assert.deepEqual(kept.switched, Result.succeed("not-needed"));
        assert.deepEqual(kept.updates, []);
      }

      for (const matching of [
        { before: Option.some(FAST_TIER), speed: Option.some("fast" as const) },
        { before: Option.some(STANDARD_TIER), speed: Option.some("standard" as const) },
      ]) {
        for (const answer of ["not-loaded", "applies"] as const) {
          const unchanged = yield* switchAgainst({
            directory,
            answer,
            isTurnRunning: false,
            send: true,
            ...matching,
          });
          assert.deepEqual(unchanged.switched, Result.succeed("not-needed"));
          assert.deepEqual(unchanged.updates, []);
          assert.equal(unchanged.starts.length, 1);
          assert.equal(unchanged.started, answer === "applies");
          assert.equal(
            Option.getOrNull(yield* readLatestTier(unchanged.rollout)),
            Option.getOrNull(matching.before),
          );
        }
      }

      const refused = yield* switchAgainst({
        directory,
        answer: "refuses",
        before: Option.some(STANDARD_TIER),
        speed: Option.some("fast"),
        isTurnRunning: false,
      });
      assert.equal(
        failureMessage(refused.switched),
        notSwitched(
          `Codex Desktop refused ${UPDATE_METHOD}, a request that Codex doesn't document: the setting isn't supported`,
        ),
      );

      const notLoaded = yield* switchAgainst({
        directory,
        answer: "not-loaded",
        before: Option.some(STANDARD_TIER),
        speed: Option.some("fast"),
        isTurnRunning: false,
      });
      assert.deepEqual(notLoaded.switched, Result.succeed("not-loaded"));

      const silent = yield* switchAgainst({
        directory,
        answer: "silent",
        before: Option.some(STANDARD_TIER),
        speed: Option.some("fast"),
        isTurnRunning: false,
      });
      assert.equal(
        failureMessage(silent.switched),
        notSwitched(
          `can't ask Codex Desktop for ${UPDATE_METHOD} at ${directory}/silent.sock: Codex Desktop did not answer ${UPDATE_METHOD} within 30 seconds`,
        ),
      );

      const unrecorded = yield* switchAgainst({
        directory,
        answer: "applies-without-recording",
        before: Option.some(STANDARD_TIER),
        speed: Option.some("fast"),
        isTurnRunning: false,
      });
      assert.equal(
        failureMessage(unrecorded.switched),
        notSwitched(`Codex recorded no new speed within ${SWITCH_WAIT}`),
      );

      const busy = yield* switchAgainst({
        directory,
        answer: "applies",
        before: Option.some(STANDARD_TIER),
        speed: Option.some("fast"),
        isTurnRunning: true,
      });
      assert.deepEqual(busy.switched, Result.succeed("switched"));
      const warnings = yield* settleSpeedAfterSend({
        switched: "switched",
        wasTurnRunning: true,
        socket: `${directory}/unused.sock`,
        rollout: busy.rollout,
        threadId: THREAD_ID,
        startOffset: 0n,
        deliveryOf: () => Option.none(),
        before: Option.some(STANDARD_TIER),
        speed: Option.some("fast"),
      });
      assert.deepEqual(
        warnings.map((warning) => warning.message),
        [
          `nudge switched Codex session ${THREAD_ID} to Fast, but it's in the middle of a turn, which keeps running in Standard mode until it ends`,
        ],
      );
    }),
  ).pipe(
    Effect.provide([platformLayer, BunCrypto.layerSecureRandom, Layer.fresh(TestClock.layer())]),
  ),
);
