import assert from "node:assert/strict";

import { Effect, Schema } from "effect";

import { BUN } from "../../scripts/shared/codex-and-claude.ts";
import { runShell } from "../../scripts/shared/run-shell.ts";
import {
  CLAUDE_MODEL_AND_EFFORT,
  CODEX_MODEL_AND_EFFORT,
  machineTest,
  MISSING_ID,
  NO_SESSIONS,
  NUDGE,
  rows,
  rowsWithoutUpdated,
  sortedNames,
  UUID,
} from "./machine-commands.ts";

const LISTED_COUNT = 2;

const STARTED =
  /^Started (?:an unnamed (?:Codex|Claude) session|Claude session "[^"\n]*") \((?<id>[\da-f-]{36})\)(?: in ~\/work| in ~\/Documents\/Codex\/\S+, because ~\/work isn't a Codex Desktop project)\.$/u;

const attaches = (name: string) => `${BUN} -e '
const agents = await Bun.$\`$HOME/.local/bin/claude agents --json\`.json();
const job = agents.find((agent) => agent.name === "${name}" && agent.kind === "background");
if (job === undefined) throw new Error("${name} is not a background agent");
let screen = "";
const shownName = Promise.withResolvers();
const shown = () => screen.replace(/\\x1b\\[[0-9;?]*[A-Za-z]/g, " ").replace(/\\s+/g, " ").includes("${name}");
const attach = Bun.spawn([process.env.HOME + "/.local/bin/claude", "attach", job.id], {
  env: { ...process.env, CLAUDE_CODE_NO_FLICKER: "1" },
  terminal: {
    cols: 120,
    rows: 40,
    data: (_, data) => {
      screen += new TextDecoder().decode(data);
      if (shown()) shownName.resolve();
    },
  },
});
attach.exited.then((code) => shownName.reject(new Error("claude attach exited with code " + code + " before it showed ${name}")));
await shownName.promise;
attach.kill();'`;

const CLAUDE_STEP_TIME_LIMIT_SECONDS = 120;

const listWhileClaudeDesktopForks = (sessionId: string) => `${BUN} -e '
import { existsSync, watch } from "node:fs";
const TIME_LIMIT_SECONDS = ${CLAUDE_STEP_TIME_LIMIT_SECONDS};
const sessionFiles = process.env.HOME + "/.claude/sessions/";
const fork = Bun.spawn([process.env.HOME + "/.local/bin/claude", "--output-format", "stream-json", "--verbose", "--input-format", "stream-json", "--resume", "${sessionId}", "--fork-session", "--no-session-persistence"], {
  cwd: process.env.HOME + "/work", stdin: "pipe", stdout: "ignore", stderr: "ignore",
});
const registered = Promise.withResolvers();
const watcher = watch(sessionFiles, () => {
  if (existsSync(sessionFiles + fork.pid + ".json")) registered.resolve();
});
if (existsSync(sessionFiles + fork.pid + ".json")) registered.resolve();
fork.exited.then((code) => registered.reject(new Error("the forked Claude process exited with code " + code + " before it registered a session file")));
const timer = setTimeout(() => {
  fork.kill();
  registered.reject(new Error("the forked Claude process registered no session file within " + TIME_LIMIT_SECONDS + " seconds"));
}, TIME_LIMIT_SECONDS * 1000);
await registered.promise;
clearTimeout(timer);
watcher.close();
const listed = Bun.spawnSync([process.env.HOME + "/.bun/bin/nudge", "list", "--json", "listing"]);
fork.kill();
await fork.exited;
process.stdout.write(listed.stdout);'`;

const STOP_THE_TERMINAL = `
clearTimeout(timer);
claude.kill();
await claude.exited;
process.stdout.write(sessionId);`;

const ARCHIVE_THE_TERMINAL_WITH_NUDGE = `
// Keep draining the PTY while Claude flushes its terminal during shutdown.
waitingFor = "nudge archive to finish";
const archive = Bun.spawn([home + "/.bun/bin/nudge", "archive", sessionId], { stdout: "pipe", stderr: "pipe" });
const [code, standardOutput, standardError] = await Promise.race([
  Promise.all([archive.exited, new Response(archive.stdout).text(), new Response(archive.stderr).text()]),
  timedOut.promise,
]);
waitingFor = "claude to exit after nudge archive";
await Promise.race([claude.exited, timedOut.promise]);
clearTimeout(timer);
process.stdout.write(JSON.stringify({ sessionId, code, standardOutput: standardOutput.trim(), standardError: standardError.trim() }));`;

