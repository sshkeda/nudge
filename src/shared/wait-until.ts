import {
  ByteSize,
  Cause,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  Predicate,
  Queue,
  Schema,
  Stream,
} from "effect";
import type { PlatformError, Scope } from "effect";
import { ChildProcess } from "effect/process";
import type { ChildProcessSpawner } from "effect/process";

import { Platform } from "../lib/platform/index.ts";
import { START_OF_FILE } from "./transcript.ts";
import type { InotifyWatchLimitReached } from "./watch-errors.ts";

const FIRST_BYTE = 1n;

const watchId = (path: string) => new Bun.CryptoHasher("sha256").update(path).digest("hex");

const hasNoSpaceCode = Schema.is(Schema.Struct({ code: Schema.Literal("ENOSPC") }));

const failWatch = <Failure>({
  directory,
  cause,
}: {
  readonly directory: string;
  readonly cause: Cause.Cause<Failure>;
}) => {
  const failure = Cause.squash(cause);
  const isWatchLimitReached =
    hasNoSpaceCode(failure) ||
    (Predicate.hasProperty(failure, "cause") && hasNoSpaceCode(failure.cause));
  if (!isWatchLimitReached) {
    return Effect.failCause(cause);
  }
  return Effect.gen(function* () {
    const limitReached = yield* (yield* Platform).findWatchLimitReached(directory);
    if (Option.isNone(limitReached)) {
      return yield* Effect.failCause(cause);
    }
    return yield* limitReached.value;
  });
};

export const waitFor = <Value, Failure, Requirements, PathsFailure, PathsRequirements>({
  watch,
  check,
}: {
  readonly watch: Effect.Effect<readonly string[], PathsFailure, PathsRequirements>;
  readonly check: Effect.Effect<Option.Option<Value>, Failure, Requirements>;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const changes = yield* Queue.unbounded<
        string,
        InotifyWatchLimitReached | PlatformError.PlatformError | Schema.SchemaError
      >();
      const watched = new Set<string>();
      const traceTargets = new Set<string>();
      const traceDirectories = new Set<string>();
      const followed = new Set<string>();

      const nearestDirectory = (
        target: string,
      ): Effect.Effect<string, PlatformError.PlatformError> =>
        Effect.gen(function* () {
          const stats = yield* fileSystem.stat(target).pipe(
            Effect.asSome,
            Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
          );
          const isDirectory = Option.exists(stats, (found) => found.type === "Directory");
          if (isDirectory) {
            return target;
          }
          const parent = path.dirname(target);
          const isParentTheAnswer = Option.isSome(stats) || parent === target;
          return isParentTheAnswer ? parent : yield* nearestDirectory(parent);
        });

      const watchDirectory = (directory: string) =>
        Effect.gen(function* () {
          const ready = yield* Deferred.make<
            void,
            InotifyWatchLimitReached | PlatformError.PlatformError | Schema.SchemaError
          >();
          yield* fileSystem
            .watch(directory, {
              onReady: () => {
                Deferred.doneUnsafe(ready, Exit.void);
              },
            })
            .pipe(
              Stream.runForEach(() => Queue.offer(changes, directory)),
              Effect.andThen(
                Effect.sync(() => watched.delete(directory)).pipe(
                  Effect.andThen(Queue.offer(changes, directory)),
                ),
              ),
              Effect.catchCause((cause) => failWatch({ directory, cause })),
              Effect.catchCause((cause) =>
                Effect.andThen(Deferred.failCause(ready, cause), Queue.failCause(changes, cause)),
              ),
              Effect.forkScoped,
            );
          yield* Deferred.await(ready);
        });

      const followFile = (file: string) =>
        Effect.gen(function* () {
          const size = yield* fileSystem.stat(file).pipe(
            Effect.map((stats) =>
              stats.type === "File" ? Option.some(ByteSize.toBigInt(stats.size)) : Option.none(),
            ),
            Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
          );
          if (Option.isNone(size)) {
            return false;
          }
          followed.add(file);
          const firstFollowedByte = size.value > START_OF_FILE ? size.value : FIRST_BYTE;
          const tail = yield* ChildProcess.make(
            "tail",
            ["-f", "-c", `+${String(firstFollowedByte)}`, "--", file],
            { stdin: "ignore", stderr: "ignore" },
          );
          yield* tail.stdout.pipe(
            Stream.runForEach(() => Queue.offer(changes, file)),
            Effect.forkScoped,
          );
          return true;
        });

      const watchNewDirectories = Effect.gen(function* () {
        const targets = yield* watch;
        const directories = yield* Effect.forEach(targets, nearestDirectory);
        for (const target of targets) {
          traceTargets.add(target);
        }
        for (const directory of directories) {
          traceDirectories.add(directory);
        }
        yield* Effect.annotateCurrentSpan({
          "nudge.wait.target.ids": [...traceTargets].map((target) => watchId(target)).join(" "),
          "nudge.wait.directory.ids": [...traceDirectories]
            .map((target) => watchId(target))
            .join(" "),
          "nudge.wait.target.count": traceTargets.size,
          "nudge.wait.directory.count": traceDirectories.size,
          "nudge.wait.parentWatch.count": targets.filter(
            (target, index) => target !== directories[index],
          ).length,
        });
        const added = [...new Set(directories)].filter((directory) => !watched.has(directory));
        for (const directory of added) {
          watched.add(directory);
          yield* watchDirectory(directory);
        }
        const newlyFollowed = yield* Effect.forEach(
          [...new Set(targets)].filter((target) => !followed.has(target)),
          followFile,
        );
        return added.length > 0 || newlyFollowed.includes(true);
      });

      const checkUntilFound: Effect.Effect<
        Value,
        | Failure
        | InotifyWatchLimitReached
        | PathsFailure
        | PlatformError.PlatformError
        | Schema.SchemaError,
        | ChildProcessSpawner.ChildProcessSpawner
        | PathsRequirements
        | Platform
        | Requirements
        | Scope.Scope
      > = Effect.gen(function* () {
        const found = yield* check;
        if (Option.isSome(found)) {
          return found.value;
        }
        const hasNewWatches = yield* watchNewDirectories;
        if (!hasNewWatches) {
          yield* Queue.take(changes);
          yield* Queue.clear(changes);
        }
        return yield* checkUntilFound;
      });

      yield* watchNewDirectories;
      return yield* checkUntilFound;
    }),
  ).pipe(Effect.withSpan("nudge.wait"));

export const waitUntil = <Failure, Requirements, PathsFailure, PathsRequirements>({
  watch,
  done,
}: {
  readonly watch: Effect.Effect<readonly string[], PathsFailure, PathsRequirements>;
  readonly done: Effect.Effect<boolean, Failure, Requirements>;
}) =>
  waitFor({
    watch,
    check: Effect.map(done, (isDone) => (isDone ? Option.some(true) : Option.none())),
  });
