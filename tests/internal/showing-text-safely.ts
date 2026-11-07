import assert from "node:assert/strict";

import { Task } from "@sshkeda/task";
import { Effect } from "effect";

import { runShell } from "../../scripts/shared/run-shell.ts";
import {
  ECHO_LIMIT,
  homePath,
  quoted,
  quoteForShell,
  showOnTerminal,
} from "../../src/shared/report.ts";

const ESCAPE = "\u001B";

const RIGHT_TO_LEFT_OVERRIDE_CODE = 0x20_2e;

const RIGHT_TO_LEFT_OVERRIDE = String.fromCodePoint(RIGHT_TO_LEFT_OVERRIDE_CODE);

const POP_DIRECTIONAL_FORMATTING_CODE = 0x20_2c;

const POP_DIRECTIONAL_FORMATTING = String.fromCodePoint(POP_DIRECTIONAL_FORMATTING_CODE);

const ZERO_WIDTH_SPACE_CODE = 0x20_0b;

const ZERO_WIDTH_SPACE = String.fromCodePoint(ZERO_WIDTH_SPACE_CODE);

const C1_NEXT_LINE = "\u0085";

const LONG_LENGTH = 150;

const TERMINAL = { mode: "terminal", home: "/home/user" } as const;

const JSON_MODE = { mode: "json", home: "/home/user" } as const;

const SHOWN = [
  { text: `red ${ESCAPE}[31mtext${ESCAPE}[0m`, shown: "red text" },
  { text: `title ${ESCAPE}]0;evil\u0007set`, shown: "title set" },
  { text: `ends with ${ESCAPE}`, shown: "ends with ␛" },
  { text: "line\nbreak\r\ttab", shown: "line⏎break␍␉tab" },
  { text: "bell\u0007 delete\u007F", shown: "bell␇ delete␡" },
  {
    text: `bidi ${RIGHT_TO_LEFT_OVERRIDE}evil${POP_DIRECTIONAL_FORMATTING} zero${ZERO_WIDTH_SPACE}width`,
    shown: "bidi <U+202E>evil<U+202C> zero<U+200B>width",
  },
  { text: "c1 \u0085 next", shown: "c1 <U+0085> next" },
  { text: `quotes "kept" and 'kept' and é`, shown: `quotes "kept" and 'kept' and é` },
] as const;

const QUOTED = [
  { word: "plain-word_1.2", quoted: "plain-word_1.2" },
  { word: "two words", quoted: "'two words'" },
  { word: "it's", quoted: String.raw`'it'\''s'` },
  { word: "a\nb", quoted: String.raw`$'a\nb'` },
  { word: `esc${ESCAPE}[31m`, quoted: String.raw`$'esc\x1b[31m'` },
  { word: `bidi${RIGHT_TO_LEFT_OVERRIDE}'x`, quoted: String.raw`$'bidi\xe2\x80\xae\'x'` },
  { word: "", quoted: "''" },
  { word: `c1${C1_NEXT_LINE}`, quoted: String.raw`$'c1\xc2\x85'` },
] as const;

export const showingTextSafely = Task.make(
  "showing-text-safely",
  Effect.gen(function* () {
    for (const { text, shown } of SHOWN) {
      assert.equal(showOnTerminal(text), shown);
    }
    for (const { word, quoted: expected } of QUOTED) {
      assert.equal(quoteForShell(word), expected);
      const printed = yield* runShell(`printf '%s' ${quoteForShell(word)} | od -An -c`);
      const expectedBytes = yield* runShell(
        `printf '%s' "$1" | od -An -c`.replace(
          '"$1"',
          `'${word.replaceAll("'", String.raw`'\''`)}'`,
        ),
      );
      assert.equal(printed, expectedBytes, `${expected} doesn't round-trip through the shell`);
    }
    const long = "x".repeat(LONG_LENGTH);
    assert.equal(
      quoted(long).show(TERMINAL),
      `"${"x".repeat(ECHO_LIMIT)}…" (the first ${ECHO_LIMIT} of its ${LONG_LENGTH} characters)`,
    );
    assert.equal(quoted("a\nb").show(TERMINAL), `"a⏎b"`);
    assert.equal(quoted("a\nb").show(JSON_MODE), `"a\nb"`);
    assert.equal(homePath("/home/user/My Folder/a.txt").show(TERMINAL), "~/'My Folder/a.txt'");
    assert.equal(homePath("/tmp/a.txt").show(TERMINAL), "/tmp/a.txt");
    assert.equal(homePath("/home/user/x\ny").show(TERMINAL), String.raw`~/$'x\ny'`);
  }),
  { timeout: "1 minute", cleanup: "1 minute" },
);
