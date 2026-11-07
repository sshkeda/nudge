import assert from "node:assert/strict";

import { Effect, Schema } from "effect";

import { BUN } from "../../scripts/shared/codex-and-claude.ts";
import { columns } from "../../src/shared/columns.ts";
import { homePath } from "../../src/shared/report.ts";
import {
  FAILED_EXIT_CODE,
  jsonLine,
  machineTest,
  NUDGE,
  rowsWithoutUpdated,
  sortedNames,
  USAGE_EXIT_CODE,
  WITHOUT_CLAUDE,
} from "./machine-commands.ts";

export const printModeSessionIdOf = ({
  pid,
  waitForExit,
}: {
  readonly pid: number;
  readonly waitForExit: (pids: string) => string;
}) => `${BUN} -e '
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, watch } from "node:fs";
import { dirname } from "node:path";
const [pid, waitForExit] = process.argv.slice(1);
const session = process.env.HOME + "/.claude/sessions/" + pid + ".json";
let reported = false;
const exited = spawn("sh", ["-c", waitForExit, "sh", pid], { stdio: "ignore" });
const watcher = watch(dirname(session), () => report());
const report = () => {
  if (reported || !existsSync(session) || statSync(session).size === 0) return;
  reported = true;
  exited.kill();
  watcher.close();
  console.log(JSON.parse(readFileSync(session, "utf8")).sessionId);
};
exited.on("exit", () => {
  if (reported) return;
  console.error("claude -p (process " + pid + ") exited before it wrote " + session);
  process.exit(1);
});
report();' ${pid} '${waitForExit('"$1"')}'`;

const AMBIGUOUS_LAST_ARGUMENTS: ReadonlyMap<string, string> = new Map([
  ["rename", " 'Never Used'"],
  ["send", " 'Never Sent'"],
]);

const DESKTOP_ACCOUNT = "desktop-account";

const desktopSession = ({
  title,
  lastActivityAt,
  isArchived = true,
}: {
  readonly title: string;
  readonly lastActivityAt: string;
  readonly isArchived?: boolean;
}) =>
  `{"sessionId":"local_${title.toLowerCase().replaceAll(" ", "-")}","isArchived":${isArchived},"title":"${title}","lastActivityAt":${lastActivityAt}}`;

export const stoppedClaudeIsArchived = ({
  id,
  name,
}: {
  readonly id: string;
  readonly name: string;
}) => `Claude session "${name}" (${id}) is already archived.`;

const appClaudeCannotBeArchived = ({ id, name }: { readonly id: string; readonly name: string }) =>
  `nudge can't archive Claude session "${name}" (${id}), because the Claude app owns it. Archive it in the Claude app.`;

const decodeAmbiguous = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      error: Schema.String,
      message: Schema.String,
      hint: Schema.NullOr(Schema.String),
      candidates: Schema.Array(
        Schema.Struct({ provider: Schema.String, id: Schema.String, name: Schema.String }),
      ),
    }),
  ),
);