export const renameATerminalSession = ({
  name,
  end,
}: {
  readonly name: string;
  readonly end: "archive with nudge" | "stop";
}) => `${BUN} -e '
import { watch } from "node:fs";
const TIME_LIMIT_SECONDS = ${CLAUDE_STEP_TIME_LIMIT_SECONDS};
const home = process.env.HOME;
const sessionId = crypto.randomUUID();
const shownText = (text) => text.replace(/\\x1b\\[[0-9;?]*[A-Za-z]/g, " ").replace(/\\s+/g, " ");
let screen = "";
let onScreen = () => {};
const claude = Bun.spawn([home + "/.local/bin/claude", "--session-id", sessionId, "hello from a terminal"], {
  cwd: home + "/work",
  env: { ...process.env, CLAUDE_CODE_NO_FLICKER: "1" },
  terminal: {
    cols: 120,
    rows: 40,
    data: (_, data) => {
      screen += new TextDecoder().decode(data);
      onScreen();
    },
  },
});
const exitedEarly = claude.exited.then((code) => {
  throw new Error("claude exited with code " + code + " on this screen: " + shownText(screen).slice(-1500));
});
let waitingFor = "";
const timedOut = Promise.withResolvers();
const timer = setTimeout(() => {
  claude.kill();
  timedOut.reject(new Error("gave up after " + TIME_LIMIT_SECONDS + " seconds waiting for " + waitingFor + " on this screen: " + shownText(screen).slice(-1500)));
}, TIME_LIMIT_SECONDS * 1000);
const screenShows = (text, from) => {
  waitingFor = "the screen to show " + text;
  const shown = Promise.withResolvers();
  onScreen = () => {
    if (shownText(screen.slice(from)).includes(text)) shown.resolve();
  };
  onScreen();
  return Promise.race([shown.promise, exitedEarly, timedOut.promise]);
};
const projectFileExists = async (path) => {
  waitingFor = path + " in ~/.claude/projects";
  const exists = Promise.withResolvers();
  const check = () => {
    if (new Bun.Glob("*/" + path).scanSync({ cwd: home + "/.claude/projects" }).next().done === false) exists.resolve();
  };
  const watcher = watch(home + "/.claude/projects", { recursive: true }, check);
  check();
  await Promise.race([exists.promise, exitedEarly, timedOut.promise]);
  watcher.close();
};
await screenShows("Mocked reply.", 0);
const beforeRename = screen.length;
claude.terminal.write("/rename ${name}");
await screenShows("${name}", beforeRename);
claude.terminal.write("\\r");
await projectFileExists(sessionId + "/custom-title.json");${end === "stop" ? STOP_THE_TERMINAL : ARCHIVE_THE_TERMINAL_WITH_NUDGE}'`;

const ListedJson = Schema.fromJsonString(
  Schema.Struct({
    action: Schema.Literal("list"),
    targets: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
    total: Schema.Int,
    offset: Schema.Int,
    nextOffset: Schema.NullOr(Schema.Int),
  }),
);

