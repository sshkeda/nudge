import assert from "node:assert/strict";

import { Task } from "@sshkeda/task";
import { Effect, Predicate } from "effect";
import { Completions } from "effect/cli";

import { SHORT_FLAG_NAMES, VALUE_FLAG_NAMES } from "../../src/internal/command-flags.ts";
import { classify } from "../../src/internal/command-line.ts";
import { SUBCOMMANDS } from "../../src/internal/subcommands.ts";

const DEFINED_FLAGS = SUBCOMMANDS.flatMap((command) =>
  Completions.fromCommand(command).flags.map((flag) => ({
    command: command.name,
    flag: flag.name,
    aliases: flag.aliases,
    takesValue: !Predicate.isTagged(flag.type, "Boolean"),
  })),
);

const lexesAValue = ({ command, flag }: { readonly command: string; readonly flag: string }) => {
  const words = [command, `--${flag}`, "value"] as const;
  return classify(words).some(
    (word) => word.kind === "flag" && word.name === flag && word.valueIndex === words.length - 1,
  );
};

const sortedNames = (names: Iterable<string>) => [...new Set(names)].toSorted();

export const matchingFlagsToTheLexer = Task.make(
  "matching-flags-to-the-lexer",
  Effect.sync(() => {
    assert.deepEqual(
      DEFINED_FLAGS.map(({ command, flag }) => ({
        command,
        flag,
        takesValue: lexesAValue({ command, flag }),
      })),
      DEFINED_FLAGS.map(({ command, flag, takesValue }) => ({ command, flag, takesValue })),
    );
    assert.deepEqual(
      sortedNames(VALUE_FLAG_NAMES),
      sortedNames(DEFINED_FLAGS.filter(({ takesValue }) => takesValue).map(({ flag }) => flag)),
    );
    assert.deepEqual(
      DEFINED_FLAGS.flatMap(({ aliases }) =>
        aliases.filter((alias) => !SHORT_FLAG_NAMES.has(alias.replace(/^-/u, ""))),
      ),
      [],
    );
  }),
);
