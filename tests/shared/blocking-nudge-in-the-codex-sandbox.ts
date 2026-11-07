import assert from "node:assert/strict";

import { Effect } from "effect";

import { machineTest } from "./machine-commands.ts";
import { ALL_TRACES, spansIn } from "./read-traces.ts";

export const blockingNudgeInTheCodexSandbox = machineTest((machine) =>
  Effect.gen(function* () {
    const claudeId = yield* machine.start("claude 'hello from nudge' --name 'Sandbox Claude'");
    const documentsId = yield* machine.start(
      "codex 'run commands here' --name 'Sandbox Documents'",
    );
    yield* machine.waitUntilIdle(documentsId, claudeId);
    const documents = yield* machine.showJson(documentsId);
    assert.ok(documents.target.cwd.startsWith(`${machine.home}/Documents/Codex/`));
    const countListSpans = Effect.map(
      Effect.flatMap(machine.shell(ALL_TRACES), spansIn),
      (spans) => spans.filter((span) => span.name === "nudge.list").length,
    );
    const listSpansBeforeSandbox = yield* countListSpans;
    const sandboxProbe = `${machine.home}/.local/state/nudge/sandbox-probe`;
    const runInDocuments = (command: string) =>
      Effect.gen(function* () {
        const callsBefore = yield* machine.shell(
          `grep -c '"type":"function_call_output"' '${documents.target.transcript}' || true`,
        );
        yield* machine.nudge(`send ${documentsId} 'RUN_COMMAND: ${command}'`);
        yield* machine.waitUntilIdle(documentsId);
        return yield* machine.shell(
          `grep '"type":"function_call_output"' '${documents.target.transcript}' | tail -n +${Number(callsBefore) + 1}`,
        );
      });
    const sandboxed = yield* runInDocuments(`touch ${sandboxProbe}; ${machine.nudgePath} list`);
    assert.match(
      sandboxed,
      /sandbox-probe'?: (?:Operation not permitted|Read-only file system)/u,
      `the Codex sandbox didn't deny writing the state directory: ${sandboxed}`,
    );
    yield* machine.shell(`test ! -e ${sandboxProbe}`);
    assert.match(sandboxed, /Process exited with code 1/u);
    assert.match(
      sandboxed,
      /error: Codex's sandbox blocks nudge from reaching Codex at ~\/\.local\/state\/nudge\/codex\/codex\.sock, so run this nudge command outside the sandbox\\nhint: nudge list(?:\\n|")/u,
    );
    assert.doesNotMatch(sandboxed, /warning/u);
    const allowed = yield* runInDocuments(`${machine.nudgePath} list`);
    assert.match(allowed, /Process exited with code 0/u);
    assert.match(allowed, /Sandbox Documents/u);
    assert.match(allowed, /Sandbox Claude/u);
    assert.doesNotMatch(allowed, /warning/u);
    assert.equal(yield* countListSpans, listSpansBeforeSandbox + 1);
    yield* machine.nudge("archive 'Sandbox Documents'");
    yield* machine.nudge("archive 'Sandbox Claude'");
  }),
);
