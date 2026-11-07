import assert from "node:assert/strict";

import { Effect, Schema } from "effect";

import { BUN } from "../../scripts/shared/codex-and-claude.ts";
import {
  CLAUDE_MODEL_AND_EFFORT,
  jsonLine,
  machineTest,
  NUDGE,
  quoteForShell,
  startedIdOf,
  USAGE_EXIT_CODE,
  UUID,
} from "./machine-commands.ts";

const PROMPT_MISSING = {
  error: "PromptMissing",
  message: "nudge new needs a prompt as an argument or on stdin, and stdin is a terminal",
} as const;

const MESSAGE_MISSING = {
  error: "MessageMissing",
  message: "nudge send needs a message as an argument or on stdin, and stdin is a terminal",
} as const;

const WITH_A_TERMINAL_FOR_INPUT = [
  { words: '"new", "claude"', ...PROMPT_MISSING },
  { words: '"send", "Nowhere"', ...MESSAGE_MISSING },
  { words: '"send", "Nowhere", "-"', ...MESSAGE_MISSING },
];

export const passingPromptsThatLookLikeFlags = machineTest((machine) =>
  Effect.gen(function* () {
    for (const json of [false, true]) {
      const flag = json ? "--json" : "";
      for (const promptArgument of ["", "-", "'argument wins'"]) {
        const name = `Stdin Claude ${json} ${promptArgument.length}`;
        const piped = "piped prompt with 'quotes', $dollars and\nmultiple lines";
        const result = yield* machine.attempt(
          `printf '%s' ${quoteForShell(piped)} | ${NUDGE} new claude ${CLAUDE_MODEL_AND_EFFORT} ${flag} --name '${name}' ${promptArgument}`,
        );
        const id = json
          ? yield* startedIdOf(result.standardOutput)
          : (yield* machine.showJson(name)).target.id;
        assert.ok(id);
        assert.match(id, UUID);
        assert.deepEqual(result, {
          code: 0,
          standardError: "",
          standardOutput: json
            ? yield* jsonLine({
                action: "new",
                provider: "claude",
                target: { id, name, cwd: `${machine.home}/work` },
              })
            : `Started Claude session "${name}" (${id}) in ~/work.`,
        });
        const expected = promptArgument === "'argument wins'" ? "argument wins" : piped;
        yield* machine.transcriptHas({
          target: id,
          texts: [yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(expected)],
        });
        const transcript = yield* machine.transcriptLinesWith({
          target: id,
          text: expected.split("\n")[0] ?? "",
        });
        if (promptArgument === "'argument wins'") {
          assert.ok(!transcript.includes("piped prompt"));
        }
        yield* machine.nudge(`archive ${id}`);
      }
      assert.deepEqual(
        yield* machine.attempt(`printf 'prompt' | ${NUDGE} new claude ${flag} --name ' outer '`),
        {
          code: USAGE_EXIT_CODE,
          standardOutput: "",
          standardError: json
            ? yield* jsonLine({
                error: "NameHasOuterSpaces",
                message: 'the name " outer " starts or ends with a space',
                hint: null,
              })
            : 'error: the name " outer " starts or ends with a space',
        },
      );
      for (const { words, error, message } of WITH_A_TERMINAL_FOR_INPUT) {
        const terminal = yield* machine.attempt(`${BUN} -e '
let output = "";
const child = Bun.spawn([process.env.HOME + "/.bun/bin/nudge", ${words}${json ? ', "--json"' : ""}], {
  env: { ...process.env, NO_COLOR: "1" },
  terminal: { cols: 120, rows: 30, data(_terminal, data) { output += new TextDecoder().decode(data); } },
});
const code = await child.exited;
child.terminal.close();
process.stdout.write(output.replaceAll("\\r\\n", "\\n"));
process.exit(code);'`);
        assert.deepEqual(terminal, {
          code: USAGE_EXIT_CODE,
          standardError: "",
          standardOutput: json
            ? yield* jsonLine({ error, message, hint: null })
            : `error: ${message}`,
        });
      }
      for (const promptArgument of ["", "-", "'  '"]) {
        assert.deepEqual(
          yield* machine.attempt(`printf '' | ${NUDGE} new claude ${flag} ${promptArgument}`),
          {
            code: USAGE_EXIT_CODE,
            standardOutput: "",
            standardError: json
              ? yield* jsonLine({
                  error: "PromptEmpty",
                  message: "the prompt is empty",
                  hint: null,
                })
              : "error: the prompt is empty",
          },
        );
      }
    }
    const namedId = yield* machine.start("claude --name 'Flag Prompt Claude' -- '--version'");
    const namelessId = yield* machine.start("claude -- '--print'");
    yield* machine.waitUntilIdle(namedId, namelessId);
    yield* machine.transcriptHas({ target: namedId, texts: ['"content":"--version"'] });
    yield* machine.transcriptHas({ target: namelessId, texts: ['"content":"--print"'] });
    assert.equal((yield* machine.showJson(namelessId)).target.id, namelessId);
    yield* machine.nudge(`archive ${namedId}`);
    yield* machine.nudge(`archive ${namelessId}`);
  }),
);
