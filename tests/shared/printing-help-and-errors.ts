import assert from "node:assert/strict";

import { Effect, Option } from "effect";

import { version } from "../../package.json" with { type: "json" };
import { readBuildCommit } from "../../scripts/shared/build-nudge.ts";
import { ECHO_LIMIT } from "../../src/shared/report.ts";
import {
  FAILED_EXIT_CODE,
  jsonLine,
  machineTest,
  MISSING_ID,
  NUDGE,
  USAGE_EXIT_CODE,
} from "./machine-commands.ts";

const HELP = `List, start and message Codex Desktop and Claude Code sessions.

Usage:
  nudge [command] [flags]

Available Commands:
  list        List sessions, most recent first, 20 at a time.
  show        Show a session's details and the path of its transcript, even if it's archived.
  new         Start a session with a prompt as its first message.
  send        Send a message to a session.
  rename      Rename a session.
  archive     Archive a session.
  unarchive   Unarchive a session.
  doctor      Check nudge's setup, and print how to fix what isn't. It changes nothing.

Flags:
  -h, --help      Show this help.
  -v, --version   Print nudge's version.

Use "nudge [command] --help" for more about a command.`;

const SEND_HELP = `Send a message to a session.

<session> is a session's ID, exact name or codex:// link. Without [message], or with -, nudge reads the message from stdin.

nudge send exits with 0 when the message arrived, 1 when it failed, 2 when the command is wrong, and 3 when Claude holds it for approval. Don't resend a held message while it's pending.

Usage:
  nudge send [flags] <session> [message]

Flags:
      --effort <effort>   Send the message with this reasoning effort. A Claude session can't change effort.
  -h, --help              Show this help.
      --json              Print the result as JSON.
      --model <model>     Send the message with this model. A Claude session can't change model.
      --speed <speed>     Send the message at this speed: standard or fast. A Claude session can't change speed. Without it, the session keeps its current speed.`;

const NEW_HELP = `Start a session with a prompt as its first message.

<agent> is codex, for a session in Codex Desktop, or claude, for a Claude Code background session. Without [prompt], or with -, nudge reads the prompt from stdin.

A Codex session starts in the current folder if that folder is a Codex Desktop project, and otherwise in a new folder that Codex Desktop makes. A Claude session starts in the current folder.

Usage:
  nudge new [flags] <agent> [prompt]

Flags:
      --effort <effort>   Start it with this reasoning effort. Required unless the model has none.
  -h, --help              Show this help.
      --json              Print the result as JSON.
      --model <model>     Start it with this model. Required.
      --name <name>       Name the session. Without it, Claude names a Claude session itself, which can take a moment.
      --speed <speed>     Run the session at this speed: standard or fast. Without it, nudge runs it at standard.`;

const LIST_HELP = `List sessions, most recent first, 20 at a time.

With [query], nudge lists only the ones whose name, provider or ID contains it, ignoring case.

Usage:
  nudge list [flags] [query]

Flags:
      --all          List every match. You can't use it with --limit.
      --archived     List archived sessions instead.
  -h, --help         Show this help.
      --json         Print the result as JSON.
      --limit <n>    List at most this many matches. The default is 20.
      --offset <n>   Skip this many matches first.`;

const SHOW_HELP = `Show a session's details and the path of its transcript, even if it's archived.

<session> is a session's ID, exact name or codex:// link.

Usage:
  nudge show [flags] <session>

Flags:
  -h, --help   Show this help.
      --json   Print the result as JSON.`;

const RENAME_HELP = `Rename a session.

<session> is a session's ID, exact name or codex:// link.

Usage:
  nudge rename [flags] <session> <name>

Flags:
  -h, --help   Show this help.
      --json   Print the result as JSON.`;

const ARCHIVE_HELP = `Archive a session.

<session> is a session's ID, exact name or codex:// link.

Usage:
  nudge archive [flags] <session>

Flags:
  -h, --help   Show this help.
      --json   Print the result as JSON.`;

