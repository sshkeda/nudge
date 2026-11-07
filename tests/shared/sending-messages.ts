import assert from "node:assert/strict";

import { Effect } from "effect";

import { BUN } from "../../scripts/shared/codex-and-claude.ts";
import {
  CLAUDE_MODEL_AND_EFFORT,
  decodeSent,
  FAILED_EXIT_CODE,
  jsonLine,
  machineTest,
  MISSING_ID,
  NUDGE,
  startedIdOf,
  USAGE_EXIT_CODE,
  UUID,
} from "./machine-commands.ts";
import { attributeOf, spansMentioning } from "./read-traces.ts";

const LARGE_CLAUDE_MESSAGE_BYTES = 200_000;

const CLAUDE_JOB_ID_LENGTH = 8;

const LARGE_CODEX_MESSAGE_EUROS = 90_000;

const JUST_UNDER_CLAUDE_LIMIT = 1_040_000;

const JUST_OVER_CLAUDE_LIMIT = 1_050_000;

const MOD_THAT_TAKES_MESSAGES = {
  ".claude-plugin/plugin.json": `{ "name": "take-messages", "version": "0.1.0", "description": "Takes messages from other sessions" }`,
  "hooks/hooks.json": `{ "modules": ["./register.ts"] }`,
  "hooks/register.ts": `import type { Register } from "claude-code";

export const register: Register = (on) => {
  on("session.receive", ($, e, next) =>
    e.origin.kind === "peer" ? { consumed: "this mod takes messages from other sessions" } : next(e),
  );
};`,
} as const;

