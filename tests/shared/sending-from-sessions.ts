import assert from "node:assert/strict";

import { Effect } from "effect";

import { CLAUDE_MODEL_AND_EFFORT, machineTest, MISSING_ID, NUDGE } from "./machine-commands.ts";
import { attributeOf, spansMentioning } from "./read-traces.ts";

const UNKNOWN_SENDER_WARNING =
  "warning: couldn't tell which session is sending, so the receiver can't reply with nudge";

export const sendingFromSessions = machineTest((machine) =>
  Effect.gen(function* () {
    const codexId = yield* machine.start("codex 'hello from nudge' --name 'Senders Codex'");
    const claudeId = yield* machine.start("claude 'hello from nudge' --name 'Senders Claude'");
    yield* machine.waitUntilIdle(codexId, claudeId);

    const runInCodex = (command: string) =>
      Effect.gen(function* () {
        yield* machine.nudge(`send ${codexId} 'RUN_COMMAND: ${command}'`);
        yield* machine.waitUntilIdle(codexId);
      });
    yield* runInCodex(`${machine.nudgePath} send ${claudeId} from-a-codex-task`);
    yield* machine.waitUntilIdle(claudeId);

    const spoofedCodex = yield* machine.attempt(
      `CODEX_THREAD_ID=${codexId} ${NUDGE} send ${claudeId} 'spoofed codex sender'`,
    );
    assert.deepEqual(spoofedCodex, {
      code: 0,
      standardOutput: `Sent the message to Claude session "Senders Claude" (${claudeId}).`,
      standardError: UNKNOWN_SENDER_WARNING,
    });
    yield* machine.waitUntilIdle(claudeId);
    const spoofedClaude = yield* machine.attempt(
      `CLAUDE_CODE_SESSION_ID=${claudeId} ${NUDGE} send ${codexId} 'spoofed claude sender'`,
    );
    assert.deepEqual(spoofedClaude, {
      code: 0,
      standardOutput: `Sent the message to Codex session "Senders Codex" (${codexId}).`,
      standardError: UNKNOWN_SENDER_WARNING,
    });
    yield* machine.waitUntilIdle(codexId);
    const unknownSender = yield* machine.attempt(
      `CLAUDE_CODE_SESSION_ID=${MISSING_ID} ${NUDGE} send ${codexId} 'from an unknown session'`,
    );
    assert.deepEqual(unknownSender, {
      code: 0,
      standardOutput: `Sent the message to Codex session "Senders Codex" (${codexId}).`,
      standardError: UNKNOWN_SENDER_WARNING,
    });
    yield* machine.waitUntilIdle(codexId);
    for (const spoofed of ["spoofed codex sender", "spoofed claude sender"]) {
      const target = spoofed.includes("codex") ? claudeId : codexId;
      assert.doesNotMatch(
        yield* machine.transcriptLinesWith({ target, text: spoofed }),
        /Message from (?:Codex session|Claude session)/u,
      );
    }

    const claudeSenderOutput = `${machine.scratch}/claude-sender.out`;
    const claudeSenderErrors = `${machine.scratch}/claude-sender.err`;
    const claudePrint = yield* machine.attempt(
      `claude -p 'RUN_COMMAND: ${NUDGE} send ${codexId} from-claude-p > ${claudeSenderOutput} 2> ${claudeSenderErrors}' --allowedTools Bash`,
    );
    assert.equal(claudePrint.code, 0, claudePrint.standardError);
    yield* machine.waitUntilIdle(codexId);
    assert.equal(yield* machine.shell(`cat ${claudeSenderErrors}`), "");
    assert.equal(
      yield* machine.shell(`cat ${claudeSenderOutput}`),
      `Sent the message to Codex session "Senders Codex" (${codexId}). Replies come to you as new messages.`,
    );
    assert.match(
      yield* machine.transcriptLinesWith({ target: codexId, text: "from-claude-p" }),
      /Message from Claude session \\"[^"\\]+\\" \([\da-f-]{36}\) via nudge CLI/u,
    );

    const codexInClaudeErrors = `${machine.scratch}/codex-in-claude.err`;
    yield* machine.shell(`cat > ${machine.scratch}/codex-in-claude.sh <<'EOF'
cd ~/work && ${machine.codexCli} exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox "RUN_COMMAND: ${NUDGE} send ${claudeId} from-codex-in-claude 2> ${codexInClaudeErrors}" < /dev/null > /dev/null 2>&1
EOF`);
    const codexInClaude = yield* machine.attempt(
      `claude -p 'RUN_COMMAND: bash ${machine.scratch}/codex-in-claude.sh' --allowedTools Bash`,
    );
    assert.equal(codexInClaude.code, 0, codexInClaude.standardError);
    yield* machine.waitUntilIdle(claudeId);
    assert.equal(yield* machine.shell(`cat ${codexInClaudeErrors}`), "");
    assert.match(
      yield* machine.transcriptLinesWith({ target: claudeId, text: "from-codex-in-claude" }),
      /Message from Codex session \\"[\da-f-]{36}\\" \([\da-f-]{36}\) via nudge CLI/u,
    );

    yield* runInCodex(
      `${machine.nudgePath} new claude ${CLAUDE_MODEL_AND_EFFORT} report-back-when-done --name Senders-Reporter`,
    );
    const reporterId = (yield* machine.showJson("Senders-Reporter")).target.id;
    yield* machine.waitUntilIdle(reporterId);
    yield* machine.transcriptHas({
      target: reporterId,
      texts: [
        String.raw`Message from Codex session \"Senders Codex\" (${codexId}) via nudge CLI.\nTo reply, run nudge send ${codexId} followed by your reply.\n\nreport-back-when-done`,
      ],
    });
    yield* machine.nudge("archive Senders-Reporter");

    yield* machine.transcriptHas({ target: codexId, texts: ["via nudge CLI"] });
    yield* machine.transcriptHas({
      target: claudeId,
      texts: [
        "from-a-codex-task",
        String.raw`Message from Codex session \"Senders Codex\" (${codexId}) via nudge CLI.\nTo reply, run nudge send ${codexId} followed by your reply.`,
      ],
    });

    assert.ok(
      (yield* spansMentioning({ machine, text: codexId })).some(
        (span) =>
          span.name === "nudge.send" &&
          attributeOf(span, "nudge.sender.provider") === "Codex" &&
          attributeOf(span, "nudge.sender.id") === codexId,
      ),
    );

    yield* machine.nudge("archive 'Senders Codex'");
    yield* machine.nudge("archive 'Senders Claude'");
  }),
);
