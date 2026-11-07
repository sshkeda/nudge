import { constants } from "node:fs";
import { open } from "node:fs/promises";

import { Effect, Option } from "effect";

import { HOME } from "../../../shared/read-environment.ts";
import type { runCommand as runCommandHere } from "../../../shared/run-command.ts";
import { ProcessStartUnreadable } from "./errors.ts";
import { holdALock } from "./hold-a-lock.ts";

const O_EXLOCK = 0x20;

const PS_NO_SUCH_PROCESS_EXIT_CODE = 1;

const LOCKED_FILE_HELD_ELSEWHERE_CODES: ReadonlySet<string> = new Set(["EAGAIN", "EWOULDBLOCK"]);

export const MACOS_PID_DOMAIN = "darwin";

const PS_ENVIRONMENT = { LC_ALL: "C", TZ: "UTC" } as const;

export const psArgumentsForStart = (pid: number) => ["-o", "lstart=", "-p", String(pid)];

export const psArgumentsForCommandLine = (pid: number) => ["-ww", "-o", "args=", "-p", String(pid)];

export const readStartFromPs = (output: string) =>
  Option.liftPredicate(output.trim(), (start) => start !== "");

export const splitPsArguments = (output: string) => {
  const line = output.trim();
  return line === "" ? [] : line.split(/\s+/u);
};

export const claudeDesktopDirectoryIn = (home: string) =>
  `${home}/Library/Application Support/Claude`;

export const makeMacosPlatform = (
  runCommand: (
    ...runArguments: Parameters<typeof runCommandHere>
  ) => Effect.Effect<string, Effect.Error<ReturnType<typeof runCommandHere>>>,
) => {
  const runPs = (psArguments: readonly string[]) =>
    runCommand("ps", psArguments, { environment: PS_ENVIRONMENT });
  return {
    name: "macos" as const,

    codexDesktop: {
      node: "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node",
      codex: "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
      listProcesses: ["ps", "-axo", "comm="],
      process: /^\/Applications\/ChatGPT\.app\/Contents\/MacOS\//u,
      open: "open /Applications/ChatGPT.app",
    },

    readProcessStart: Effect.fn("platform.macos.readProcessStart")(function* (pid: number) {
      const psArguments = psArgumentsForStart(pid);
      const output = yield* runPs(psArguments).pipe(
        Effect.asSome,
        Effect.catchTag("CommandFailed", (failed) =>
          failed.exitCode === PS_NO_SUCH_PROCESS_EXIT_CODE
            ? Effect.succeedNone
            : Effect.fail(failed),
        ),
      );
      if (Option.isNone(output)) {
        return Option.none();
      }
      const start = readStartFromPs(output.value);
      if (Option.isNone(start)) {
        return yield* new ProcessStartUnreadable({ pid, source: ["ps", ...psArguments].join(" ") });
      }
      return start;
    }),

    readProcessArguments: Effect.fn("platform.macos.readProcessArguments")(function* (pid: number) {
      return yield* runPs(psArgumentsForCommandLine(pid)).pipe(
        Effect.map((output) => Option.some(splitPsArguments(output))),
        Effect.catchTag("CommandFailed", (failed) =>
          failed.exitCode === PS_NO_SUCH_PROCESS_EXIT_CODE
            ? Effect.succeedNone
            : Effect.fail(failed),
        ),
      );
    }),

    readPidDomain: Effect.succeed(MACOS_PID_DOMAIN),

    claudeDesktopDirectory: Effect.gen(function* () {
      return Option.some(claudeDesktopDirectoryIn(yield* HOME));
    }),

    findWatchLimitReached: () => Effect.succeedNone,

    lockCodexBridge: (file: string) =>
      holdALock({
        file,
        heldElsewhereCodes: LOCKED_FILE_HELD_ELSEWHERE_CODES,
        lock: () =>
          open(file, constants.O_RDWR | constants.O_CREAT | constants.O_NONBLOCK | O_EXLOCK).then(
            (handle) => Effect.promise(() => handle.close()),
          ),
      }),
  };
};
