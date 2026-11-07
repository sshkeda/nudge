import assert from "node:assert/strict";

import { Effect, Schema } from "effect";

import { BOGUS_CLAUDE_MODEL, OUT_OF_CREDIT } from "../../scripts/shared/aimock.ts";
import { BUN } from "../../scripts/shared/codex-and-claude.ts";
import { homePath } from "../../src/shared/report.ts";
import {
  CLAUDE_MODEL_AND_EFFORT,
  CODEX_MODEL_AND_EFFORT,
  FAILED_EXIT_CODE,
  hintsIn,
  machineTest,
  NUDGE,
  quoteForShell,
  rows,
  startedIdOf,
  USAGE_EXIT_CODE,
  UUID,
  WITHOUT_CLAUDE,
} from "./machine-commands.ts";
import { STATUS_COLUMN } from "./resuming-a-killed-claude-session.ts";

const acceptTheTrustPrompt = (hint: string) =>
  `${BUN} -e ${quoteForShell(String.raw`
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const decoder = new TextDecoder();
let transcript = "";
let pending = "";
let lines = [];
let row = 0;
let column = 0;
let saved = [0, 0];
let kitty = 0;
let modifyOtherKeys = false;
let exitCode;
let selection;
let selectionVersion = 0;
let sentKey = false;
const inputs = [];
const writeInput = (kind, bytes) => {
  inputs.push({ kind, bytes, selectionVersion });
  claude.terminal.write(bytes);
};
const writeKey = (bytes) => {
  sentKey = true;
  writeInput("key", bytes);
};
const noteSelection = (line) => {
  const match = /^\s*❯\s*(Yes, I trust this folder|No, exit)/.exec(line.join(""));
  if (match && match[1] !== selection) {
    selection = match[1];
    selectionVersion++;
  }
};
const visible = () => lines.map((line) => line?.join("") ?? "").join("\n");
const keyboardReady = () => kitty > 0 || modifyOtherKeys;
// Claude emits cursor-only diffs when the selection moves. Keep the cells they
// update: stripping ANSI from a chunk loses the label belonging to the new arrow.
const render = (text) => {
  pending += text;
  while (pending.length > 0) {
    if (pending[0] === "\x1b") {
      if (pending.length < 2) return;
      if (pending[1] === "[") {
        const match = /^\x1b\[([0-?]*)([ -/]*)([@-~])/.exec(pending);
        if (!match) return;
        pending = pending.slice(match[0].length);
        const [, parameters, , command] = match;
        const values = parameters.split(";").map(Number);
        const count = values[0] || 1;
        if (command === "u" && parameters.startsWith(">")) kitty = Number(parameters.slice(1));
        else if (command === "u" && parameters === "<") kitty = 0;
        else if (command === "m" && parameters.startsWith(">4")) modifyOtherKeys = parameters === ">4;2";
        else if (command === "A") row = Math.max(0, row - count);
        else if (command === "B") row += count;
        else if (command === "C") column += count;
        else if (command === "D") column = Math.max(0, column - count);
        else if (command === "G") column = count - 1;
        else if (command === "H" || command === "f") { row = count - 1; column = (values[1] || 1) - 1; }
        else if (command === "J" && values[0] === 2) lines = [];
        else if (command === "K") {
          const line = lines[row] ??= [];
          if (values[0] === 2) lines[row] = [];
          else if (values[0] === 1) line.fill(" ", 0, column + 1);
          else line.length = Math.min(line.length, column);
        }
        else if (command === "c" && parameters === "" && !sentKey) writeInput("query-reply", "\x1b[?0u\x1b[?62;22c");
        continue;
      }
      if (pending[1] === "]") {
        const match = /^\x1b\][\s\S]*?(?:\x07|\x1b\\)/.exec(pending);
        if (!match) return;
        pending = pending.slice(match[0].length);
        continue;
      }
      if (pending[1] === "7") saved = [row, column];
      else if (pending[1] === "8") [row, column] = saved;
      pending = pending.slice(2);
      continue;
    }
    const character = String.fromCodePoint(pending.codePointAt(0));
    pending = pending.slice(character.length);
    if (character === "\r") column = 0;
    else if (character === "\n") row++;
    else if (character >= " " && character !== "\x7f") {
      const line = lines[row] ??= [];
      while (line.length < column) line.push(" ");
      line[column++] = character;
      // Observe every cell update, including Yes -> No remounts contained in a
      // single PTY chunk. A 100ms poll can miss the intermediate selection.
      noteSelection(line);
    }
  }
};
const isTrusted = () => JSON.parse(readFileSync(home + "/.claude.json", "utf8")).projects?.[home + "/untrusted"]?.hasTrustDialogAccepted === true;
const claude = Bun.spawn(["bash", "-c", process.argv[1]], {
  cwd: home,
  env: { ...process.env, PATH: home + "/.local/bin:" + process.env.PATH, CLAUDE_CODE_NO_FLICKER: "1" },
  terminal: {
    cols: 120,
    rows: 40,
    data: (_, data) => {
      const text = decoder.decode(data, { stream: true });
      transcript += text;
      render(text);
    },
  },
});
claude.exited.then((code) => { exitCode = code; });
const fail = (message) => new Error(message + ": " + visible().slice(-1500) + "\nRecent terminal output: " + JSON.stringify(transcript.slice(-1500)) + "\nInputs: " + JSON.stringify(inputs));
const waitFor = async (ready, description, allowExit = false) => {
  const deadline = performance.now() + 60_000;
  while (!ready()) {
    if (!allowExit && exitCode !== undefined) throw fail("claude exited with code " + exitCode + " before " + description);
    if (performance.now() >= deadline) throw fail("claude timed out after 60 seconds waiting for " + description);
    await Bun.sleep(100);
  }
};
const press = (code, legacy) => writeKey(kitty > 0 ? "\x1b[" + code + "u" : modifyOtherKeys ? "\x1b[27;1;" + code + "~" : legacy);
try {
  await waitFor(() => keyboardReady() && visible().includes("Yes, I trust this folder"), "the trust dialog and enabled keyboard protocol");
  // Claude remounts the selector when its startup input guard settles. That
  // resets focus to No even after a successful Down. Act once per observed
  // selection transition rather than assuming Yes remains highlighted.
  let handledSelection = 0;
  await waitFor(() => {
    if (isTrusted()) return true;
    if (!keyboardReady() || handledSelection === selectionVersion) return false;
    handledSelection = selectionVersion;
    if (selection === "Yes, I trust this folder") press(13, "\r");
    else if (selection === "No, exit") writeKey("\x1b[B");
    return false;
  }, "the recorded trust for ~/untrusted after selection acknowledgements");
  await waitFor(() => keyboardReady() && /^❯[ \u00a0]/m.test(visible()) && /\? for shortcuts|shift\+tab to cycle/.test(visible()), "the interactive prompt after accepting trust");
  writeKey("/exit");
  press(13, "\r");
  await waitFor(() => exitCode !== undefined, "graceful exit after /exit", true);
  if (exitCode !== 0) throw fail("claude exited with code " + exitCode + " after /exit");
  if (!isTrusted()) throw fail("~/.claude.json no longer records the trust for ~/untrusted after claude exited");
} finally {
  if (exitCode === undefined) claude.kill("SIGKILL");
  claude.terminal.close();
}
`)} ${quoteForShell(hint)}`;