export const renamingAndArchiving = machineTest((machine) =>
  Effect.gen(function* () {
    const codexId = yield* machine.start("codex 'hello from nudge' --name 'Archiving Codex'");
    const claudeId = yield* machine.start("claude 'hello from nudge' --name 'Archiving Claude'");
    yield* machine.waitUntilIdle(codexId, claudeId);
    const listed = machine.nudge("list archiving");

    assert.deepEqual(
      yield* machine.shells([
        `${NUDGE} rename codex://threads/${codexId} 'Archiving Codex Renamed'`,
        `${NUDGE} rename --json ${claudeId} 'Archiving Claude Renamed'`,
      ]),
      [
        `Renamed Codex session "Archiving Codex" (${codexId}) to "Archiving Codex Renamed".`,
        yield* jsonLine({
          action: "rename",
          provider: "claude",
          status: "renamed",
          target: { id: claudeId, name: "Archiving Claude" },
          name: "Archiving Claude Renamed",
        }),
      ],
    );
    assert.deepEqual(sortedNames(yield* listed), [
      "Archiving Claude Renamed",
      "Archiving Codex Renamed",
    ]);
    assert.deepEqual(
      yield* machine.shells([
        `${NUDGE} rename ${claudeId} 'Archiving Claude Renamed'`,
        `${NUDGE} rename --json ${codexId} 'Archiving Codex Renamed'`,
      ]),
      [
        `Claude session "Archiving Claude Renamed" (${claudeId}) already has that name.`,
        yield* jsonLine({
          action: "rename",
          provider: "codex",
          status: "unchanged",
          target: { id: codexId, name: "Archiving Codex Renamed" },
          name: "Archiving Codex Renamed",
        }),
      ],
    );
    assert.deepEqual(yield* machine.attempt(`${NUDGE} rename ${claudeId} '   '`), {
      code: USAGE_EXIT_CODE,
      standardOutput: "",
      standardError: "error: the name is empty",
    });
    const padded = yield* machine.attempt(
      `${NUDGE} rename ${claudeId} ' Archiving Claude Padded '`,
    );
    assert.deepEqual(padded, {
      code: USAGE_EXIT_CODE,
      standardOutput: "",
      standardError: `error: the name " Archiving Claude Padded " starts or ends with a space\nhint: nudge rename ${claudeId} 'Archiving Claude Padded'`,
    });
    assert.deepEqual(yield* machine.runHints(padded.standardError), [
      {
        code: 0,
        standardOutput: `Renamed Claude session "Archiving Claude Renamed" (${claudeId}) to "Archiving Claude Padded".`,
        standardError: "",
      },
    ]);
    yield* machine.nudge(`rename ${claudeId} 'Archiving Codex Renamed'`);
    const candidates = [
      { provider: "Claude", id: claudeId, name: "Archiving Codex Renamed" },
      { provider: "Codex", id: codexId, name: "Archiving Codex Renamed" },
    ];
    const ambiguousMessage = '2 sessions are named "Archiving Codex Renamed"';
    const candidateTable = (ordered: typeof candidates) =>
      columns([
        ["NAME", "PROVIDER", "ID"],
        ...ordered.map(({ provider, id, name }) => [name, provider, id]),
      ]);
    for (const command of ["show", "rename", "archive", "send"]) {
      const lastArgument = AMBIGUOUS_LAST_ARGUMENTS.get(command) ?? "";
      const ambiguous = yield* machine.attempt(
        `${NUDGE} ${command} 'Archiving Codex Renamed'${lastArgument}`,
      );
      assert.equal(ambiguous.code, FAILED_EXIT_CODE);
      assert.equal(ambiguous.standardOutput, "");
      assert.ok(
        [candidates, candidates.toReversed()].some(
          (ordered) =>
            ambiguous.standardError === `error: ${ambiguousMessage}\n\n${candidateTable(ordered)}`,
        ),
        ambiguous.standardError,
      );
    }
    const ambiguousJson = yield* machine.attempt(`${NUDGE} show --json 'Archiving Codex Renamed'`);
    assert.equal(ambiguousJson.code, FAILED_EXIT_CODE);
    assert.equal(ambiguousJson.standardOutput, "");
    const decodedAmbiguous = yield* decodeAmbiguous(ambiguousJson.standardError);
    assert.deepEqual(
      {
        ...decodedAmbiguous,
        candidates: decodedAmbiguous.candidates.toSorted((left, right) =>
          left.provider.localeCompare(right.provider),
        ),
      },
      {
        error: "SessionNameAmbiguous",
        message: ambiguousMessage,
        hint: null,
        candidates: candidates.map(({ provider, id, name }) => ({
          provider: provider.toLowerCase(),
          id,
          name,
        })),
      },
    );
    yield* machine.nudge(`rename ${claudeId} 'Archiving Claude Renamed'`);

    const beforeArchive = yield* machine.showJson(claudeId);
    assert.deepEqual(
      yield* machine.shells([
        `${NUDGE} archive codex://threads/${codexId}`,
        `${NUDGE} archive --json 'Archiving Claude Renamed'`,
      ]),
      [
        `Archived Codex session "Archiving Codex Renamed" (${codexId}).`,
        yield* jsonLine({
          action: "archive",
          provider: "claude",
          status: "archived",
          target: { id: claudeId, name: "Archiving Claude Renamed" },
        }),
      ],
    );
    const afterArchive = yield* machine.showJson(claudeId);
    assert.ok(
      Date.parse(afterArchive.target.lastActiveAt) >= Date.parse(beforeArchive.target.lastActiveAt),
    );
    assert.deepEqual(
      {
        name: afterArchive.target.name,
        status: afterArchive.target.status,
        cwd: afterArchive.target.cwd,
      },
      {
        name: "Archiving Claude Renamed",
        status: "stopped",
        cwd: beforeArchive.target.cwd,
      },
    );
    assert.equal(
      yield* machine.nudge("archive --json 'Archiving Codex Renamed'"),
      yield* jsonLine({
        action: "archive",
        provider: "codex",
        status: "unchanged",
        target: { id: codexId, name: "Archiving Codex Renamed" },
      }),
    );
    assert.deepEqual(yield* machine.attempt(`${NUDGE} archive 'Archiving Claude Renamed'`), {
      code: 0,
      standardOutput: stoppedClaudeIsArchived({ id: claudeId, name: "Archiving Claude Renamed" }),
      standardError: "",
    });
    const stoppedRows = [["Archiving Claude Renamed", claudeId, "Claude", "stopped", "work"]];
    const listedArchived = machine.nudge("list --archived 'archiving claude'");
    assert.equal(
      yield* listed,
      `No matches for "archiving".\nhint: nudge list --archived archiving`,
    );
    assert.deepEqual(rowsWithoutUpdated(yield* listedArchived), stoppedRows);
    assert.deepEqual(sortedNames(yield* machine.nudge("list --archived renamed")), [
      "Archiving Claude Renamed",
      "Archiving Codex Renamed",
    ]);
    const archivedTarget = yield* machine.attempt(`${NUDGE} send 'Archiving Codex Renamed' hello`);
    assert.deepEqual(archivedTarget, {
      code: FAILED_EXIT_CODE,
      standardOutput: "",
      standardError: `error: "Archiving Codex Renamed" is archived\nhint: nudge unarchive ${codexId}`,
    });
    assert.equal((yield* machine.showJson("Archiving Codex Renamed")).target.status, "archived");

    assert.deepEqual(yield* machine.runHints(archivedTarget.standardError), [
      {
        code: 0,
        standardOutput: `Unarchived Codex session "Archiving Codex Renamed" (${codexId}).`,
        standardError: "",
      },
    ]);
    assert.deepEqual(
      yield* machine.attempt(`${WITHOUT_CLAUDE} ${NUDGE} unarchive 'Archiving Claude Renamed'`),
      {
        code: FAILED_EXIT_CODE,
        standardOutput: "",
        standardError: `error: nudge can't resume Claude session "Archiving Claude Renamed" (${claudeId}), because it can't find claude on your PATH`,
      },
    );
    assert.equal(
      yield* machine.nudge(`unarchive --json 'Archiving Claude Renamed'`),
      yield* jsonLine({
        action: "unarchive",
        provider: "claude",
        status: "unarchived",
        target: { id: claudeId, name: "Archiving Claude Renamed" },
      }),
    );
    assert.deepEqual(
      yield* machine.shells([
        `${NUDGE} unarchive codex://threads/${codexId}`,
        `${NUDGE} unarchive --json 'Archiving Claude Renamed'`,
      ]),
      [
        `Codex session "Archiving Codex Renamed" (${codexId}) isn't archived.`,
        yield* jsonLine({
          action: "unarchive",
          provider: "claude",
          status: "unchanged",
          target: { id: claudeId, name: "Archiving Claude Renamed" },
        }),
      ],
    );
    assert.deepEqual(sortedNames(yield* listed), [
      "Archiving Claude Renamed",
      "Archiving Codex Renamed",
    ]);

    yield* machine.nudge("archive 'Archiving Codex Renamed'");
    yield* machine.nudge("archive 'Archiving Claude Renamed'");
    assert.deepEqual(rowsWithoutUpdated(yield* listedArchived), stoppedRows);

    const { printSessionId, printShow, printRename } = yield* Effect.scoped(
      Effect.gen(function* () {
        yield* machine.shell(`mkfifo ${machine.scratch}/print-input`);
        const printMode = yield* machine.startInThisScope(
          `exec claude -p --input-format stream-json --output-format stream-json --verbose 0<> ${machine.scratch}/print-input > /dev/null 2>&1`,
        );
        const sessionId = yield* machine.shell(
          printModeSessionIdOf({ pid: printMode.pid, waitForExit: machine.waitForExit }),
        );
        return {
          printSessionId: sessionId,
          printShow: yield* machine.attempt(`${NUDGE} show ${sessionId}`),
          printRename: yield* machine.attempt(`${NUDGE} rename ${sessionId} 'Never Renamed'`),
        };
      }),
    );
    for (const hidden of [printShow, printRename]) {
      assert.deepEqual(hidden, {
        code: FAILED_EXIT_CODE,
        standardOutput: "",
        standardError: `error: no session matches "${printSessionId}"\nhint: nudge list`,
      });
    }

    const desktop = `${machine.scratch}/claude-desktop`;
    const desktopSessions = `${desktop}/claude-code-sessions/${DESKTOP_ACCOUNT}/desktop-organization`;
    const otherDesktopSessions = `${desktop}/claude-code-sessions/other-account/other-organization`;
    const futureSession = `${desktopSessions}/local_desktop-archive-from-the-future.json`;
    const withDesktop = (nudgeArguments: string) =>
      machine.attempt(`NUDGE_CLAUDE_DESKTOP_DIR=${desktop} ${NUDGE} ${nudgeArguments}`);
    yield* machine.shell(
      [
        `mkdir -p ${desktopSessions} ${otherDesktopSessions}`,
        `printf '%s' '${desktopSession({ title: "Desktop Archive Kept", lastActivityAt: "1700000000000" })}' > ${desktopSessions}/local_desktop-archive-kept.json`,
        `printf '%s' '${desktopSession({ title: "Desktop Archive Elsewhere", lastActivityAt: "1700000000000" })}' > ${otherDesktopSessions}/local_desktop-archive-elsewhere.json`,
        `printf '%s' '${desktopSession({ title: "Desktop Open Elsewhere", lastActivityAt: "1700000000000", isArchived: false })}' > ${otherDesktopSessions}/local_desktop-open-elsewhere.json`,
        `printf '%s' '${desktopSession({ title: "Desktop Archive From The Future", lastActivityAt: "1e300" })}' > ${futureSession}`,
      ].join(" && "),
    );
    const futureWarning = `warning: can't read the Claude Desktop session file ${homePath(futureSession).show({ mode: "terminal", home: machine.home })}: Expected a value between -8640000000000000 and 8640000000000000 at ["lastActivityAt"]`;
    const listedDesktop = yield* withDesktop("list --archived 'desktop archive'");
    assert.deepEqual(
      { ...listedDesktop, standardOutput: sortedNames(listedDesktop.standardOutput) },
      {
        code: 0,
        standardOutput: ["Desktop Archive Elsewhere", "Desktop Archive Kept"],
        standardError: futureWarning,
      },
    );
    const shownDesktop = yield* withDesktop("show 'Desktop Archive Kept'");
    assert.equal(shownDesktop.code, 0, shownDesktop.standardError);
    assert.match(shownDesktop.standardOutput, /^Name:\s+Desktop Archive Kept$/mu);
    assert.match(shownDesktop.standardOutput, /^Status:\s+archived$/mu);
    const openDesktop = yield* withDesktop("list 'desktop open'");
    assert.deepEqual(
      { ...openDesktop, standardOutput: rowsWithoutUpdated(openDesktop.standardOutput) },
      {
        code: 0,
        standardOutput: [
          ["Desktop Open Elsewhere", "local_desktop-open-elsewhere", "Claude", "stopped"],
        ],
        standardError: futureWarning,
      },
    );
    assert.deepEqual(yield* withDesktop("archive 'Desktop Open Elsewhere'"), {
      code: FAILED_EXIT_CODE,
      standardOutput: "",
      standardError: `${futureWarning}\nerror: ${appClaudeCannotBeArchived({ id: "local_desktop-open-elsewhere", name: "Desktop Open Elsewhere" })}`,
    });
  }),
);
