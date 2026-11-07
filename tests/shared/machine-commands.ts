import assert from "node:assert/strict";

import { Effect, Option, Schema } from "effect";

import { thisMachine } from "../../scripts/lib/platform/index.ts";
import { BUN, startShellInThisScope } from "../../scripts/shared/codex-and-claude.ts";
import { runShell } from "../../scripts/shared/run-shell.ts";

export const NUDGE = "~/.bun/bin/nudge";

export const FAILED_EXIT_CODE = 1;
export const USAGE_EXIT_CODE = 2;

export const HELD_EXIT_CODE = 3;

export const NO_SESSIONS = `No sessions found.
hint: nudge new --help`;

export const CODEX_MODEL_AND_EFFORT = "--model gpt-6-astra --effort medium";

export const CLAUDE_MODEL_AND_EFFORT = "--model opus --effort medium";

export const WITHOUT_CLAUDE = "export PATH=/usr/bin:/bin &&";

const withModelAndEffort = (newArguments: string) => {
  if (newArguments.includes("--model")) {
    return newArguments;
  }
  const modelAndEffort = newArguments.startsWith("codex")
    ? CODEX_MODEL_AND_EFFORT
    : CLAUDE_MODEL_AND_EFFORT;
  const [agent = "", ...rest] = newArguments.split(" ");
  return [agent, modelAndEffort, ...rest].join(" ");
};

export const HINT_LINE = /^hint: (?<hint>.+)$/gmu;

export const hintsIn = (output: string) =>
  [...output.matchAll(HINT_LINE)].map((match) => match.groups?.["hint"] ?? "");

export const MISSING_ID = "00000000-0000-4000-8000-000000000000";

export const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/u;

export const rows = (listing: string) =>
  listing
    .split("\n")
    .slice(1)
    .map((row) => row.split(/\s{2,}/u));

const UPDATED_COLUMN = 4;

export const rowsWithoutUpdated = (listing: string) =>
  rows(listing).map((row) => row.filter((_cell, index) => index !== UPDATED_COLUMN));

export const sortedNames = (listing: string) =>
  rows(listing)
    .map((row) => row[0] ?? "")
    .toSorted((left, right) => left.localeCompare(right));

const Sent = Schema.Struct({
  action: Schema.String,
  provider: Schema.String,
  status: Schema.String,
  delivery: Schema.optional(Schema.String),
  target: Schema.Struct({ id: Schema.String, name: Schema.String }),
  messageId: Schema.String,
  reason: Schema.optional(Schema.String),
  to: Schema.optional(Schema.String),
});

export const decodeSent = Schema.decodeEffect(Schema.fromJsonString(Sent));

const Started = Schema.Struct({
  action: Schema.Literal("new"),
  provider: Schema.Literals(["codex", "claude"]),
  target: Schema.Struct({ id: Schema.String, name: Schema.NullOr(Schema.String) }),
});

export const startedIdOf = (output: string) =>
  Effect.map(
    Schema.decodeEffect(Schema.fromJsonString(Started))(output),
    (started) => started.target.id,
  );

export const jsonLine = (fields: Readonly<Record<string, Schema.Json>>) =>
  Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(fields);

const ShownJson = Schema.fromJsonString(
  Schema.Struct({
    action: Schema.Literal("show"),
    target: Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      status: Schema.String,
      cwd: Schema.String,
      transcript: Schema.String,
      lastActiveAt: Schema.String,
    }),
    model: Schema.NullOr(Schema.String),
    effort: Schema.NullOr(Schema.String),
    speed: Schema.NullOr(Schema.String),
  }),
);

export const decodeShownJson = Schema.decodeEffect(ShownJson);

export const quoteForShell = (text: string) => `'${text.replaceAll("'", String.raw`'\''`)}'`;

const OUTCOME =
  /^(?<code>\d+)\n---standard output---\n(?<standardOutput>[\s\S]*)\n---standard error---(?:\n(?<standardError>[\s\S]*))?$/u;

const OUTPUT_SEPARATOR = "---next command---";

const OUTPUT_SEPARATOR_LINE = new RegExp(`^${OUTPUT_SEPARATOR}$`, "mu");

const FOLLOW_APPENDS = `
const followers = new Map();
const follow = (file, onAppend) => {
  if (followers.has(file) || !existsSync(file)) return;
  const firstByte = Math.max(statSync(file).size, 1);
  const follower = spawn("tail", ["-f", "-c", "+" + firstByte, "--", file], { stdio: ["ignore", "pipe", "ignore"] });
  follower.stdout.on("data", onAppend);
  followers.set(file, follower);
};
const stopFollowing = () => {
  for (const follower of followers.values()) follower.kill();
};
process.on("exit", stopFollowing);`;

