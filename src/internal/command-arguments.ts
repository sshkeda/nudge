import { Effect, Option, Schema, Stdio, Stream } from "effect";
import { Argument, Flag } from "effect/cli";

import {
  CodexSandboxBlocksNudge,
  requireCodexHelperOutsideSandbox,
} from "../shared/codex-helper.ts";
import { CODEX_BRIDGE_SOCKET } from "../shared/read-environment.ts";
import { hasControlCharacters } from "../shared/session.ts";
import { SESSION_ARGUMENT } from "./command-flags.ts";
import { rerun } from "./command-line.ts";
import { commandWords } from "./command-words.ts";
import { NameEmpty, NameHasControlCharacters, NameHasOuterSpaces } from "./errors.ts";

export const requireNudgeOutsideSandbox = Effect.flatMap(
  CODEX_BRIDGE_SOCKET,
  requireCodexHelperOutsideSandbox,
);

export const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Print the result as JSON."),
  Flag.withDefault(false),
);

export const readText = <Empty, Missing>(
  text: Option.Option<string>,
  errors: { readonly empty: Empty; readonly missing: Missing },
) =>
  Effect.gen(function* () {
    const given = Option.getOrElse(text, () => "-");
    if (given.trim() === "") {
      return yield* Effect.fail(errors.empty);
    }
    if (given !== "-") {
      return given;
    }
    const stdio = yield* Stdio.Stdio;
    if (yield* stdio.stdinIsTerminal) {
      return yield* Effect.fail(errors.missing);
    }
    const piped = yield* stdio.stdin.pipe(Stream.decodeText, Stream.mkString);
    if (piped.trim() === "") {
      return yield* Effect.fail(errors.empty);
    }
    return piped;
  });

export const sessionArgument = Argument.String(SESSION_ARGUMENT);

export const DESCRIBE_SESSION_ARGUMENT =
  "<session> is a session's ID, exact name or codex:// link.";

export const requireUsableName = (name: string) =>
  Effect.gen(function* () {
    if (hasControlCharacters(name)) {
      return yield* new NameHasControlCharacters({ value: name });
    }
    const trimmed = name.trim();
    if (trimmed === "") {
      return yield* new NameEmpty();
    }
    if (trimmed !== name) {
      const words = yield* commandWords;
      const index = words.lastIndexOf(name);
      return yield* new NameHasOuterSpaces({
        value: name,
        hint: index === -1 ? null : rerun(words.with(index, trimmed)),
      });
    }
  });

export const hintFor = ({
  failure,
  words,
}: {
  readonly failure: Error;
  readonly words: readonly string[];
}) => (Schema.is(CodexSandboxBlocksNudge)(failure) ? rerun(words) : null);

export const FAILED_EXIT_CODE = 1;
