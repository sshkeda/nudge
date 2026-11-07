import assert from "node:assert/strict";

import { Effect } from "effect";

import { FAILED_EXIT_CODE, machineTest, NUDGE, rowsWithoutUpdated } from "./machine-commands.ts";
import { stoppedClaudeIsArchived } from "./renaming-and-archiving.ts";
import { CLAUDE_JOB_ID_LENGTH, stopClaudeProcesses } from "./resuming-a-killed-claude-session.ts";

const REAL_CLAUDE = '"$HOME/.local/bin/claude"';

const JOB_CHANGES = [
  {
    name: "Nudge Job Without State",
    slug: "without-state",
    change: (jobId: string) => `rm "$HOME/.claude/jobs/${jobId}/state.json"`,
    archived: ({
      id,
      name,
    }: {
      readonly id: string;
      readonly name: string;
      readonly jobId: string;
    }) => ({
      code: 0,
      standardOutput: stoppedClaudeIsArchived({ id, name }),
      standardError: "",
    }),
  },
  {
    name: "Nudge Job With Empty State",
    slug: "empty-state",
    change: (jobId: string) => `: > "$HOME/.claude/jobs/${jobId}/state.json"`,
    archived: ({
      jobId,
    }: {
      readonly id: string;
      readonly name: string;
      readonly jobId: string;
    }) => ({
      code: FAILED_EXIT_CODE,
      standardOutput: "",
      standardError: `error: can't read the state of Claude's background job ${jobId} in ~/.claude/jobs/${jobId}/state.json: Expected a valid JSON string`,
    }),
  },
] as const;

const recordingCalls = `#!/bin/sh
printf '%s\\n' "$*" >> "$(dirname "$0")/calls"
exec ${REAL_CLAUDE} "$@"`;

const byName = (left: readonly string[], right: readonly string[]) =>
  (left[0] ?? "").localeCompare(right[0] ?? "");

export const archivingAClaudeJobWithoutAProcess = machineTest((machine) =>
  Effect.gen(function* () {
    const jobs = yield* Effect.forEach(JOB_CHANGES, (job) =>
      Effect.map(machine.start(`claude 'hello from nudge' --name '${job.name}'`), (id) => ({
        ...job,
        id,
        jobId: id.slice(0, CLAUDE_JOB_ID_LENGTH),
      })),
    );
    yield* machine.waitUntilIdle(...jobs.map(({ id }) => id));
    yield* machine.shell(
      stopClaudeProcesses({
        sessionIds: jobs.map(({ id }) => id),
        waitForExit: machine.waitForExit,
      }),
    );
    yield* Effect.forEach(jobs, ({ change, jobId }) => machine.shell(change(jobId)), {
      discard: true,
    });
    assert.deepEqual(
      rowsWithoutUpdated(yield* machine.nudge("list --archived 'nudge job'")).toSorted(byName),
      jobs.map(({ name, id }) => [name, id, "Claude", "stopped", "work"]).toSorted(byName),
    );
    yield* Effect.forEach(
      jobs,
      ({ name, slug, id, jobId, archived }) =>
        Effect.gen(function* () {
          const recorded = `${machine.scratch}/archiving-${slug}`;
          yield* machine.shell(`mkdir -p ${recorded} && cat > ${recorded}/claude <<'WRAPPER'
${recordingCalls}
WRAPPER
chmod +x ${recorded}/claude && : > ${recorded}/calls`);
          assert.deepEqual(
            yield* machine.attempt(`PATH="${recorded}:$PATH" ${NUDGE} archive ${id}`),
            archived({ id, name, jobId }),
            name,
          );
          assert.equal(
            yield* machine.shell(`cat ${recorded}/calls`),
            "",
            `${name}: nudge archive ran claude for a session without a process`,
          );
        }),
      { discard: true },
    );
  }),
);
