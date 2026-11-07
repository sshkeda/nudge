import { Effect, Stdio, Stream } from "effect";

export const linePrinter = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  return {
    printLine: (line: string) => Stream.make(`${line}\n`).pipe(Stream.run(stdio.stdout())),
    printErrorLine: (line: string) => Stream.make(`${line}\n`).pipe(Stream.run(stdio.stderr())),
  };
});

export const toOneLine = (text: string) => text.trim().replaceAll(/\s*\n\s*/gu, " ");