const UNARCHIVE_HELP = `Unarchive a session.

<session> is a session's ID, exact name or codex:// link.

Usage:
  nudge unarchive [flags] <session>

Flags:
  -h, --help   Show this help.
      --json   Print the result as JSON.`;

const DOCTOR_HELP = `Check nudge's setup, and print how to fix what isn't. It changes nothing.

Usage:
  nudge doctor [flags]

Flags:
  -h, --help   Show this help.
      --json   Print the result as JSON.`;

const LONG_LENGTH = 150;

const LONG = "a".repeat(LONG_LENGTH);

const LONG_ECHO = `"${"a".repeat(ECHO_LIMIT)}…" (the first ${ECHO_LIMIT} of its ${LONG_LENGTH} characters)`;

const USAGE_ERRORS = [
  {
    command: "send < /dev/null",
    json: "send --json < /dev/null",
    error: "SessionArgumentMissing",
    message: "nudge send needs a session ID or name",
    hint: "nudge list",
  },
  {
    command: "show",
    json: "show --json",
    error: "SessionArgumentMissing",
    message: "nudge show needs a session ID or name",
    hint: "nudge list",
  },
  {
    command: "show",
    json: "show --json=true",
    error: "SessionArgumentMissing",
    message: "nudge show needs a session ID or name",
    hint: "nudge list",
  },
  {
    command: "unarchive",
    json: "unarchive --json",
    error: "SessionArgumentMissing",
    message: "nudge unarchive needs a session ID or name",
    hint: "nudge list --archived",
  },
  {
    command: "send '' hi",
    json: "send --json '' hi",
    error: "SessionArgumentMissing",
    message: "nudge send needs a session ID or name",
    hint: "nudge list",
  },
  {
    command: "send ' ' hi",
    json: "send --json ' ' hi",
    error: "SessionArgumentMissing",
    message: "nudge send needs a session ID or name",
    hint: "nudge list",
  },
  {
    command: "rename '' y",
    json: "rename --json '' y",
    error: "SessionArgumentMissing",
    message: "nudge rename needs a session ID or name",
    hint: "nudge list",
  },
  {
    command: "show ''",
    json: "show --json ''",
    error: "SessionArgumentMissing",
    message: "nudge show needs a session ID or name",
    hint: "nudge list",
  },
  {
    command: "archive ''",
    json: "archive --json ''",
    error: "SessionArgumentMissing",
    message: "nudge archive needs a session ID or name",
    hint: "nudge list",
  },
  {
    command: "unarchive ''",
    json: "unarchive --json ''",
    error: "SessionArgumentMissing",
    message: "nudge unarchive needs a session ID or name",
    hint: "nudge list --archived",
  },
  {
    command: "list --bogus",
    json: "list --json --bogus",
    error: "UnknownFlag",
    message: `"--bogus" looks like a flag, but nudge list has no such flag`,
    hint: "nudge list -- --bogus",
    jsonHint: "nudge list --json -- --bogus",
  },
  {
    command: "list --archivd",
    json: "list --json --archivd",
    error: "UnknownFlag",
    message: `"--archivd" looks like a flag, but nudge list has no such flag`,
    hint: "nudge list --archived",
    jsonHint: "nudge list --json --archived",
  },
  {
    command: "list --all --limit 3",
    json: "list --json --all --limit 3",
    error: "FlagsConflict",
    message: "you can't use --all with --limit",
    hint: "nudge list --all",
    jsonHint: "nudge list --json --all",
  },
  {
    command: "list --limit abc",
    json: "list --json --limit abc",
    error: "FlagValueInvalid",
    message: `--limit must be a whole number, not "abc"`,
    hint: "nudge list --help",
  },
  {
    command: `list --limit ${LONG}`,
    json: `list --json --limit ${LONG}`,
    error: "FlagValueInvalid",
    message: `--limit must be a whole number, not ${LONG_ECHO}`,
    hint: "nudge list --help",
  },
  {
    command: "list --limit 1 --limit 2",
    json: "list --json --limit 1 --limit 2",
    error: "FlagRepeated",
    message: "--limit can only be given once",
    hint: "nudge list --help",
  },
  {
    command: "list --archived --archived",
    json: "list --json --archived --archived",
    error: "FlagRepeated",
    message: "--archived can only be given once",
    hint: "nudge list --help",
  },
  {
    command: "list --limit",
    json: "list --json --limit",
    error: "FlagValueMissing",
    message: "--limit needs a value",
    hint: "nudge list --help",
  },
  {
    command: "list --offset nope",
    json: "list --json --offset nope",
    error: "FlagValueInvalid",
    message: `--offset must be a whole number, not "nope"`,
    hint: "nudge list --help",
  },
  {
    command: "list --limit 0",
    json: "list --json --limit 0",
    error: "FlagValueTooSmall",
    message: "--limit must be 1 or more, not 0",
    hint: "nudge list --help",
  },
  {
    command: "list --offset -1",
    json: "list --json --offset -1",
    error: "FlagValueTooSmall",
    message: "--offset must be 0 or more, not -1",
    hint: "nudge list --help",
  },
  {
    command: "show -zzv",
    json: "show --json -zzv",
    error: "UnknownFlag",
    message: `"-zzv" looks like a flag, but nudge show has no flag "-z"`,
    hint: "nudge show --help",
  },
  {
    command: "lst",
    json: "lst --json",
    error: "UnknownCommand",
    message: `nudge has no command "lst"`,
    hint: "nudge list",
    jsonHint: "nudge list --json",
  },
  {
    command: "lst --help",
    json: "lst --json --help",
    error: "UnknownCommand",
    message: `nudge has no command "lst"`,
    hint: "nudge list --help",
    jsonHint: "nudge list --json --help",
  },
  {
    command: "help bogus",
    json: "help bogus --json",
    error: "UnknownCommand",
    message: `nudge has no command "bogus"`,
    hint: "nudge --help",
  },
  {
    command: LONG,
    json: `${LONG} --json`,
    error: "UnknownCommand",
    message: `nudge has no command ${LONG_ECHO}`,
    hint: "nudge --help",
  },
  {
    command: "--bogus",
    json: "--json --bogus",
    error: "UnknownFlag",
    message: `"--bogus" looks like a flag, but nudge has no such flag`,
    hint: "nudge --help",
    jsonMessage: `"--json" looks like a flag, but nudge has no such flag`,
  },
  {
    command: "new codex hello --speed bogus",
    json: "new --json codex hello --speed bogus",
    error: "FlagValueInvalid",
    message: `--speed must be standard or fast, not "bogus"`,
    hint: "nudge new --help",
  },
  {
    command: `send ${MISSING_ID} hello --speed bogus`,
    json: `send --json ${MISSING_ID} hello --speed bogus`,
    error: "FlagValueInvalid",
    message: `--speed must be standard or fast, not "bogus"`,
    hint: "nudge send --help",
  },
  {
    command: `send ${MISSING_ID} hello --fast`,
    json: `send --json ${MISSING_ID} hello --fast`,
    error: "UnknownFlag",
    message: `"--fast" looks like a flag, but nudge send has no such flag`,
    hint: "nudge send --help",
  },
  {
    command: "new gemini hello",
    json: "new --json gemini hello",
    error: "ArgumentValueInvalid",
    message: `agent must be codex or claude, not "gemini"`,
    hint: "nudge new --help",
  },
  {
    command: "new",
    json: "new --json",
    error: "ArgumentMissing",
    message: "nudge new needs an agent, codex or claude",
    hint: "nudge new --help",
  },
  {
    command: "show Two Words",
    json: "show --json Two Words",
    error: "ExtraArguments",
    message: `nudge show got the extra argument "Words"`,
    hint: "nudge show --help",
  },
  {
    command: `send ${MISSING_ID} ''`,
    json: `send --json ${MISSING_ID} ''`,
    error: "MessageEmpty",
    message: "the message is empty",
    hint: null,
  },
  {
    command: "new claude '  '",
    json: "new --json claude '  '",
    error: "PromptEmpty",
    message: "the prompt is empty",
    hint: null,
  },
] as const;