export const listingSessions = machineTest((machine) =>
  Effect.gen(function* () {
    assert.equal(
      yield* machine.shell(
        `CLAUDE_CONFIG_DIR=${machine.scratch}/no-claude NUDGE_CLAUDE_DESKTOP_DIR=${machine.scratch}/no-claude-desktop ${NUDGE} list`,
      ),
      NO_SESSIONS,
    );
    const [newHelp] = yield* machine.runHints(NO_SESSIONS);
    assert.ok(newHelp);
    assert.equal(newHelp.code, 0, newHelp.standardError);
    assert.match(newHelp.standardOutput, /^Start a session with a prompt as its first message\./u);
    const started = yield* machine.shells([
      `${NUDGE} new codex ${CODEX_MODEL_AND_EFFORT} 'Say hello'`,
      `${NUDGE} new claude ${CLAUDE_MODEL_AND_EFFORT} 'Say hello'`,
    ]);
    const startedIds = started.map((output) => STARTED.exec(output)?.groups?.["id"] ?? output);
    yield* machine.waitUntilIdle(...startedIds);
    for (const id of startedIds) {
      yield* machine.nudge(`archive ${id}`);
    }
    const codexId = yield* machine.start("codex 'hello from nudge' --name 'Listing Codex'");
    const claudeId = yield* machine.start("claude 'hello from nudge' --name 'Listing Claude'");
    yield* machine.waitUntilIdle(codexId, claudeId);

    assert.deepEqual(
      rowsWithoutUpdated(yield* machine.nudge("list listing")).toSorted((left, right) =>
        (left[0] ?? "").localeCompare(right[0] ?? ""),
      ),
      [
        ["Listing Claude", claudeId, "Claude", "idle", "work"],
        ["Listing Codex", codexId, "Codex", "idle"],
      ],
    );

    yield* runShell(attaches("Listing Claude"));

    const corruptSessionFile = `${machine.home}/.claude/sessions/99999.json`;
    yield* machine.shell(`echo 'not json' > ${corruptSessionFile}`);
    const withCorruptSessionFile = yield* machine.attempt(`${NUDGE} list listing`);
    yield* machine.shell(`rm ${corruptSessionFile}`);
    assert.equal(withCorruptSessionFile.code, 0);
    assert.deepEqual(sortedNames(withCorruptSessionFile.standardOutput), [
      "Listing Claude",
      "Listing Codex",
    ]);
    assert.equal(
      withCorruptSessionFile.standardError,
      "warning: can't read the Claude session file ~/.claude/sessions/99999.json: Expected a valid JSON string",
    );
    const withCorruptFileOfALiveProcess = yield* machine.attempt(
      `echo 'not json' > ~/.claude/sessions/$$.json && ${NUDGE} list listing; code=$?; rm ~/.claude/sessions/$$.json; exit $code`,
    );
    assert.equal(
      withCorruptFileOfALiveProcess.code,
      0,
      withCorruptFileOfALiveProcess.standardError,
    );
    assert.deepEqual(sortedNames(withCorruptFileOfALiveProcess.standardOutput), [
      "Listing Claude",
      "Listing Codex",
    ]);
    assert.match(
      withCorruptFileOfALiveProcess.standardError,
      /^warning: can't read the Claude session file ~\/\.claude\/sessions\/\d+\.json: Expected a valid JSON string$/u,
    );
    const withFileOfAReusedPid = yield* machine.attempt(
      `printf '{"pid":%s,"sessionId":"${MISSING_ID}","name":"Ended Claude","startedAt":1,"procStart":"1"}' $$ > ~/.claude/sessions/$$.json && ${NUDGE} list listing; code=$?; rm ~/.claude/sessions/$$.json; exit $code`,
    );
    assert.equal(withFileOfAReusedPid.code, 0, withFileOfAReusedPid.standardError);
    assert.deepEqual(sortedNames(withFileOfAReusedPid.standardOutput), [
      "Listing Claude",
      "Listing Codex",
    ]);
    const outOfRangeSessionFile = `${machine.home}/.claude/sessions/99998.json`;
    const withOutOfRangeDate = yield* machine.attempt(
      `printf '{"pid":%s,"sessionId":"listing-from-the-future","name":"Listing From The Future","startedAt":1e300}' $$ > ${outOfRangeSessionFile} && ${NUDGE} list listing; code=$?; rm ${outOfRangeSessionFile}; exit $code`,
    );
    assert.equal(withOutOfRangeDate.code, 0, withOutOfRangeDate.standardError);
    assert.deepEqual(sortedNames(withOutOfRangeDate.standardOutput), [
      "Listing Claude",
      "Listing Codex",
    ]);
    assert.equal(
      withOutOfRangeDate.standardError,
      `warning: can't read the Claude session file ~/.claude/sessions/99998.json: Expected a value between -8640000000000000 and 8640000000000000 at ["startedAt"]`,
    );
    const brokenClaude = `${machine.scratch}/broken-claude`;
    yield* machine.shell(
      `mkdir -p ${brokenClaude} && printf '#!/bin/sh\\necho "claude broke" >&2\\nexit 7\\n' > ${brokenClaude}/claude && chmod +x ${brokenClaude}/claude`,
    );
    const withBrokenClaude = yield* machine.attempt(
      `PATH="${brokenClaude}:$PATH" ${NUDGE} list listing`,
    );
    assert.equal(withBrokenClaude.code, 0, withBrokenClaude.standardError);
    assert.equal(withBrokenClaude.standardError, "");
    assert.deepEqual(sortedNames(withBrokenClaude.standardOutput), [
      "Listing Claude",
      "Listing Codex",
    ]);
    const codexHomeWithUrlCharacters = `${machine.scratch}/codex#home?`;
    yield* machine.shell(`ln -s ~/.codex '${codexHomeWithUrlCharacters}'`);
    const withUrlCharactersInCodexHome = yield* machine.attempt(
      `CODEX_HOME='${codexHomeWithUrlCharacters}' ${NUDGE} list listing`,
    );
    assert.equal(withUrlCharactersInCodexHome.code, 0, withUrlCharactersInCodexHome.standardError);
    assert.deepEqual(sortedNames(withUrlCharactersInCodexHome.standardOutput), [
      "Listing Claude",
      "Listing Codex",
    ]);

    const [
      listedCodex = "",
      listedHeader = "",
      listedOne = "",
      listedAll = "",
      listedJson = "",
      firstPageJson = "",
    ] = yield* machine.shells([
      `${NUDGE} list 'listing codex'`,
      `${NUDGE} list listing | head -1`,
      `${NUDGE} list --limit 1 listing`,
      `${NUDGE} list --all listing`,
      `${NUDGE} list --json listing`,
      `${NUDGE} list --json --limit 1 listing`,
    ]);
    assert.deepEqual(
      rows(listedCodex).map((row) => row[0]),
      ["Listing Codex"],
    );
    assert.match(listedHeader, /^NAME\s+ID\s+PROVIDER\s+STATUS\s+UPDATED\s+PROJECT\s+SECTION$/u);
    const [, , ...listedOnePaging] = listedOne.split("\n");
    assert.deepEqual(listedOnePaging, [
      `Showing 1–1 of ${LISTED_COUNT} matches.`,
      "hint: nudge list --limit 1 --offset 1 listing",
    ]);
    const [nextPage] = yield* machine.runHints(listedOne);
    assert.ok(nextPage);
    assert.equal(nextPage.code, 0);
    assert.deepEqual(
      sortedNames(`${listedHeader}\n${nextPage.standardOutput.split("\n").slice(1).join("\n")}`)
        .length,
      1,
    );
    const pastTheEnd = yield* machine.attempt(`${NUDGE} list --offset 5 listing`);
    assert.equal(LISTED_COUNT, sortedNames(listedAll).length);
    assert.deepEqual(pastTheEnd, {
      code: 0,
      standardOutput: `No matches on this page, because --offset 5 skips all ${LISTED_COUNT} matches.\nhint: nudge list listing`,
      standardError: "",
    });
    const [allMatches] = yield* machine.runHints(pastTheEnd.standardOutput);
    assert.deepEqual(sortedNames(allMatches?.standardOutput ?? ""), [
      "Listing Claude",
      "Listing Codex",
    ]);
    assert.deepEqual(sortedNames(listedAll), ["Listing Claude", "Listing Codex"]);
    const listed = yield* Schema.decodeEffect(ListedJson)(listedJson);
    assert.deepEqual(
      listed.targets.map((target) => target.id).toSorted(),
      [claudeId, codexId].toSorted(),
    );
    assert.equal(listed.total, listed.targets.length);
    assert.equal(listed.nextOffset, null);
    const firstPage = yield* Schema.decodeEffect(ListedJson)(firstPageJson);
    assert.equal(firstPage.targets.length, 1);
    assert.equal(firstPage.nextOffset, 1);
    const firstPageFromRoot = yield* machine.attempt(`${NUDGE} --json list --limit 1 listing`);
    assert.equal(firstPageFromRoot.code, 0, firstPageFromRoot.standardError);
    const rootPage = yield* Schema.decodeEffect(ListedJson)(firstPageFromRoot.standardOutput);
    assert.equal(rootPage.targets.length, 1);
    assert.equal(rootPage.nextOffset, 1);

    const listedWhileForked = yield* Schema.decodeEffect(ListedJson)(
      yield* machine.shell(listWhileClaudeDesktopForks(claudeId)),
    );
    assert.deepEqual(
      listedWhileForked.targets.map((target) => target.id).toSorted(),
      [claudeId, codexId].toSorted(),
    );

    const endedId = yield* machine.shell(
      renameATerminalSession({ name: "Listing Ended", end: "stop" }),
    );
    assert.match(endedId, UUID);
    const [endedByName = "", endedById = ""] = yield* machine.shells([
      `${NUDGE} show 'Listing Ended'`,
      `${NUDGE} show ${endedId}`,
    ]);
    assert.deepEqual(
      [endedByName, endedById].map((shown) =>
        shown
          .split("\n")
          .filter((line) => /^(?:Name|ID|Status|Directory):/u.test(line))
          .map((line) => line.replace(/^\w+:\s+/u, "")),
      ),
      [
        ["Listing Ended", endedId, "stopped", "~/work"],
        ["Listing Ended", endedId, "stopped", "~/work"],
      ],
    );

    yield* machine.nudge("archive 'Listing Codex'");
    yield* machine.nudge("archive 'Listing Claude'");
    assert.deepEqual(rowsWithoutUpdated(yield* machine.nudge("list --archived 'Listing Claude'")), [
      ["Listing Claude", claudeId, "Claude", "stopped", "work"],
    ]);
    assert.equal(
      yield* machine.nudge("list listing"),
      `No matches for "listing".\nhint: nudge list --archived listing`,
    );
  }),
);
