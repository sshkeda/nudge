import assert from "node:assert/strict";

import { Effect } from "effect";

import {
  CLAUDE_MODEL_AND_EFFORT,
  FAILED_EXIT_CODE,
  machineTest,
  NUDGE,
} from "./machine-commands.ts";

const BROKEN_JOB_ID = "b40ken0b";

const FAKE_CLAUDE_WITH_A_BROKEN_JOB = `#!/bin/sh
case "$1" in
  --bg)
    if [ -n "$FAKE_JOB_STATE" ]; then
      mkdir -p "$CLAUDE_CONFIG_DIR/jobs/${BROKEN_JOB_ID}"
      printf '{"state":"%s","detail":"the launcher exited before Claude Code started"}' "$FAKE_JOB_STATE" > "$CLAUDE_CONFIG_DIR/jobs/${BROKEN_JOB_ID}/state.json"
      printf 'backgrounded \\302\\267 ${BROKEN_JOB_ID} \\302\\267 Nudge Broken\\n'
    fi ;;
  *) exec "$HOME/.local/bin/claude" "$@" ;;
esac`;

export const failingBrokenClaudeJobs = machineTest((machine) =>
  Effect.gen(function* () {
    const brokenClaude = `${machine.scratch}/broken-claude`;
    yield* machine.shell(`mkdir -p -m 700 ${brokenClaude} ${brokenClaude}/config ${brokenClaude}/config/sessions && cat > ${brokenClaude}/claude <<'FAKE'
${FAKE_CLAUDE_WITH_A_BROKEN_JOB}
FAKE
chmod +x ${brokenClaude}/claude`);
    const newBrokenSession = (state: string) =>
      machine.attempt(
        `FAKE_JOB_STATE=${state} PATH="${brokenClaude}:$PATH" CLAUDE_CONFIG_DIR="${brokenClaude}/config" ${NUDGE} new claude ${CLAUDE_MODEL_AND_EFFORT} 'never starts' --name 'Nudge Broken'`,
      );
    assert.deepEqual(yield* newBrokenSession(""), {
      code: FAILED_EXIT_CODE,
      standardOutput: "",
      standardError: "error: claude --bg printed no background job ID",
    });
    assert.deepEqual(yield* newBrokenSession("failed"), {
      code: FAILED_EXIT_CODE,
      standardOutput: "",
      standardError: `error: Claude's background job ${BROKEN_JOB_ID} is in the state "failed": the launcher exited before Claude Code started\nhint: claude logs ${BROKEN_JOB_ID}`,
    });
    assert.deepEqual(yield* newBrokenSession("levitating"), {
      code: FAILED_EXIT_CODE,
      standardOutput: "",
      standardError: `error: Claude's background job ${BROKEN_JOB_ID} is in the state "levitating", which nudge doesn't know\nhint: claude logs ${BROKEN_JOB_ID}`,
    });
  }),
);
