import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Option, Schema } from "effect";

import { thisMachine, XVFB_DISPLAY } from "../lib/platform/index.ts";
import { BUN, readFirstLine, startShellInThisScope } from "./codex-and-claude.ts";
import { runShell } from "./run-shell.ts";

const BRIDGE_WAIT_MINUTES = 5;

const MILLISECONDS_PER_MINUTE = 60_000;

const LOG_TAIL_LINES = 40;

const waitForBridge = ({
  logs,
  mainProcess,
  waitForExit,
}: {
  readonly logs: string;
  readonly mainProcess: string;
  readonly waitForExit: (pids: string) => string;
}) => `${BUN} -e '
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
const [logs, mainProcess, waitForExit] = process.argv.slice(1);
const state = process.env.HOME + "/.local/state";
const socket = state + "/nudge/codex/codex.sock";
const traces = state + "/nudge/traces";
mkdirSync(state, { recursive: true });
const sizeOf = (file) => (existsSync(file) ? statSync(file).size : 0);
const filesIn = (path) =>
  !existsSync(path) ? [] : statSync(path).isDirectory() ? readdirSync(path, { recursive: true }).map((name) => join(path, name)).filter((file) => statSync(file).isFile()) : [path];
const startSizes = new Map([...filesIn(traces), ...filesIn(logs)].map((file) => [file, sizeOf(file)]));
const newText = (path) => filesIn(path).map((file) => readFileSync(file).subarray(startSizes.get(file) ?? 0).toString()).join("\\n");
const logTail = () => {
  const [newest] = filesIn(logs).toSorted((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  return newest === undefined ? "(no Codex Desktop log)" : newest + ":\\n" + readFileSync(newest, "utf8").split("\\n").slice(-${LOG_TAIL_LINES}).join("\\n");
};
const fail = (reason) => {
  console.error(reason + "\\n--- Codex Desktop log ---\\n" + logTail());
  process.exit(1);
};
setTimeout(() => fail("Codex Desktop did not open the bridge socket " + socket + " within ${BRIDGE_WAIT_MINUTES} minutes"), ${BRIDGE_WAIT_MINUTES * MILLISECONDS_PER_MINUTE});
let exitWaiter;
process.on("exit", () => exitWaiter?.kill());
const watchDesktopExit = () => {
  const pid = exitWaiter === undefined ? spawnSync("pgrep", ["-o", "-f", mainProcess]).stdout.toString().trim() : "";
  if (pid === "") return;
  exitWaiter = spawn("sh", ["-c", waitForExit, "sh", pid], { stdio: "ignore" });
  exitWaiter.on("exit", () => fail("Codex Desktop (process " + pid + ") exited before the bridge socket opened"));
};
const check = () => {
  watchDesktopExit();
  const helperFailure = newText(traces).split("\\n").find((line) => line.includes("\\"codexHelper.failure\\""));
  if (helperFailure !== undefined) fail("the Codex helper recorded a failure: " + helperFailure.slice(0, 2000));
  const mcpFailure = newText(logs).split("\\n").find((line) => line.includes("server=nudge") && line.includes("status=failed"));
  if (mcpFailure !== undefined) fail("Codex Desktop could not start the nudge MCP server: " + mcpFailure);
  if (!existsSync(socket)) return;
  const client = connect(socket);
  client.on("connect", () => process.exit(0));
  client.on("error", (error) => {
    if (error.code !== "ENOENT") fail("could not connect to " + socket + ": " + error.code + " " + error.message);
  });
};
watch(state, { recursive: true }, check);
watch(existsSync(logs) ? logs : dirname(logs), { recursive: true }, check);
check();' ${logs} '${mainProcess}' '${waitForExit('"$1"')}'`;

const XVFB_LOG = ".local/state/nudge-tests/xvfb.log";

class XvfbNotStarted extends Schema.TaggedError<XvfbNotStarted>()("XvfbNotStarted", {
  log: Schema.String,
}) {
  public override get message() {
    return `Xvfb didn't open the display ${XVFB_DISPLAY}\n--- ~/${XVFB_LOG} ---\n${this.log}`;
  }
}

export const xvfbDisplay = Task.make(
  "start-xvfb",
  Effect.gen(function* () {
    const machine = yield* thisMachine;
    const xvfb = yield* startShellInThisScope(
      `mkdir -p ~/.local/state/nudge-tests\nexec Xvfb ${XVFB_DISPLAY} -displayfd 1 -screen 0 1440x900x24 -nolisten tcp 2>> ~/${XVFB_LOG}`,
    );
    const opened = yield* readFirstLine(xvfb);
    if (Option.getOrNull(opened) !== XVFB_DISPLAY.slice(1)) {
      const log = yield* (yield* FileSystem.FileSystem).readFileString(
        `${machine.home}/${XVFB_LOG}`,
      );
      return yield* new XvfbNotStarted({
        log: log.split("\n").slice(-LOG_TAIL_LINES).join("\n"),
      });
    }
    return yield* Task.serve(XVFB_DISPLAY);
  }),
  { timeout: "1 minute", cleanup: "1 minute" },
);

export const startCodexDesktop = Effect.fn("startCodexDesktop")(function* ({
  beforeStart = "",
  environment = {},
}: {
  readonly beforeStart?: string;
  readonly environment?: Readonly<Record<string, string>>;
} = {}) {
  const machine = yield* thisMachine;
  yield* machine.prepareDisplay(xvfbDisplay);
  yield* runShell(`${machine.quitCodex}\nrm -f ${machine.bridgeSocket}\n${beforeStart}`);
  yield* startShellInThisScope(machine.startCodex(environment));
  yield* runShell(
    waitForBridge({
      logs: machine.codexLogs,
      mainProcess: machine.mainProcess,
      waitForExit: machine.waitForExit,
    }),
  );
});
