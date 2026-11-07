import assert from "node:assert/strict";

import { Effect } from "effect";

import { BUN } from "../../scripts/shared/codex-and-claude.ts";
import { machineTest } from "./machine-commands.ts";

const moveFirstPromptToTheEnd = (transcript: string) => `${BUN} -e '
const path = process.argv[1];
const lines = (await Bun.file(path).text()).trimEnd().split("\\n");
const typeOf = (line) => JSON.parse(line).type;
const start = lines.findIndex((line) => typeOf(line) === "user");
const length = lines.slice(start + 1).findIndex((line) => typeOf(line) !== "attachment") + 1;
const prompt = lines.splice(start, length);
const reordered = [...lines, JSON.stringify({ type: "last-prompt", lastPrompt: "hello from nudge" }), ...prompt];
await Bun.write(path, reordered.join("\\n") + "\\n");
console.log(typeOf(reordered.findLast((line) => ["system", "user", "assistant"].includes(typeOf(line)))));' ${transcript}`;

export const readingAClaudePromptWrittenLate = machineTest((machine) =>
  Effect.gen(function* () {
    const id = yield* machine.start("claude 'hello from nudge' --name 'Late Prompt Claude'");
    yield* machine.waitUntilIdle(id);
    const { transcript } = (yield* machine.showJson(id)).target;

    assert.equal(yield* machine.shell(moveFirstPromptToTheEnd(transcript)), "user");
    assert.equal((yield* machine.showJson(id)).target.status, "idle");
    yield* machine.nudge(`archive ${id}`);
  }),
);
