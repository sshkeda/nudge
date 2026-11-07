import { Match, Option } from "effect";
import type { CliError } from "effect/cli";

import { AGENTS } from "../shared/agents.ts";
import { SESSION_ARGUMENT } from "./command-flags.ts";
import {
  classify,
  findUnknownShortFlag,
  flagName,
  hintForUnknownFlag,
  renderCommand,
} from "./command-line.ts";
import {
  ArgumentMissing,
  ArgumentValueInvalid,
  CommandLineInvalid,
  CommandMissing,
  ExtraArguments,
  FlagMissing,
  FlagRepeated,
  FlagValueInvalid,
  FlagValueMissing,
  PROGRAM,
  SessionArgumentMissing,
  UnknownCommand,
  UnknownFlag,
} from "./errors.ts";
import { subcommandOf, TEXT_POSITIONS } from "./subcommands.ts";

const AGENT_CHOICES = AGENTS.join(" or ");

const WHOLE_NUMBER = "a whole number";

const EXPECTED_VALUES: ReadonlyMap<string, string> = new Map([
  ["agent", AGENT_CHOICES],
  ["limit", WHOLE_NUMBER],
  ["offset", WHOLE_NUMBER],
  ["speed", "standard or fast"],
]);

const withArticle = (noun: string) => `${/^[aeiou]/iu.test(noun) ? "an" : "a"} ${noun}`;

const describeNeededArgument = (argument: string) => {
  const expected = EXPECTED_VALUES.get(argument);
  return expected === undefined ? withArticle(argument) : `${withArticle(argument)}, ${expected}`;
};

const helpFor = (subcommand: string | undefined) =>
  renderCommand([...(subcommand === undefined ? [] : [subcommand]), "--help"]);

const correctFlag = ({
  words,
  index,
  suggestion,
}: {
  readonly words: readonly string[];
  readonly index: number;
  readonly suggestion: string | undefined;
}) => {
  const word = words[index];
  const isCorrectable = suggestion !== undefined && word !== undefined;
  if (!isCorrectable) {
    return null;
  }
  const value = word.slice(`--${flagName(word)}`.length);
  return renderCommand(words.with(index, `${suggestion}${value}`));
};

const describeUnknownFlag = ({
  command,
  option,
  suggestion,
  words,
}: {
  readonly command: string;
  readonly option: string;
  readonly suggestion: string | undefined;
  readonly words: readonly string[];
}) => {
  const subcommand = subcommandOf(words);
  const flagWord = classify(words).find(
    (word) => word.kind === "flag" && (words[word.index] ?? "").startsWith(option),
  );
  if (flagWord === undefined) {
    return new UnknownFlag({ command, flag: option, argument: option, hint: helpFor(subcommand) });
  }
  return new UnknownFlag({
    command,
    flag: option,
    argument: words[flagWord.index] ?? option,
    hint:
      correctFlag({ words, index: flagWord.index, suggestion }) ??
      hintForUnknownFlag({
        words,
        index: flagWord.index,
        subcommand,
        textPositions: TEXT_POSITIONS,
      }),
  });
};

const describeUnknownCommand = ({
  command,
  subcommand,
  suggestion,
  words,
}: {
  readonly command: string;
  readonly subcommand: string;
  readonly suggestion: string | undefined;
  readonly words: readonly string[];
}) => {
  const index = words.indexOf(subcommand);
  const isCorrectable = suggestion !== undefined && index !== -1;
  const corrected = isCorrectable ? renderCommand(words.with(index, suggestion)) : null;
  return new UnknownCommand({
    command,
    subcommand,
    hint: corrected ?? `${PROGRAM} --help`,
  });
};

const describeUsageError = ({
  command,
  error,
  words,
}: {
  readonly command: string;
  readonly error: CliError.CliError;
  readonly words: readonly string[];
}) =>
  Match.valueTags(error, {
    UnrecognizedOption: ({ option, suggestions: [suggestion] }) =>
      describeUnknownFlag({ command, option, suggestion, words }),
    UnknownSubcommand: ({ subcommand, parent, suggestions: [suggestion] }) =>
      describeUnknownCommand({
        command: parent?.join(" ") ?? command,
        subcommand,
        suggestion,
        words,
      }),
    MissingArgument: ({ argument }) =>
      argument === SESSION_ARGUMENT
        ? new SessionArgumentMissing({ command, archived: command === "nudge unarchive" })
        : new ArgumentMissing({ command, argument: describeNeededArgument(argument) }),
    MissingOption: ({ option }) => new FlagMissing({ command, flag: `--${option}` }),
    UnexpectedArgument: ({ arguments: extra }) => new ExtraArguments({ command, arguments: extra }),
    InvalidValue: ({ option, value, kind }) => {
      if (kind === "argument") {
        return new ArgumentValueInvalid({
          command,
          argument: option,
          value,
          expected: EXPECTED_VALUES.get(option),
        });
      }
      const isRepeated =
        classify(words).filter((word) => word.kind === "flag" && word.name === option).length > 1;
      if (isRepeated) {
        return new FlagRepeated({ command, flag: `--${option}` });
      }
      return value === ""
        ? new FlagValueMissing({ command, flag: `--${option}` })
        : new FlagValueInvalid({
            command,
            flag: `--${option}`,
            value,
            expected: EXPECTED_VALUES.get(option),
          });
    },
    DuplicateOption: ({ option, parentCommand, childCommand }) =>
      new CommandLineInvalid({
        command,
        reason: `${parentCommand} and ${childCommand} both define --${option}`,
      }),
    ValidationError: ({ message }) => new CommandLineInvalid({ command, reason: message }),
    UserError: (userError) => new CommandLineInvalid({ command, reason: userError.message }),
    ShowHelp: () => new CommandMissing({ command }),
  });

export const describeUsageErrors = ({
  commandPath,
  errors: [error],
  words,
}: {
  readonly commandPath: readonly string[];
  readonly errors: readonly CliError.CliError[];
  readonly words: readonly string[];
}) => {
  const command = commandPath.join(" ");
  return error === undefined
    ? new CommandMissing({ command })
    : describeUsageError({ command, error, words });
};

export const formatUsageErrors = (errors: readonly CliError.CliError[]) =>
  describeUsageErrors({ commandPath: [PROGRAM], errors, words: [] }).message;

export const findUnknownShortFlagError = (words: readonly string[]) => {
  const found = findUnknownShortFlag(words);
  if (found === undefined) {
    return Option.none();
  }
  const subcommand = subcommandOf(words);
  return Option.some(
    new UnknownFlag({
      command: [PROGRAM, ...(subcommand === undefined ? [] : [subcommand])].join(" "),
      flag: found.flag,
      argument: found.argument,
      hint: hintForUnknownFlag({
        words,
        index: found.index,
        subcommand,
        textPositions: TEXT_POSITIONS,
      }),
    }),
  );
};
