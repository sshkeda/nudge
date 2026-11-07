import { ByteSize, Effect, FileSystem, Option, Ref, Schema } from "effect";
import type { PlatformError } from "effect";

import { homePath, messageOf, prose, Report } from "./report.ts";

const TAIL_BYTES = 262_144n;

const NEWLINE = 0x0a;

export const START_OF_FILE = 0n;

export class TranscriptRewritten extends Schema.TaggedError<TranscriptRewritten>()(
  "TranscriptRewritten",
  { path: Schema.String, offset: Schema.BigInt, size: Schema.BigInt },
) {
  public get report(): Report {
    return new Report({
      message: prose`${homePath(this.path)} shrank to ${String(this.size)} bytes while nudge was reading from byte ${String(this.offset)}, so it can't tell whether the message arrived`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

const readTail = (path: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fileSystem.open(path);
        const size = ByteSize.toBigInt((yield* file.stat).size);
        const length = size < TAIL_BYTES ? size : TAIL_BYTES;
        yield* file.seek(size - length, "start");
        const bytes = yield* file.readAlloc(Number(length));
        const text = Option.match(bytes, {
          onNone: () => "",
          onSome: (read) => new TextDecoder().decode(read),
        });
        return Option.some({ text, startsAtFileStart: length === size });
      }),
    ).pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone));
  });

export const readLastCompleteLines = (path: string) =>
  Effect.map(readTail(path), (tail) =>
    Option.map(tail, ({ text, startsAtFileStart }) =>
      text.split("\n").slice(startsAtFileStart ? 0 : 1, -1),
    ),
  );

const joinBytes = (left: Uint8Array, right: Uint8Array) => {
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left);
  joined.set(right, left.length);
  return joined;
};

const foldLines = <State, Failure, Requirement>({
  lines,
  index,
  state,
  step,
}: {
  readonly lines: readonly string[];
  readonly index: number;
  readonly state: State;
  readonly step: (
    state: State,
    line: string,
  ) => Effect.Effect<{ readonly state: State; readonly isDone: boolean }, Failure, Requirement>;
}): Effect.Effect<{ readonly state: State; readonly isDone: boolean }, Failure, Requirement> => {
  const line = lines[index];
  if (line === undefined) {
    return Effect.succeed({ state, isDone: false });
  }
  if (line === "") {
    return foldLines({ lines, index: index + 1, state, step });
  }
  return Effect.filterOrElse(
    step(state, line),
    (folded) => folded.isDone,
    (folded) => foldLines({ lines, index: index + 1, state: folded.state, step }),
  );
};

const foldChunksFromEnd = <State, Failure, Requirement>({
  file,
  end,
  head,
  hasLastLine,
  state,
  step,
}: {
  readonly file: FileSystem.File;
  readonly end: bigint;
  readonly head: Uint8Array;
  readonly hasLastLine: boolean;
  readonly state: State;
  readonly step: (
    state: State,
    line: string,
  ) => Effect.Effect<{ readonly state: State; readonly isDone: boolean }, Failure, Requirement>;
}): Effect.Effect<State, Failure | PlatformError.PlatformError, Requirement> => {
  if (end === START_OF_FILE) {
    const isFirstLineLeft = hasLastLine && head.length > 0;
    return isFirstLineLeft
      ? Effect.map(step(state, new TextDecoder().decode(head)), (folded) => folded.state)
      : Effect.succeed(state);
  }
  const start = end > TAIL_BYTES ? end - TAIL_BYTES : START_OF_FILE;
  const readEarlier = (next: { readonly head: Uint8Array; readonly state: State }) =>
    foldChunksFromEnd({ file, end: start, hasLastLine: true, step, ...next });
  return file.seek(start, "start").pipe(
    Effect.andThen(file.readAlloc(Number(end - start))),
    Effect.flatMap((read) => {
      const bytes = joinBytes(
        Option.getOrElse(read, () => Uint8Array.of()),
        head,
      );
      const lastLineEnd = hasLastLine ? bytes.length : bytes.lastIndexOf(NEWLINE);
      if (lastLineEnd === -1) {
        return foldChunksFromEnd({
          file,
          end: start,
          head: Uint8Array.of(),
          hasLastLine,
          state,
          step,
        });
      }
      const complete = bytes.subarray(0, lastLineEnd);
      const firstBreak = complete.indexOf(NEWLINE);
      if (firstBreak === -1) {
        return readEarlier({ head: complete, state });
      }
      const nextHead = complete.slice(0, firstBreak);
      const lines = new TextDecoder()
        .decode(complete.subarray(firstBreak + 1))
        .split("\n")
        .toReversed();
      return Effect.flatMap(foldLines({ lines, index: 0, state, step }), (folded) =>
        folded.isDone
          ? Effect.succeed(folded.state)
          : readEarlier({ head: nextHead, state: folded.state }),
      );
    }),
  );
};

export const foldLinesFromEnd = <State, Failure, Requirement>({
  path,
  initial,
  step,
}: {
  readonly path: string;
  readonly initial: State;
  readonly step: (
    state: State,
    line: string,
  ) => Effect.Effect<{ readonly state: State; readonly isDone: boolean }, Failure, Requirement>;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const opened = yield* fileSystem.open(path).pipe(
          Effect.asSome,
          Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
        );
        if (Option.isNone(opened)) {
          return initial;
        }
        const file = opened.value;
        return yield* foldChunksFromEnd({
          file,
          end: ByteSize.toBigInt((yield* file.stat).size),
          head: Uint8Array.of(),
          hasLastLine: false,
          state: initial,
          step,
        });
      }),
    );
  });

export const readByteLength = (path: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.stat(path).pipe(
      Effect.map((status) => ByteSize.toBigInt(status.size)),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(START_OF_FILE)),
    );
  });

export const makeAppendedLineReader = (startOffset: bigint) =>
  Effect.map(
    Ref.make(startOffset),
    (offset) => (path: string) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const from = yield* Ref.get(offset);
        const bytes = yield* Effect.scoped(
          Effect.gen(function* () {
            const file = yield* fileSystem.open(path);
            const size = ByteSize.toBigInt((yield* file.stat).size);
            if (size < from) {
              return yield* new TranscriptRewritten({ path, offset: from, size });
            }
            yield* file.seek(from, "start");
            return Option.getOrElse(yield* file.readAlloc(Number(size - from)), () =>
              Uint8Array.of(),
            );
          }),
        ).pipe(
          Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(Uint8Array.of())),
        );
        const completeLength = bytes.lastIndexOf(NEWLINE) + 1;
        yield* Ref.set(offset, from + BigInt(completeLength));
        return new TextDecoder()
          .decode(bytes.subarray(0, completeLength))
          .split("\n")
          .filter((line) => line !== "");
      }),
  );