export const printingHelpAndErrors = machineTest((machine) =>
  Effect.gen(function* () {
    const [
      help = "",
      bare = "",
      helpCommand = "",
      sendHelp = "",
      helpSend = "",
      helpHelp = "",
      helpFlagHelp = "",
      listHelp = "",
      shownVersion = "",
    ] = yield* machine.shells([
      `${NUDGE} --help`,
      NUDGE,
      `${NUDGE} help`,
      `${NUDGE} send --help`,
      `${NUDGE} help send`,
      `${NUDGE} help help`,
      `${NUDGE} -h help`,
      `${NUDGE} list -h`,
      `${NUDGE} --version`,
    ]);
    assert.equal(help, HELP);
    assert.equal(bare, HELP);
    assert.equal(helpCommand, HELP);
    assert.equal(sendHelp, SEND_HELP);
    assert.equal(helpSend, SEND_HELP);
    assert.equal(helpHelp, HELP);
    assert.equal(helpFlagHelp, HELP);
    assert.equal(yield* machine.nudge("new --help"), NEW_HELP);
    assert.equal(yield* machine.nudge("new --help --json"), NEW_HELP);
    assert.equal(listHelp, LIST_HELP);
    const expectedVersion = Option.match(yield* readBuildCommit, {
      onNone: () => "a version with the checkout's commit",
      onSome: (commit) => `${version} (${commit})`,
    });
    assert.equal(shownVersion, expectedVersion);
    assert.equal(yield* machine.nudge("-v"), expectedVersion);
    assert.deepEqual(
      yield* machine.shells([
        `${NUDGE} show --help`,
        `${NUDGE} rename -h`,
        `${NUDGE} archive --help`,
        `${NUDGE} unarchive --help`,
        `${NUDGE} doctor --help`,
      ]),
      [SHOW_HELP, RENAME_HELP, ARCHIVE_HELP, UNARCHIVE_HELP, DOCTOR_HELP],
    );

    const notFound = [
      { target: MISSING_ID, echo: `"${MISSING_ID}"` },
      { target: "No Such Session", echo: `"No Such Session"` },
      { target: LONG, echo: LONG_ECHO },
    ];
    for (const { target, echo } of notFound) {
      const message = `no session matches ${echo}`;
      assert.deepEqual(yield* machine.attempt(`${NUDGE} send '${target}' hello`), {
        code: FAILED_EXIT_CODE,
        standardOutput: "",
        standardError: `error: ${message}\nhint: nudge list`,
      });
      assert.deepEqual(yield* machine.attempt(`${NUDGE} send --json '${target}' hello`), {
        code: FAILED_EXIT_CODE,
        standardOutput: "",
        standardError: yield* jsonLine({
          error: "SessionNotFound",
          message,
          hint: "nudge list",
        }),
      });
    }
    const [listed] = yield* machine.runHints("hint: nudge list");
    assert.ok(listed);
    assert.equal(listed.code, 0, listed.standardError);

    for (const usage of USAGE_ERRORS) {
      const plain = yield* machine.attempt(`${NUDGE} ${usage.command}`);
      assert.deepEqual(plain, {
        code: USAGE_EXIT_CODE,
        standardOutput: "",
        standardError:
          usage.hint === null
            ? `error: ${usage.message}`
            : `error: ${usage.message}\nhint: ${usage.hint}`,
      });
      assert.deepEqual(yield* machine.attempt(`${NUDGE} ${usage.json}`), {
        code: USAGE_EXIT_CODE,
        standardOutput: "",
        standardError: yield* jsonLine({
          error: usage.error,
          message: "jsonMessage" in usage ? usage.jsonMessage : usage.message,
          hint: "jsonHint" in usage ? usage.jsonHint : usage.hint,
        }),
      });
      for (const hinted of yield* machine.runHints(plain.standardError)) {
        assert.equal(hinted.code, 0, `${usage.command}: ${hinted.standardError}`);
      }
    }
  }),
);