export const sendingMessages = machineTest((machine) =>
  Effect.gen(function* () {
    const codexId = yield* machine.start("codex 'hello from nudge' --name 'Sending Codex'");
    const claudeId = yield* machine.start("claude 'hello from nudge' --name 'Sending Claude'");
    yield* machine.waitUntilIdle(codexId, claudeId);

    assert.equal(
      yield* machine.nudge(`send ${codexId} 'ping codex' --effort high`),
      `Sent the message to Codex session "Sending Codex" (${codexId}).`,
    );
    yield* machine.waitUntilIdle(codexId);
    yield* machine.shell(String.raw`printf 'from a file\n' > ${machine.scratch}/message.txt`);
    const claudeSent = yield* decodeSent(
      yield* machine.nudge(`send ${claudeId} --json - < ${machine.scratch}/message.txt`),
    );
    assert.match(claudeSent.messageId, UUID);
    assert.deepEqual(claudeSent, {
      action: "send",
      provider: "claude",
      status: "delivered",
      target: { id: claudeId, name: "Sending Claude" },
      messageId: claudeSent.messageId,
    });
    const codexSent = yield* decodeSent(
      yield* machine.nudge(`send --json ${codexId} 'flag first'`),
    );
    assert.match(codexSent.messageId, UUID);
    assert.deepEqual(codexSent, {
      action: "send",
      provider: "codex",
      status: "delivered",
      delivery: "native",
      target: { id: codexId, name: "Sending Codex" },
      messageId: codexSent.messageId,
    });
    yield* machine.waitUntilIdle(claudeId, codexId);

    const toMissing = yield* machine.attempt(`${NUDGE} send --json 'No Such Session' 'to nobody'`);
    assert.deepEqual(toMissing, {
      code: FAILED_EXIT_CODE,
      standardOutput: "",
      standardError: yield* jsonLine({
        error: "SessionNotFound",
        message: `no session matches "No Such Session"`,
        hint: "nudge list",
      }),
    });
    assert.deepEqual(yield* machine.attempt(`${NUDGE} send ${MISSING_ID} 'to nobody'`), {
      code: FAILED_EXIT_CODE,
      standardOutput: "",
      standardError: `error: no session matches "${MISSING_ID}"\nhint: nudge list`,
    });
    assert.deepEqual(
      yield* machine.attempt(`echo 'piped to Codex' | ${NUDGE} send 'Sending Codex'`),
      {
        code: 0,
        standardOutput: `Sent the message to Codex session "Sending Codex" (${codexId}).`,
        standardError: "",
      },
    );
    yield* machine.waitUntilIdle(claudeId, codexId);
    assert.deepEqual(
      yield* machine.attempt(`${NUDGE} send ${claudeId} 'faster please' --speed fast`),
      {
        code: FAILED_EXIT_CODE,
        standardOutput: "",
        standardError: `error: Claude session "Sending Claude" (${claudeId}) can't change its speed while it runs`,
      },
    );
    assert.deepEqual(
      yield* machine.attempt(`${NUDGE} send ${claudeId} 'standard please' --speed standard`),
      {
        code: FAILED_EXIT_CODE,
        standardOutput: "",
        standardError: `error: Claude session "Sending Claude" (${claudeId}) can't change its speed while it runs`,
      },
    );
    const { transcript: claudeTranscript } = (yield* machine.showJson(claudeId)).target;
    assert.doesNotMatch(
      yield* machine.shell(`cat '${claudeTranscript}'`),
      /faster please|standard please/u,
    );
    assert.deepEqual(yield* machine.attempt(`${NUDGE} send ${claudeId} 'new model' --model x`), {
      code: FAILED_EXIT_CODE,
      standardOutput: "",
      standardError: `error: Claude session "Sending Claude" (${claudeId}) can't change its model or effort while it runs`,
    });

    const flagLike = yield* machine.attempt(`${NUDGE} send ${claudeId} -hello`);
    assert.deepEqual(flagLike, {
      code: USAGE_EXIT_CODE,
      standardOutput: "",
      standardError: `error: "-hello" looks like a flag, but nudge send has no flag "-e"\nhint: nudge send ${claudeId} -- -hello`,
    });
    assert.deepEqual(yield* machine.attempt(`${NUDGE} send ${claudeId} -hello --json`), {
      code: USAGE_EXIT_CODE,
      standardOutput: "",
      standardError: yield* jsonLine({
        error: "UnknownFlag",
        message: `"-hello" looks like a flag, but nudge send has no flag "-e"`,
        hint: `nudge send ${claudeId} --json -- -hello`,
      }),
    });
    assert.deepEqual(yield* machine.runHints(flagLike.standardError), [
      {
        code: 0,
        standardOutput: `Sent the message to Claude session "Sending Claude" (${claudeId}).`,
        standardError: "",
      },
    ]);
    const flagLikeWords = yield* machine.attempt(`${NUDGE} send ${claudeId} --hello there`);
    assert.deepEqual(flagLikeWords, {
      code: USAGE_EXIT_CODE,
      standardOutput: "",
      standardError: `error: "--hello" looks like a flag, but nudge send has no such flag\nhint: nudge send --help`,
    });
    const [flagLikeWordsHint] = yield* machine.runHints(flagLikeWords.standardError);
    assert.ok(flagLikeWordsHint);
    assert.equal(flagLikeWordsHint.code, 0, flagLikeWordsHint.standardError);
    yield* machine.waitUntilIdle(claudeId);
    const [claudeLogs] = yield* machine.runHints(
      `hint: claude logs ${claudeId.slice(0, CLAUDE_JOB_ID_LENGTH)}`,
    );
    assert.ok(claudeLogs);
    assert.equal(claudeLogs.code, 0, claudeLogs.standardError);

    yield* machine.shell(`echo 'piped in' | ${NUDGE} send ${codexId}`);
    yield* machine.shell(`${NUDGE} send 'Sending Codex' - <<'EOF'
heredoc with dash
EOF`);
    yield* machine.waitUntilIdle(codexId);
    yield* machine.shell(`${NUDGE} send 'Sending Claude' <<'EOF'
heredoc without dash
EOF`);
    yield* machine.waitUntilIdle(claudeId);
    yield* machine.shell(
      `printf 'from cat' > ${machine.scratch}/cat.txt && ${NUDGE} send ${claudeId} "$(cat ${machine.scratch}/cat.txt)"`,
    );
    yield* machine.waitUntilIdle(claudeId);
    yield* machine.nudge(`send codex://threads/${codexId} 'via codex link'`);
    yield* machine.waitUntilIdle(codexId);

    yield* machine.nudge(`send ${codexId} 'compare a <b> & c'`);
    yield* machine.waitUntilIdle(codexId);
    yield* machine.transcriptHas({ target: codexId, texts: ["compare a &lt;b&gt; &amp; c"] });

    yield* machine.transcriptHas({
      target: codexId,
      texts: [
        "ping codex",
        "flag first",
        "piped to Codex",
        "piped in",
        "heredoc with dash",
        "via codex link",
      ],
    });
    yield* machine.transcriptHas({
      target: claudeId,
      texts: ["from a file", "heredoc without dash", "from cat"],
    });

    const closingTag = "quote </cross-session-message> in the text";
    assert.equal(
      yield* machine.nudge(`send ${claudeId} '${closingTag}'`),
      `Sent the message to Claude session "Sending Claude" (${claudeId}).`,
    );
    yield* machine.waitUntilIdle(claudeId);
    for (const target of [claudeId, codexId, claudeId, codexId]) {
      yield* machine.nudge(`send ${target} 'the same text twice'`);
      yield* machine.waitUntilIdle(target);
    }
    const largeForClaude = `${machine.scratch}/large-for-claude.txt`;
    const largeForCodex = `${machine.scratch}/large-for-codex.txt`;
    yield* machine.shell(
      `${BUN} -e 'await Bun.write(process.argv[1], "large for claude " + "x".repeat(${LARGE_CLAUDE_MESSAGE_BYTES})); await Bun.write(process.argv[2], "large for codex " + "\u20AC".repeat(${LARGE_CODEX_MESSAGE_EUROS}))' ${largeForClaude} ${largeForCodex}`,
    );
    yield* machine.nudge(`send ${claudeId} - < ${largeForClaude}`);
    yield* machine.nudge(`send ${codexId} - < ${largeForCodex}`);
    yield* machine.waitUntilIdle(claudeId, codexId);
    yield* machine.transcriptHas({ target: claudeId, texts: ["large for claude xxx"] });
    yield* machine.transcriptHas({
      target: codexId,
      texts: ["large for codex \u20AC\u20AC\u20AC"],
    });
    const underLimit = `${machine.scratch}/under-claude-limit.txt`;
    const overLimit = `${machine.scratch}/over-claude-limit.txt`;
    yield* machine.shell(
      `${BUN} -e 'await Bun.write(process.argv[1], "under the limit " + "x".repeat(${JUST_UNDER_CLAUDE_LIMIT})); await Bun.write(process.argv[2], "over the limit " + "x".repeat(${JUST_OVER_CLAUDE_LIMIT}))' ${underLimit} ${overLimit}`,
    );
    yield* machine.nudge(`send ${claudeId} - < ${underLimit}`);
    yield* machine.waitUntilIdle(claudeId);
    yield* machine.transcriptHas({ target: claudeId, texts: ["under the limit xxx"] });
    const overClaudeLimit = yield* machine.attempt(`${NUDGE} send ${claudeId} - < ${overLimit}`);
    assert.equal(overClaudeLimit.code, FAILED_EXIT_CODE, overClaudeLimit.standardError);
    assert.equal(overClaudeLimit.standardOutput, "");
    assert.match(
      overClaudeLimit.standardError,
      new RegExp(
        String.raw`^error: the message to Claude session "Sending Claude" \(${claudeId}\) takes \d+ characters once encoded, more than the 1048576 characters Claude accepts$`,
        "u",
      ),
    );

    const mod = `${machine.scratch}/take-messages`;
    yield* Effect.forEach(Object.entries(MOD_THAT_TAKES_MESSAGES), ([file, text]) =>
      machine.shell(
        `mkdir -p "$(dirname ${mod}/${file})" && cat > ${mod}/${file} <<'MOD'\n${text}\nMOD`,
      ),
    );
    const hookedId = yield* machine
      .shell(
        `CLAUDE_CODE_PLUGIN_DIRS=${mod} ${NUDGE} new --json claude ${CLAUDE_MODEL_AND_EFFORT} 'hello from nudge' --name 'Hooked Claude'`,
      )
      .pipe(Effect.flatMap(startedIdOf));
    yield* machine.waitUntilIdle(hookedId);
    assert.deepEqual(yield* machine.attempt(`${NUDGE} send 'Hooked Claude' 'taken by the mod'`), {
      code: FAILED_EXIT_CODE,
      standardOutput: "",
      standardError: `error: Claude session "Hooked Claude" (${hookedId}) didn't queue the message within 30 seconds, so nudge can't tell whether it will arrive`,
    });
    const { transcript } = (yield* machine.showJson(hookedId)).target;
    assert.equal(yield* machine.shell(`grep -c -F 'taken by the mod' ${transcript} || true`), "0");

    const spanFor = ({ name, messageId }: { readonly name: string; readonly messageId: string }) =>
      Effect.map(spansMentioning({ machine, text: messageId }), (spans) =>
        spans.find(
          (span) => span.name === name && attributeOf(span, "nudge.message.id") === messageId,
        ),
      );
    assert.ok(yield* spanFor({ name: "codex.send", messageId: codexSent.messageId }));
    assert.ok(yield* spanFor({ name: "claude.send", messageId: claudeSent.messageId }));
    const delivered = yield* spanFor({ name: "nudge.deliver", messageId: claudeSent.messageId });
    assert.equal(delivered && attributeOf(delivered, "nudge.status"), "delivered");

    yield* machine.nudge("archive 'Sending Codex'");
    yield* machine.nudge("archive 'Sending Claude'");
    yield* machine.nudge("archive 'Hooked Claude'");
  }),
);
