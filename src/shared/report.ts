import { Schema } from "effect";

export const Audience = Schema.Struct({
  mode: Schema.Literals(["json", "terminal"]),
  home: Schema.String,
});

export class Shown {
  public readonly show: (audience: typeof Audience.Type) => string;

  public constructor(show: (audience: typeof Audience.Type) => string) {
    this.show = show;
  }
}

export class Report {
  public readonly parts: {
    readonly message: Shown;
    readonly hint?: Shown | undefined;
    readonly details?: Shown | undefined;
    readonly data?: Readonly<Record<string, Schema.Json>> | undefined;
  };

  public constructor(parts: Report["parts"]) {
    this.parts = parts;
  }
}

export const ECHO_LIMIT = 100;

const ESCAPE_CODE = 0x1b;

const BELL_CODE = 0x07;

const C1_CSI_CODE = 0x9b;

const C1_STRING_TERMINATOR_CODE = 0x9c;

const DEVICE_CONTROL_STRING_CODE = 0x90;

const START_OF_STRING_CODE = 0x98;

const OPERATING_SYSTEM_COMMAND_CODE = 0x9d;

const PRIVACY_MESSAGE_CODE = 0x9e;

const APPLICATION_PROGRAM_COMMAND_CODE = 0x9f;

const C1_STRING_START_CODES = [
  DEVICE_CONTROL_STRING_CODE,
  START_OF_STRING_CODE,
  OPERATING_SYSTEM_COMMAND_CODE,
  PRIVACY_MESSAGE_CODE,
  APPLICATION_PROGRAM_COMMAND_CODE,
];

const ESCAPE = String.fromCodePoint(ESCAPE_CODE);

const BELL = String.fromCodePoint(BELL_CODE);

const C1_CSI = String.fromCodePoint(C1_CSI_CODE);

const C1_STRING_TERMINATOR = String.fromCodePoint(C1_STRING_TERMINATOR_CODE);

const C1_STRING_STARTS = C1_STRING_START_CODES.map((code) => String.fromCodePoint(code)).join("");

const ESCAPE_SEQUENCE = new RegExp(
  [
    `${ESCAPE}\\[[0-?]*[ -/]*[@-~]`,
    `${ESCAPE}\\][^${BELL}${ESCAPE}]*(?:${BELL}|${ESCAPE}\\\\)`,
    `${ESCAPE}[PX^_][^${ESCAPE}]*${ESCAPE}\\\\`,
    `${ESCAPE}[ -/]*[0-~]`,
    `${C1_CSI}[0-?]*[ -/]*[@-~]`,
    `[${C1_STRING_STARTS}][^${BELL}${ESCAPE}${C1_STRING_TERMINATOR}]*(?:${BELL}|${C1_STRING_TERMINATOR}|${ESCAPE}\\\\)`,
  ].join("|"),
  "gu",
);

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;

const HAS_INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

const NEWLINE = "\n";

const DELETE = 0x7f;

const LAST_C0_CONTROL = 0x1f;

const CONTROL_PICTURES = 0x24_00;

const DELETE_PICTURE = "␡";

const RETURN_SYMBOL = "⏎";

const HEX = 16;

const UNICODE_DIGITS = 4;

const BYTE_DIGITS = 2;

const codeOf = (character: string) => character.codePointAt(0) ?? 0;

const markInvisible = (character: string) => {
  if (character === NEWLINE) {
    return RETURN_SYMBOL;
  }
  const code = codeOf(character);
  if (code <= LAST_C0_CONTROL) {
    return String.fromCodePoint(CONTROL_PICTURES + code);
  }
  if (code === DELETE) {
    return DELETE_PICTURE;
  }
  return `<U+${code.toString(HEX).toUpperCase().padStart(UNICODE_DIGITS, "0")}>`;
};

export const showOnTerminal = (value: string) =>
  value
    .replaceAll(ESCAPE_SEQUENCE, "")
    .replaceAll(INVISIBLE, (character) => markInvisible(character));

const showValue = (value: string, { mode }: typeof Audience.Type) =>
  mode === "terminal" ? showOnTerminal(value) : value;

const NEEDS_NO_QUOTES = /^[\w./:@%+=,-]+$/u;

const ANSI_C_ESCAPES: ReadonlyMap<string, string> = new Map([
  ["\n", String.raw`\n`],
  ["\t", String.raw`\t`],
  ["\r", String.raw`\r`],
  ["'", String.raw`\'`],
  ["\\", String.raw`\\`],
]);

const escapeForAnsiC = (character: string) => {
  const known = ANSI_C_ESCAPES.get(character);
  if (known !== undefined) {
    return known;
  }
  if (!HAS_INVISIBLE.test(character)) {
    return character;
  }
  return Array.from(
    new TextEncoder().encode(character),
    (byte) => String.raw`\x${byte.toString(HEX).padStart(BYTE_DIGITS, "0")}`,
  ).join("");
};

export const quoteForShell = (word: string) => {
  if (NEEDS_NO_QUOTES.test(word)) {
    return word;
  }
  if (!HAS_INVISIBLE.test(word)) {
    return `'${word.replaceAll("'", String.raw`'\''`)}'`;
  }
  return `$'${Array.from(word, (character) => escapeForAnsiC(character)).join("")}'`;
};

const CODE_POINT = /[\s\S]/gu;

export const charactersOf = (value: string) => value.match(CODE_POINT) ?? [];

export const isEchoable = (value: string) => charactersOf(value).length <= ECHO_LIMIT;

export const cutToEchoLimit = (value: string) => {
  const characters = charactersOf(value);
  return characters.length > ECHO_LIMIT ? `${characters.slice(0, ECHO_LIMIT).join("")}…` : value;
};

const showPart = (part: Shown | number | string, audience: typeof Audience.Type) => {
  if (typeof part === "number") {
    return String(part);
  }
  return typeof part === "string" ? showValue(part, audience) : part.show(audience);
};

export const prose = (
  literals: TemplateStringsArray,
  ...parts: readonly (Shown | number | string)[]
) =>
  new Shown((audience) =>
    literals
      .map((literal, index) => {
        const part = parts[index - 1];
        return `${part === undefined ? "" : showPart(part, audience)}${literal}`;
      })
      .join(""),
  );

export const trusted = (literal: string) => new Shown(() => literal);

export const joined = (parts: readonly Shown[], separator: string) =>
  new Shown((audience) => parts.map((part) => part.show(audience)).join(separator));

export const quoted = (value: string) =>
  new Shown((audience) => {
    const characters = charactersOf(value);
    if (characters.length <= ECHO_LIMIT) {
      return `"${showValue(value, audience)}"`;
    }
    return `"${showValue(cutToEchoLimit(value), audience)}" (the first ${ECHO_LIMIT} of its ${characters.length} characters)`;
  });

export const homePath = (value: string) =>
  new Shown(({ home }) => {
    const isInHome = home !== "" && value.startsWith(`${home}/`);
    if (!isInHome) {
      return quoteForShell(value);
    }
    const rest = value.slice(home.length + 1);
    return rest === "" ? "~/" : `~/${quoteForShell(rest)}`;
  });

export const shellCommand = (words: readonly string[]) =>
  new Shown(() => words.map((word) => quoteForShell(word)).join(" "));

export const messageOf = (report: Report) => report.parts.message.show({ mode: "json", home: "" });
