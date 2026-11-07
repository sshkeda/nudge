import assert from "node:assert/strict";

import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import { Task } from "@sshkeda/task";
import { Deferred, Effect, Exit, Layer, Ref, Result } from "effect";
import { TestClock } from "effect/testing";

import { archiveWithRetries } from "../../src/lib/codex/internal/codex-service.ts";
import {
  CodexArchiveDatabaseLocked,
  CodexToolFailed,
} from "../../src/lib/codex/internal/errors.ts";
import { resultOf } from "../shared/failure-as-value.ts";

const THREAD_ID = "01a1b000-0000-7000-8000-000000000003";

const BEFORE_FIRST_RETRY = "999 millis";

const LAST_MILLISECOND = "1 milli";

const RETRY_SPACING = "1 second";

const RETRY_DEADLINE = "30 seconds";

const SECOND_ATTEMPT = 2;

const SUCCESSFUL_ATTEMPT = 3;

const ATTEMPTS_BEFORE_DEADLINE = 30;

const locked = (attempt: number) =>
  new CodexArchiveDatabaseLocked({ failure: `lock ${String(attempt)}` });

export const retryingALockedCodexArchive = Task.make(
  "retrying-a-locked-codex-archive",
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    const firstAttempt = yield* Deferred.make<void>();
    const archive = Effect.gen(function* () {
      const attempt = yield* Ref.updateAndGet(attempts, (previous) => previous + 1);
      yield* Deferred.done(firstAttempt, Exit.void);
      return attempt === SUCCESSFUL_ATTEMPT ? "archived" : yield* locked(attempt);
    });
    const advancing = Effect.gen(function* () {
      yield* Deferred.await(firstAttempt);
      yield* TestClock.adjust(BEFORE_FIRST_RETRY);
      assert.equal(yield* Ref.get(attempts), 1, "the first retry ran without waiting a second");
      yield* TestClock.adjust(LAST_MILLISECOND);
      assert.equal(yield* Ref.get(attempts), SECOND_ATTEMPT);
      yield* TestClock.adjust(RETRY_SPACING);
    });
    const [answer] = yield* Effect.all(
      [resultOf(archiveWithRetries(archive, THREAD_ID)), advancing],
      {
        concurrency: "unbounded",
      },
    );
    assert.ok(Result.isSuccess(answer));
    assert.equal(yield* Ref.get(attempts), SUCCESSFUL_ATTEMPT);

    const lockedAttempts = yield* Ref.make(0);
    const firstLock = yield* Deferred.make<void>();
    const alwaysLocked = Effect.gen(function* () {
      const attempt = yield* Ref.updateAndGet(lockedAttempts, (previous) => previous + 1);
      yield* Deferred.done(firstLock, Exit.void);
      return yield* locked(attempt);
    });
    const [stopped] = yield* Effect.all(
      [
        resultOf(archiveWithRetries(alwaysLocked, THREAD_ID)),
        Effect.andThen(Deferred.await(firstLock), TestClock.adjust(RETRY_DEADLINE)),
      ],
      { concurrency: "unbounded" },
    );
    assert.ok(Result.isFailure(stopped));
    assert.equal(stopped.failure._tag, "CodexArchiveStillLocked");
    assert.equal(yield* Ref.get(lockedAttempts), ATTEMPTS_BEFORE_DEADLINE);
    assert.match(stopped.failure.message, /retried for 30 seconds/u);
    assert.match(stopped.failure.message, /lock 30$/u);

    for (const succeeds of [true, false]) {
      const calls = yield* Ref.make(0);
      const initialLock = yield* Deferred.make<void>();
      const inFlight = yield* Deferred.make<void>();
      const reply = yield* Deferred.make<void>();
      const finished = yield* Ref.make(false);
      const slowArchive = Effect.gen(function* () {
        const call = yield* Ref.updateAndGet(calls, (previous) => previous + 1);
        if (call === 1) {
          yield* Deferred.done(initialLock, Exit.void);
          return yield* locked(call);
        }
        yield* Deferred.done(inFlight, Exit.void);
        yield* Deferred.await(reply);
        return succeeds ? "archived" : yield* locked(call);
      });
      const releaseReply = Effect.gen(function* () {
        yield* Deferred.await(initialLock);
        yield* TestClock.adjust(RETRY_SPACING);
        yield* Deferred.await(inFlight);
        yield* TestClock.adjust(RETRY_DEADLINE);
        assert.equal(yield* Ref.get(finished), false, "nudge abandoned an in-flight archive");
        assert.equal(yield* Ref.get(calls), SECOND_ATTEMPT);
        yield* Deferred.done(reply, Exit.void);
      });
      const [settled] = yield* Effect.all(
        [
          resultOf(archiveWithRetries(slowArchive, THREAD_ID)).pipe(
            Effect.tap(() => Ref.set(finished, true)),
          ),
          releaseReply,
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(Result.isSuccess(settled), succeeds);
      assert.equal(yield* Ref.get(calls), SECOND_ATTEMPT, "a retry started after the deadline");
      if (Result.isFailure(settled)) {
        assert.equal(settled.failure._tag, "CodexArchiveStillLocked");
        assert.match(settled.failure.message, /lock 2$/u);
      }
    }

    const otherFailure = new CodexToolFailed({ tool: "set_thread_archived", failure: "refused" });
    const failed = yield* resultOf(archiveWithRetries(Effect.fail(otherFailure), THREAD_ID));
    assert.ok(Result.isFailure(failed));
    assert.equal(failed.failure, otherFailure);
    assert.equal(yield* archiveWithRetries(Effect.succeed("archived"), THREAD_ID), "archived");
  }).pipe(Effect.provide([BunCrypto.layerSecureRandom, Layer.fresh(TestClock.layer())])),
);
