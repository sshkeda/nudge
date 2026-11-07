import assert from "node:assert/strict";

import { Effect } from "effect";

import { BUN, DIST } from "../../scripts/shared/codex-and-claude.ts";
import { decodeShownJson, machineTest, quoteForShell, rows } from "./machine-commands.ts";

const CODEX_SESSION_ID = /^session id: (?<id>[\da-f-]{36})$/mu;

const GUARDIAN_SOURCE = '{"subagent":{"other":"guardian"}}';

const CODEX_DATABASE = "$(ls ~/.codex/state_*.sqlite | sort -V | tail -n 1)";

const findGuardianReview = `${BUN} -e '
import { Database } from "bun:sqlite";
const [database, source] = process.argv.slice(1);
const opened = new Database(database, { readonly: true });
console.log(opened.query("SELECT id FROM threads WHERE source = ?").get(source)?.id ?? "");' ${CODEX_DATABASE} ${quoteForShell(GUARDIAN_SOURCE)}`;

const nameAfterTitle = (id: string) => `${BUN} -e '
import { Database } from "bun:sqlite";
const [database, id] = process.argv.slice(1);
const opened = new Database(database);
opened.run("PRAGMA busy_timeout = 10000");
opened.run("UPDATE threads SET name = title WHERE id = ?", [id]);' ${CODEX_DATABASE} ${id}`;

export const runningCodexWithNudge = machineTest((machine) =>
  Effect.gen(function* () {
    const codexRunOutput = yield* machine.shell(
      `${machine.codexCli} exec --skip-git-repo-check 'hello from codex exec' < /dev/null 2>&1`,
    );
    assert.doesNotMatch(codexRunOutput, /codex_app|failed to start/u);
    const namelessId = CODEX_SESSION_ID.exec(codexRunOutput)?.groups?.["id"] ?? "";
    assert.notEqual(namelessId, "", codexRunOutput);
    const nameless = yield* decodeShownJson(yield* machine.nudge(`show --json ${namelessId}`));
    assert.equal(nameless.target.id, namelessId);
    assert.ok(
      !rows(yield* machine.nudge("list --all")).some((row) => row[1] === namelessId),
      "nudge list shows a codex exec thread",
    );
    yield* machine.shell(nameAfterTitle(namelessId));
    assert.ok(
      !rows(yield* machine.nudge("list --all")).some((row) => row[1] === namelessId),
      "nudge list shows a codex exec thread that older Codex named after its first message",
    );
    assert.equal(
      (yield* decodeShownJson(yield* machine.nudge(`show --json ${namelessId}`))).target.name,
      "hello from codex exec",
    );

    const reviewedRun = yield* machine.shell(
      `${machine.codexCli} exec --skip-git-repo-check -s read-only -c approval_policy='"on-request"' -c approvals_reviewer='"auto_review"' 'RUN_OUTSIDE_SANDBOX: true' < /dev/null 2>&1`,
    );
    const guardianId = yield* machine.shell(findGuardianReview);
    assert.notEqual(guardianId, "", `Codex ran no Guardian review: ${reviewedRun}`);
    assert.ok(
      !rows(yield* machine.nudge("list --all")).some((row) => row[1] === guardianId),
      "nudge list shows a Codex Guardian review",
    );
    const guardian = yield* decodeShownJson(yield* machine.nudge(`show --json ${guardianId}`));
    assert.deepEqual([guardian.target.id, guardian.target.name], [guardianId, "Guardian review"]);
    assert.equal(
      yield* machine.shell(
        `printf '%s\\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | ${machine.codexNode} ${DIST}nudge-codex-desktop-helper.mjs`,
      ),
      '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}',
    );
    assert.equal(
      yield* machine.shell(`grep -rhoE 'enableUpdater=[a-z]+' ${machine.codexLogs} | sort -u`),
      "enableUpdater=false",
    );
    const doctor = yield* machine.nudge("doctor");
    assert.ok(
      doctor.split("\n").every((line) => line.startsWith("ok: ")),
      doctor,
    );
  }),
);