const ModelOrEffortMissing = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.Literal("ModelOrEffortMissing"),
    message: Schema.String,
    hint: Schema.Null,
    missing: Schema.Array(Schema.String),
    models: Schema.Array(
      Schema.Struct({
        model: Schema.String,
        efforts: Schema.Array(Schema.String),
        fast: Schema.Boolean,
      }),
    ),
  }),
);

const STARTED_SESSION_ID = /\((?<id>[\da-f-]{36})\) in ~\/work\.$/mu;

export const rejectingBadNewSessions = machineTest((machine) =>
  Effect.gen(function* () {
    const withoutModel = yield* machine.attempt(
      `${NUDGE} new codex 'hello' --name 'Nudge Without Model'`,
    );
    assert.equal(withoutModel.code, USAGE_EXIT_CODE, withoutModel.standardError);
    assert.equal(withoutModel.standardOutput, "");
    assert.match(
      withoutModel.standardError,
      /^error: nudge new needs --model and --effort\. Codex Desktop offers:\n\nMODEL +EFFORTS +FAST\n/u,
    );
    assert.match(withoutModel.standardError, /^gpt-6-astra +.*\bmedium\b/mu);
    assert.equal(
      (yield* machine.attempt(`${NUDGE} show 'Nudge Without Model'`)).code,
      FAILED_EXIT_CODE,
    );

    const withoutEffort = yield* machine.attempt(
      `${NUDGE} new claude 'hello' --model opus --name 'Nudge Without Effort'`,
    );
    assert.equal(withoutEffort.code, USAGE_EXIT_CODE, withoutEffort.standardError);
    assert.equal(withoutEffort.standardOutput, "");
    assert.match(
      withoutEffort.standardError,
      /^error: nudge new needs --effort\. Claude Code offers:\n\nMODEL +EFFORTS +FAST\n/u,
    );
    assert.match(withoutEffort.standardError, /^opus +.*\bmedium\b/mu);
    assert.doesNotMatch(withoutEffort.standardError, /^default /mu);

    const withoutModelJson = yield* machine.attempt(
      `${NUDGE} new --json claude 'hello' --effort medium --name 'Nudge Without Model'`,
    );
    assert.equal(withoutModelJson.code, USAGE_EXIT_CODE, withoutModelJson.standardError);
    const { message, missing, models } = yield* Schema.decodeEffect(ModelOrEffortMissing)(
      withoutModelJson.standardError,
    );
    assert.equal(message, "nudge new needs --model. Claude Code offers:");
    assert.deepEqual(missing, ["--model"]);
    assert.ok(models.some((offered) => offered.model === "opus" && offered.fast));
    assert.ok(models.some((offered) => offered.model === "haiku" && !offered.fast));
    assert.ok(models.every((offered) => offered.model !== "default"));
    const brokenClaude = `${machine.scratch}/broken-claude`;
    const startWithBrokenClaude = (script: string, model = "opus") =>
      Effect.gen(function* () {
        yield* machine.shell(
          `mkdir -p ${brokenClaude} && cat > ${brokenClaude}/claude <<'CLAUDE'\n#!/bin/sh\n${script}\nCLAUDE\nchmod +x ${brokenClaude}/claude`,
        );
        return yield* machine.attempt(
          `PATH="${brokenClaude}:$PATH" ${NUDGE} new claude 'hello' --model ${model}`,
        );
      });
    const effortless = yield* startWithBrokenClaude(
      `[ "$1" = -p ] && echo '{"type":"control_response","response":{"response":{"models":[{"value":"nudge-effortless"}]}}}' && exit 0\necho "$*" >&2\nexit 1`,
      "nudge-effortless",
    );
    assert.equal(effortless.code, FAILED_EXIT_CODE, effortless.standardError);
    assert.match(
      effortless.standardError,
      /^error: claude --bg exited with code 1: --bg --model=nudge-effortless --fast-mode=off -- hello$/u,
    );
    assert.doesNotMatch(effortless.standardError, /--effort/u);
    const LISTING = "claude -p --input-format stream-json --output-format stream-json --verbose";
    assert.deepEqual(yield* startWithBrokenClaude("echo not logged in >&2; exit 1"), {
      code: FAILED_EXIT_CODE,
      standardOutput: "",
      standardError: `error: nudge can't list Claude's models, because ${LISTING} failed: not logged in`,
    });
    assert.deepEqual(yield* startWithBrokenClaude("exit 1"), {
      code: FAILED_EXIT_CODE,
      standardOutput: "",
      standardError: `error: nudge can't list Claude's models, because ${LISTING} failed: exit code 1`,
    });
    assert.deepEqual(yield* startWithBrokenClaude("echo {}"), {
      code: FAILED_EXIT_CODE,
      standardOutput: "",
      standardError: `error: nudge can't list Claude's models, because ${LISTING} printed no model list`,
    });
    assert.equal((yield* machine.attempt(`${WITHOUT_CLAUDE} ! command -v claude`)).code, 0);
    assert.deepEqual(
      yield* machine.attempt(
        `${WITHOUT_CLAUDE} ${NUDGE} new claude ${CLAUDE_MODEL_AND_EFFORT} 'hello'`,
      ),
      {
        code: FAILED_EXIT_CODE,
        standardOutput: "",
        standardError:
          "error: nudge can't list Claude's models, because it can't find claude on your PATH",
      },
    );

    const refusedBeforeStarting = (name: string, flags: string, refusal: string) =>
      Effect.gen(function* () {
        const refused = yield* machine.attempt(
          `${NUDGE} new claude 'hello' --name '${name}' ${flags}`,
        );
        assert.equal(refused.code, USAGE_EXIT_CODE, refused.standardError);
        assert.equal(refused.standardOutput, "");
        assert.ok(
          refused.standardError.startsWith(`error: ${refusal} Claude Code offers:\n\nMODEL  `),
          refused.standardError,
        );
        assert.match(refused.standardError, /^opus +low, medium\b/mu);
        assert.doesNotMatch(yield* machine.nudge("list"), new RegExp(name, "u"));
      });
    yield* refusedBeforeStarting(
      "Nudge Bogus Model",
      `--model ${BOGUS_CLAUDE_MODEL} --effort medium`,
      `Claude has no model "${BOGUS_CLAUDE_MODEL}", so nudge didn't start the session.`,
    );
    yield* refusedBeforeStarting(
      "Nudge Bogus Effort",
      "--model opus --effort bogus",
      `Claude's model "opus" has no reasoning effort "bogus", so nudge didn't start the session.`,
    );
    const outOfCredit = yield* machine.attempt(
      `${NUDGE} new claude ${CLAUDE_MODEL_AND_EFFORT} '${OUT_OF_CREDIT}' --name 'Nudge Out Of Credit'`,
    );
    assert.equal(outOfCredit.code, FAILED_EXIT_CODE, outOfCredit.standardError);
    assert.equal(outOfCredit.standardOutput, "");
    assert.match(
      outOfCredit.standardError,
      /^error: Claude session "Nudge Out Of Credit" \([\da-f-]{36}\) failed its first request and nudge stopped it: .*credit balance is too low/iu,
    );
    assert.deepEqual(
      rows(yield* machine.nudge("list --archived 'Nudge Out Of Credit'")).map((row) => [
        row[0],
        row[STATUS_COLUMN],
      ]),
      [["Nudge Out Of Credit", "stopped"]],
    );
    const freshCodexHome = `${machine.scratch}/fresh-codex-home`;
    yield* machine.shell(`mkdir -p ${freshCodexHome}`);
    assert.deepEqual(
      yield* machine.attempt(
        `CODEX_HOME=${freshCodexHome} ${NUDGE} new codex ${CODEX_MODEL_AND_EFFORT} 'hello' --name 'Nudge Before Codex'`,
      ),
      {
        code: FAILED_EXIT_CODE,
        standardOutput: "",
        standardError: `error: ${homePath(freshCodexHome).show({ mode: "terminal", home: machine.home })} has no Codex state database, which Codex Desktop creates when it first starts`,
      },
    );
    const chosen = yield* machine.attempt(
      `${NUDGE} new --json claude 'hello' --name 'Nudge Chosen Model' --model sonnet --effort high`,
    );
    assert.equal(chosen.code, 0, chosen.standardError);
    assert.equal(chosen.standardError, "");
    const chosenId = yield* startedIdOf(chosen.standardOutput);
    yield* machine.waitUntilIdle(chosenId);
    const { transcript } = (yield* machine.showJson(chosenId)).target;
    assert.match(yield* machine.shell(`cat '${transcript}'`), /"model":"[^"]*sonnet/u);
    yield* machine.nudge(`archive ${chosenId}`);
    assert.deepEqual(
      yield* machine.attempt(
        `cd ~ && ${NUDGE} new claude ${CLAUDE_MODEL_AND_EFFORT} 'hello' --name 'Nudge Home'`,
      ),
      {
        code: FAILED_EXIT_CODE,
        standardOutput: "",
        standardError:
          "error: Claude trusts your home folder for one interactive session at a time, so it won't start a background session there, and nudge new claude needs to run in another folder",
      },
    );
    const untrusted = yield* machine.attempt(
      `mkdir -p ~/untrusted && cd ~/untrusted && ${NUDGE} new claude ${CLAUDE_MODEL_AND_EFFORT} 'hello' --name 'Nudge Untrusted'`,
    );
    assert.deepEqual(untrusted, {
      code: FAILED_EXIT_CODE,
      standardOutput: "",
      standardError: "error: Claude doesn't trust ~/untrusted yet\nhint: cd ~/untrusted && claude",
    });
    const [trustHint] = hintsIn(untrusted.standardError);
    yield* machine.shell(acceptTheTrustPrompt(trustHint ?? ""));
    const trusted = yield* machine.attempt(
      `cd ~/untrusted && ${NUDGE} new --json claude ${CLAUDE_MODEL_AND_EFFORT} 'hello' --name 'Nudge Untrusted'`,
    );
    assert.equal(trusted.code, 0, trusted.standardError);
    const trustedId = yield* startedIdOf(trusted.standardOutput);
    yield* machine.waitUntilIdle(trustedId);
    yield* machine.nudge(`archive ${trustedId}`);
    const [twinA = "", twinB = ""] = (yield* machine.shell(
      `{ ${NUDGE} new claude ${CLAUDE_MODEL_AND_EFFORT} 'hello' --name 'Nudge Twin' > ${machine.scratch}/twin-a 2>&1 & ${NUDGE} new claude ${CLAUDE_MODEL_AND_EFFORT} 'hello' --name 'Nudge Twin' > ${machine.scratch}/twin-b 2>&1; wait $!; cat ${machine.scratch}/twin-a; echo; echo ---; cat ${machine.scratch}/twin-b; }`,
    ))
      .split("---")
      .map((output) => STARTED_SESSION_ID.exec(output)?.groups?.["id"] ?? output);
    assert.match(twinA, UUID);
    assert.match(twinB, UUID);
    assert.notEqual(twinA, twinB);
    yield* machine.waitUntilIdle(twinA, twinB);
    yield* machine.nudge(`archive ${twinA}`);
    yield* machine.nudge(`archive ${twinB}`);
  }),
);
