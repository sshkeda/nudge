import { Task } from "@sshkeda/task";
import { Effect, Schema, Stream } from "effect";
import { ChildProcess } from "effect/process";
import type { ChildProcessSpawner } from "effect/process";

import { thisMachine } from "../lib/platform/index.ts";
import { runShell } from "./run-shell.ts";

export const PROJECT = new URL("../../", import.meta.url).pathname;

export const DIST = `${PROJECT}dist/`;

export const BUN = process.execPath;

const BUN_VERSION = "1.4.4";

export const CLAUDE_VERSION = "2.1.304";

export const MOCK_MODEL_PORT = 41_517;

export const MOCK_MODEL_URL = `http://127.0.0.1:${MOCK_MODEL_PORT}`;

export const MOCK_MODEL_PROVIDER = "mock";

export const SELECTED_MODEL_PROVIDER = /^model_provider = "(?<provider>[^"]+)"$/mu;

export const startShellInThisScope = (command: string) =>
  ChildProcess.make("bash", ["-c", command], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });

export const readFirstLine = (started: ChildProcessSpawner.ChildProcessHandle) =>
  started.stdout.pipe(Stream.decodeText, Stream.splitLines, Stream.runHead);

class NotAGitCheckout extends Schema.TaggedError<NotAGitCheckout>()("NotAGitCheckout", {
  directory: Schema.String,
}) {
  public override get message() {
    return `${this.directory} isn't a git checkout, so nudge's checks can't list its files\nhint: Send the repo to this machine with its .git folder`;
  }
}

export const requireGitCheckout = Task.exec(
  "bash",
  [
    "-c",
    `test "$(git -C '${PROJECT}' rev-parse --show-toplevel)" = "$(cd '${PROJECT}' && pwd -P)"`,
  ],
  { secret: true },
).pipe(
  Effect.catchTag("CapturedCommandFailed", () =>
    Effect.fail(new NotAGitCheckout({ directory: PROJECT })),
  ),
  Effect.asVoid,
);

class MachineNotSetUp extends Schema.TaggedError<MachineNotSetUp>()("MachineNotSetUp", {
  missing: Schema.String,
}) {
  public override get message() {
    return `this machine isn't set up for nudge, because ${this.missing}\nhint: Run bun scripts/set-up-fresh-machine.ts on a fresh machine first`;
  }
}

const requireThat = ({
  missing,
  command,
}: {
  readonly missing: string;
  readonly command: string;
}) =>
  runShell(command).pipe(
    Effect.catchTag("CommandFailed", () => Effect.fail(new MachineNotSetUp({ missing }))),
  );

export const requireSetUpMachine = Effect.gen(function* () {
  const machine = yield* thisMachine;
  yield* requireThat({
    missing: `Codex Desktop isn't installed in ${machine.app}`,
    command: `test -e '${machine.app}'`,
  });
  yield* requireThat({
    missing: `Claude Code isn't installed in ${machine.claude}`,
    command: `test -x '${machine.claude}'`,
  });
  if (!Bun.semver.satisfies(Bun.version, `>=${BUN_VERSION}`)) {
    return yield* new MachineNotSetUp({
      missing: `${BUN} is Bun ${Bun.version}, older than ${BUN_VERSION}`,
    });
  }
  yield* requireThat({ missing: "git doesn't run", command: "git --version" });
  yield* requireThat({
    missing: "node isn't on PATH, and effect-tsgo runs it",
    command: "command -v node",
  });
  yield* Effect.forEach(machine.requiredCommands, requireThat, { discard: true });
  yield* requireThat({
    missing: `${machine.nudge} doesn't link to ${DIST}nudge`,
    command: `test "$(readlink -f '${machine.nudge}')" = "$(readlink -f '${DIST}nudge')"`,
  });
  yield* requireThat({
    missing: `${machine.claudeShellConfig} doesn't add ~/.local/bin to PATH, so Codex Desktop's tasks can't find claude`,
    command: `grep -qxF 'export PATH="$HOME/.local/bin:$PATH"' '${machine.claudeShellConfig}'`,
  });
  yield* requireThat({
    missing: `${machine.codexConfig} doesn't exist`,
    command: `test -f '${machine.codexConfig}'`,
  });
  yield* requireThat({
    missing: `${machine.claudeConfig} doesn't exist`,
    command: `test -f '${machine.claudeConfig}'`,
  });
  return machine;
});
