import assert from "node:assert/strict";

import { Effect } from "effect";

import { LONG_REPLY } from "../../scripts/shared/aimock.ts";
import { BUN } from "../../scripts/shared/codex-and-claude.ts";
import { columns } from "../../src/shared/columns.ts";
import { homePath } from "../../src/shared/report.ts";
import { decodeShownJson, machineTest, NUDGE } from "./machine-commands.ts";

const OLD_STATUS_WINDOW_BYTES = 262_144;

export const showingSessions = machineTest((machine) =>
  Effect.gen(function* () {
    const codexId = yield* machine.start(
      "codex 'hello from nudge' --name 'Showing Codex' --model gpt-5.5 --effort low",
    );
    const claudeId = yield* machine.start("claude 'hello from nudge' --name 'Showing Claude'");
    yield* machine.waitUntilIdle(codexId, claudeId);
    const mcpStatuses = yield* machine.shell(
      `grep -rhoE 'server=(codex_app|nudge) status=[a-z]+ threadId=${codexId}' ${machine.mcpLogs} | sort -u`,
    );
    const mcpFailures = yield* machine.shell(
      `grep -rh 'server=codex_app status=failed' ${machine.mcpLogs} | cut -c1-1500 | head -3`,
    );
    assert.match(mcpStatuses, /server=codex_app status=ready/u);
    assert.match(mcpStatuses, /server=nudge status=ready/u);
    assert.doesNotMatch(mcpStatuses, /status=failed/u, mcpFailures);

    const [
      codexShow = "",
      claudeShownJson = "",
      codexShownByLink = "",
      codexShownByLinkWithSlash = "",
      codexShownByLinkWithQuery = "",
      codexShownByPaddedId = "",
    ] = yield* machine.shells([
      `${NUDGE} show ${codexId}`,
      `${NUDGE} show --json ${claudeId}`,
      `${NUDGE} show codex://threads/${codexId}`,
      `${NUDGE} show codex://threads/${codexId}/`,
      `${NUDGE} show 'codex://threads/${codexId}?source=link#top'`,
      `${NUDGE} show '  ${codexId}  '`,
    ]);
    const codexShownJson = yield* machine.showJson(codexId);
    const codexShown = codexShownJson.target;
    const showPath = (value: string) =>
      homePath(value).show({ mode: "terminal", home: machine.home });
    assert.equal(
      codexShow,
      columns([
        ["Name:", "Showing Codex"],
        ["Provider:", "Codex"],
        ["ID:", codexId],
        ["Status:", "idle"],
        ["Model:", "gpt-5.5"],
        ["Effort:", "low"],
        ["Speed:", "Standard"],
        ["Project:", ""],
        ["Section:", ""],
        ["Updated:", codexShown.lastActiveAt],
        ["Directory:", showPath(codexShown.cwd)],
        ["Transcript:", showPath(codexShown.transcript)],
      ]),
    );
    assert.deepEqual(
      { model: codexShownJson.model, effort: codexShownJson.effort, speed: codexShownJson.speed },
      { model: "gpt-5.5", effort: "low", speed: "standard" },
    );
    const codexShownTranscript = codexShown.transcript;
    const claudeShown = yield* decodeShownJson(claudeShownJson);
    assert.equal(claudeShown.target.id, claudeId);
    assert.match(claudeShown.model ?? "", /opus/u, claudeShownJson);
    assert.deepEqual(
      { effort: claudeShown.effort, speed: claudeShown.speed },
      { effort: "medium", speed: "standard" },
    );
    assert.match(
      claudeShownJson,
      /^\{"action":"show","target":\{"provider":"claude","id":"[^"]+","name":"Showing Claude","status":"[a-z-]+","project":"[^"]*","section":"","cwd":"[^"]+","transcript":/u,
    );
    assert.ok(!("lastMessage" in claudeShown));
    assert.doesNotMatch(claudeShownJson, /"file":/u);
    yield* machine.filesHave([
      { file: codexShownTranscript, texts: ["Mocked reply."] },
      { file: claudeShown.target.transcript, texts: ["Mocked reply."] },
    ]);
    assert.equal(codexShownByLink, codexShow);
    assert.equal(codexShownByLinkWithSlash, codexShow);
    assert.equal(codexShownByLinkWithQuery, codexShow);
    assert.equal(codexShownByPaddedId, codexShow);

    yield* machine.nudge("archive 'Showing Codex'");
    yield* machine.nudge("archive 'Showing Claude'");
    const stoppedClaude = yield* machine.showJson("Showing Claude");
    assert.deepEqual(
      {
        id: stoppedClaude.target.id,
        status: stoppedClaude.target.status,
        cwd: stoppedClaude.target.cwd,
        transcript: stoppedClaude.target.transcript,
      },
      {
        id: claudeId,
        status: "stopped",
        cwd: claudeShown.target.cwd,
        transcript: claudeShown.target.transcript,
      },
    );

    const longReplyId = yield* machine.start(`claude '${LONG_REPLY}' --name 'Showing Long Reply'`);
    yield* machine.waitUntilIdle(longReplyId);
    const longReply = (yield* machine.showJson(longReplyId)).target;
    const lastReplyBytes = yield* machine.shell(`${BUN} -e '
const lines = (await Bun.file(process.argv[1]).text()).trimEnd().split("\\n");
const reply = lines.findLast((line) => JSON.parse(line).type === "assistant");
console.log(Buffer.byteLength(reply));' ${longReply.transcript}`);
    assert.ok(Number(lastReplyBytes) > OLD_STATUS_WINDOW_BYTES, lastReplyBytes);
    assert.equal(longReply.status, "idle");
  }),
);
