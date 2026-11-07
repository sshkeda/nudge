import { isEchoable, quoteForShell } from "../shared/report.ts";
import { SHORT_FLAG_NAMES, VALUE_FLAG_NAMES } from "./command-flags.ts";
import { PROGRAM } from "./errors.ts";

export const END_OF_FLAGS = "--";

const NEGATIVE_NUMBER = /^-(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/u;

const looksLikeFlag = (word: string) => {
  const isDashOnly = word === "-";
  return word.startsWith("-") && !isDashOnly && !NEGATIVE_NUMBER.test(word);
};

export const flagName = (word: string) => {
  const withoutDashes = word.replace(/^--?/u, "");
  const equals = withoutDashes.indexOf("=");
  return equals === -1 ? withoutDashes : withoutDashes.slice(0, equals);
};

const NO_VALUE = -1;

const describeWord = ({
  words,
  index,
  isAfterEnd,
}: {
  readonly words: readonly string[];
  readonly index: number;
  readonly isAfterEnd: boolean;
}) => {
  const word = words[index] ?? "";
  if (isAfterEnd) {
    return { kind: "positional", index, name: "", valueIndex: NO_VALUE } as const;
  }
  if (word === END_OF_FLAGS) {
    return { kind: "end", index, name: "", valueIndex: NO_VALUE } as const;
  }
  if (!looksLikeFlag(word)) {
    return { kind: "positional", index, name: "", valueIndex: NO_VALUE } as const;
  }
  const name = flagName(word);
  const isLongWithoutValue = word.startsWith("--") && !word.includes("=");
  const takesNextWord =
    isLongWithoutValue && VALUE_FLAG_NAMES.has(name) && index + 1 < words.length;
  return { kind: "flag", index, name, valueIndex: takesNextWord ? index + 1 : NO_VALUE } as const;
};

const classifyFrom = ({
  words,
  index,
  isAfterEnd,
}: {
  readonly words: readonly string[];
  readonly index: number;
  readonly isAfterEnd: boolean;
}): readonly ReturnType<typeof describeWord>[] => {
  if (index >= words.length) {
    return [];
  }
  const word = describeWord({ words, index, isAfterEnd });
  return [
    word,
    ...classifyFrom({
      words,
      index: Math.max(word.valueIndex, index) + 1,
      isAfterEnd: isAfterEnd || word.kind === "end",
    }),
  ];
};

export const classify = (words: readonly string[]) =>
  classifyFrom({ words, index: 0, isAfterEnd: false });

export const positionalsOf = (words: readonly string[]) =>
  classify(words).flatMap((word) =>
    word.kind === "positional" ? [{ index: word.index, value: words[word.index] ?? "" }] : [],
  );

const JSON_FLAG = "--json";

const JSON_FLAG_WITH_VALUE = `${JSON_FLAG}=`;

const TRUE_VALUES: ReadonlySet<string> = new Set(["true", "yes", "on", "1", "y"]);

const turnsJsonOn = (argument: string) =>
  argument === JSON_FLAG ||
  (argument.startsWith(JSON_FLAG_WITH_VALUE) &&
    TRUE_VALUES.has(argument.slice(JSON_FLAG_WITH_VALUE.length)));

export const isJsonRequested = (words: readonly string[]) =>
  classify(words).some((word) => word.kind === "flag" && turnsJsonOn(words[word.index] ?? ""));

export const withoutFlags = (words: readonly string[], names: ReadonlySet<string>) => {
  const dropped = new Set(
    classify(words).flatMap((word) => {
      const isDropped = word.kind === "flag" && names.has(word.name);
      if (!isDropped) {
        return [];
      }
      return word.valueIndex === NO_VALUE ? [word.index] : [word.index, word.valueIndex];
    }),
  );
  return words.filter((_word, index) => !dropped.has(index));
};

const readsStandardInput = (words: readonly string[]) => {
  const [subcommand, ...positionals] = positionalsOf(words);
  const acceptsStandardInput = subcommand?.value === "send" || subcommand?.value === "new";
  if (!acceptsStandardInput) {
    return false;
  }
  const text = positionals[1];
  return text === undefined || text.value === "-";
};

export const renderCommand = (words: readonly string[]) => {
  const isShort = words.every((word) => isEchoable(word));
  return isShort ? [PROGRAM, ...words].map((word) => quoteForShell(word)).join(" ") : null;
};

export const rerun = (words: readonly string[]) =>
  readsStandardInput(words) ? null : renderCommand(words);

export const withJsonAfterCommand = (words: readonly string[]) => {
  const [command] = positionalsOf(words);
  if (command === undefined) {
    return words;
  }
  const leadingJson = new Set(
    classify(words).flatMap((word) => {
      const isLeadingJson =
        word.kind === "flag" && word.name === "json" && word.index < command.index;
      return isLeadingJson ? [word.index] : [];
    }),
  );
  return [
    ...words.slice(0, command.index).filter((_word, index) => !leadingJson.has(index)),
    command.value,
    ...words.filter((_word, index) => leadingJson.has(index)),
    ...words.slice(command.index + 1),
  ];
};

const SHORT_FLAG_WORD = /^-(?<letters>[A-Za-z]+)$/u;

export const findUnknownShortFlag = (words: readonly string[]) =>
  classify(words)
    .flatMap((word) => {
      const argument = words[word.index] ?? "";
      const letters =
        word.kind === "flag" ? SHORT_FLAG_WORD.exec(argument)?.groups?.["letters"] : "";
      const unknown = (letters ?? "").split("").find((letter) => !SHORT_FLAG_NAMES.has(letter));
      return unknown === undefined ? [] : [{ index: word.index, argument, flag: `-${unknown}` }];
    })
    .at(0);

const isTextPosition = ({
  words,
  index,
  subcommand,
  textPositions,
}: {
  readonly words: readonly string[];
  readonly index: number;
  readonly subcommand: string;
  readonly textPositions: ReadonlyMap<string, number>;
}) => {
  const positionalsBefore = positionalsOf(words).filter((word) => word.index < index).length - 1;
  const textPosition = textPositions.get(subcommand);
  const hasLaterEnd = classify(words).some((word) => word.index > index && word.kind === "end");
  const isOneWord = classify(words).every((word) =>
    word.index === index
      ? word.valueIndex === NO_VALUE
      : word.index < index || word.kind === "flag",
  );
  return positionalsBefore === textPosition && !hasLaterEnd && isOneWord;
};

const asTextFrom = ({
  words,
  index,
}: {
  readonly words: readonly string[];
  readonly index: number;
}) => {
  const laterFlags = new Set(
    classify(words).flatMap((word) => {
      const isLaterFlag = word.index > index && word.kind === "flag";
      if (!isLaterFlag) {
        return [];
      }
      return word.valueIndex === NO_VALUE ? [word.index] : [word.index, word.valueIndex];
    }),
  );
  const rest = words.slice(index);
  const restIndexes = rest.map((_word, offset) => index + offset);
  return [
    ...words.slice(0, index),
    ...restIndexes
      .filter((position) => laterFlags.has(position))
      .map((position) => words[position] ?? ""),
    END_OF_FLAGS,
    ...restIndexes
      .filter((position) => !laterFlags.has(position))
      .map((position) => words[position] ?? ""),
  ];
};

export const hintForUnknownFlag = ({
  words,
  index,
  subcommand,
  textPositions,
}: {
  readonly words: readonly string[];
  readonly index: number;
  readonly subcommand: string | undefined;
  readonly textPositions: ReadonlyMap<string, number>;
}) => {
  if (subcommand === undefined) {
    return renderCommand(["--help"]);
  }
  const asText = isTextPosition({ words, index, subcommand, textPositions })
    ? renderCommand(asTextFrom({ words, index }))
    : null;
  return asText ?? renderCommand([subcommand, "--help"]);
};