const IDLE_WAIT_SECONDS = 180;

const CLAUDE_JOB_ID_LENGTH = 8;

const MILLISECONDS_PER_SECOND = 1000;

const waitUntilIdleScript = (targets: readonly string[]) => `${BUN} -e '
import { spawn } from "node:child_process";
import { existsSync, statSync, watch } from "node:fs";
import { dirname } from "node:path";${FOLLOW_APPENDS}
const show = (target) => {
  const shown = Bun.spawnSync([process.env.HOME + "/.bun/bin/nudge", "show", "--json", target]);
  if (shown.exitCode !== 0) {
    console.error("nudge show --json " + target + " exited with " + (shown.signalCode ?? shown.exitCode) + ": " + shown.stderr.toString());
    process.exit(1);
  }
  return JSON.parse(shown.stdout.toString()).target;
};
const targets = [${targets.map((target) => `"${target}"`).join(", ")}];
const describe = (sessions) => sessions.map((session) => session.id + " (" + session.status + ")").join(", ");
const directoriesOf = (session) => [
  ...(session.transcript === "" ? [] : [dirname(session.transcript)]),
  ...(session.provider === "claude" ? [process.env.HOME + "/.claude/sessions", process.env.HOME + "/.claude/jobs/" + session.id.slice(0, ${CLAUDE_JOB_ID_LENGTH})] : []),
];
const watchers = new Map();
let busy = targets.map((target) => show(target));
const timer = setTimeout(() => {
  console.error("not idle after ${IDLE_WAIT_SECONDS} seconds: " + describe(busy));
  process.exit(1);
}, ${IDLE_WAIT_SECONDS * MILLISECONDS_PER_SECOND});
await new Promise((resolve) => {
  const settle = () => {
    const shown = targets.map((target) => show(target));
    for (const session of shown) {
      follow(session.transcript, settle);
      for (const directory of directoriesOf(session)) {
        if (!watchers.has(directory) && existsSync(directory)) watchers.set(directory, watch(directory, settle));
      }
    }
    busy = shown.filter((session) => session.status !== "idle");
    const ended = busy.filter((session) => session.status === "archived" || session.status === "stopped");
    if (ended.length > 0) {
      console.error("stopped or archived while waiting for idle: " + describe(ended));
      process.exit(1);
    }
    if (busy.length === 0) {
      for (const watcher of watchers.values()) watcher.close();
      stopFollowing();
      resolve();
    }
  };
  settle();
});
clearTimeout(timer);'`;

const TEXT_WAIT_SECONDS = 60;

const waitForTextsScript = ({
  file,
  texts,
  afterLine,
}: {
  readonly file: string;
  readonly texts: readonly string[];
  readonly afterLine: number;
}) => `${BUN} -e '
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, watch } from "node:fs";
import { dirname } from "node:path";${FOLLOW_APPENDS}
const [file, ...texts] = process.argv.slice(1);
const read = () => {
  try {
    return readFileSync(file, "utf8").split("\\n").slice(${afterLine}).join("\\n");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
};
const lacking = () => {
  const content = read();
  return texts.filter((text) => !content.includes(text));
};
const timer = setTimeout(() => {
  console.error(file + " lacks after ${TEXT_WAIT_SECONDS} seconds: " + lacking().join(", "));
  process.exit(1);
}, ${TEXT_WAIT_SECONDS * MILLISECONDS_PER_SECOND});
await new Promise((resolve) => {
  const settle = () => {
    follow(file, settle);
    if (lacking().length === 0) {
      watcher.close();
      stopFollowing();
      resolve();
    }
  };
  const watcher = watch(dirname(file), settle);
  settle();
});
clearTimeout(timer);' ${file} ${texts.map((text) => quoteForShell(text)).join(" ")}`;

const IN_THE_WORK_DIRECTORY = "cd ~/work && export PATH=~/.local/bin:~/.bun/bin:$PATH &&";

const JsonHint = Schema.fromJsonString(Schema.Struct({ hint: Schema.NullOr(Schema.String) }));

const checkPrintedHints = (output: string) =>
  Effect.gen(function* () {
    const hints = [
      ...hintsIn(output),
      ...output.split("\n").flatMap((line) => {
        const decoded = Schema.decodeOption(JsonHint)(line);
        if (Option.isNone(decoded)) {
          return [];
        }
        return decoded.value.hint === null ? [] : [decoded.value.hint];
      }),
    ];
    for (const hint of hints) {
      const program = /^(?<program>[\w-]+)(?:\s|$)/u.exec(hint)?.groups?.["program"];
      assert.ok(program !== undefined, `hint is not a runnable command: ${hint}`);
      yield* runShell(
        `${IN_THE_WORK_DIRECTORY} bash -n -c ${quoteForShell(hint)} && command -v ${quoteForShell(program)} > /dev/null`,
      );
    }
  });

const shell = (line: string) =>
  runShell(`${IN_THE_WORK_DIRECTORY} ${line}`).pipe(
    Effect.tap(checkPrintedHints),
    Effect.map((output) => output.trim()),
  );

const startInThisScope = (line: string) =>
  startShellInThisScope(`${IN_THE_WORK_DIRECTORY} ${line}`);

export const makeMachine = Effect.gen(function* () {
  const {
    home,
    nudge: nudgePath,
    codexLogs,
    mcpLogs,
    codexCli,
    codexNode,
    bridgeSocket,
    mainProcess,
    quitCodex,
    waitForExit,
  } = yield* thisMachine;
  const scratch = yield* shell("mktemp -d ~/scratch.XXXXXXXX");
  const nudge = (nudgeArguments: string) => shell(`${NUDGE} ${nudgeArguments}`);
  const start = (newArguments: string) =>
    Effect.flatMap(nudge(`new --json ${withModelAndEffort(newArguments)}`), startedIdOf);
  const attempt = (line: string) =>
    shell(
      `(${line}) > ${scratch}/out 2> ${scratch}/err; code=$?; printf '%s\\n---standard output---\\n%s\\n---standard error---\\n%s' "$code" "$(cat ${scratch}/out)" "$(cat ${scratch}/err)"`,
    ).pipe(
      Effect.map((output) => {
        const groups = OUTCOME.exec(output)?.groups;
        return {
          code: Number(groups?.["code"]),
          standardOutput: groups?.["standardOutput"] ?? "",
          standardError: groups?.["standardError"] ?? "",
        };
      }),
    );
  const shells = (lines: readonly string[]) =>
    shell(
      lines.map((line) => `printf '\\n%s\\n' '${OUTPUT_SEPARATOR}' && (${line})`).join(" && "),
    ).pipe(
      Effect.map((output) =>
        output
          .split(OUTPUT_SEPARATOR_LINE)
          .slice(1)
          .map((part) => part.trim()),
      ),
    );
  const filesHave = (
    checks: readonly {
      readonly file: string;
      readonly texts: readonly string[];
      readonly afterLine?: number;
    }[],
  ) =>
    shell(
      checks
        .map(({ file, texts, afterLine }) =>
          waitForTextsScript({ file: quoteForShell(file), texts, afterLine: afterLine ?? 0 }),
        )
        .join(" && "),
    );
  const transcriptOf = (target: string) =>
    Effect.map(
      Effect.flatMap(nudge(`show --json ${quoteForShell(target)}`), decodeShownJson),
      (shown) => shown.target.transcript,
    );
  const transcriptHas = ({
    target,
    texts,
  }: {
    readonly target: string;
    readonly texts: readonly string[];
  }) =>
    Effect.flatMap(transcriptOf(target), (transcript) => filesHave([{ file: transcript, texts }]));
  const transcriptLinesWith = ({
    target,
    text,
  }: {
    readonly target: string;
    readonly text: string;
  }) =>
    Effect.gen(function* () {
      const transcript = yield* transcriptOf(target);
      yield* filesHave([{ file: transcript, texts: [text] }]);
      return yield* shell(`grep -F -- ${quoteForShell(text)} ${quoteForShell(transcript)}`);
    });
  const showJson = (target: string) =>
    nudge(`show --json '${target}'`).pipe(Effect.flatMap(decodeShownJson));
  const waitUntilIdle = (...targets: readonly string[]) => shell(waitUntilIdleScript(targets));
  const runHints = (output: string) => Effect.forEach(hintsIn(output), (hint) => attempt(hint));
  return {
    home,
    nudgePath,
    codexLogs,
    mcpLogs,
    codexCli,
    codexNode,
    bridgeSocket,
    mainProcess,
    quitCodex,
    waitForExit,
    scratch,
    shell,
    startInThisScope,
    nudge,
    start,
    attempt,
    shells,
    filesHave,
    transcriptHas,
    transcriptLinesWith,
    showJson,
    waitUntilIdle,
    runHints,
  };
});

export const machineTest = <Success, Failure, Services>(
  test: (machine: Effect.Success<typeof makeMachine>) => Effect.Effect<Success, Failure, Services>,
) => test;
