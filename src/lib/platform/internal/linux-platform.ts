import { once } from "node:events";
import { createServer } from "node:net";

import { Effect, FileSystem, Option, Schema } from "effect";
import type { PlatformError } from "effect";

import { InotifyWatchLimitReached } from "../../../shared/watch-errors.ts";
import { ProcessStartUnreadable } from "./errors.ts";
import { holdALock } from "./hold-a-lock.ts";

const CLOSING_PARENTHESIS_AND_SPACE_LENGTH = 2;

const START_TIME_FIELD_AFTER_COMMAND = 19;

const INOTIFY_WATCH_LIMIT_FILE = "/proc/sys/fs/inotify/max_user_watches";

const MACHINE_ID_FILE = "/etc/machine-id";

const PID_NAMESPACE_LINK = "/proc/self/ns/pid";

const ABSTRACT_SOCKET_HELD_ELSEWHERE_CODES: ReadonlySet<string> = new Set(["EADDRINUSE"]);

const decodeLimit = Schema.decodeEffect(Schema.fromJsonString(Schema.Int));

const processStatFile = (pid: number) => `/proc/${pid}/stat`;

const processCommandLineFile = (pid: number) => `/proc/${pid}/cmdline`;

export const readStartTimeFromStat = (stat: string) =>
  Option.fromNullishOr(
    stat.slice(stat.lastIndexOf(")") + CLOSING_PARENTHESIS_AND_SPACE_LENGTH).split(" ")[
      START_TIME_FIELD_AFTER_COMMAND
    ],
  ).pipe(Option.filter((field) => /^\d+$/u.test(field)));

export const splitCommandLine = (commandLine: string) =>
  commandLine === "" ? [] : commandLine.replace(/\0$/u, "").split("\0");

export const linuxPidDomain = ({
  machine,
  namespace,
}: {
  readonly machine: string;
  readonly namespace: string;
}) => `linux:${machine}:${namespace}`;

const readOrEmpty = (read: Effect.Effect<string, PlatformError.PlatformError>) =>
  read.pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed("")));

export const makeLinuxPlatform = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return {
    name: "linux" as const,

    codexDesktop: {
      node: "/usr/lib/chatgpt/resources/cua_node/bin/node",
      codex: "/usr/lib/chatgpt/resources/codex",
      listProcesses: ["ps", "-eo", "args="],
      process: /^(?:(?:\/usr\/bin\/)?chatgpt|\/usr\/lib\/chatgpt\/ChatGPT)(?:\s|$)/u,
      open: "nohup chatgpt > /dev/null 2>&1 &",
    },

    readProcessStart: Effect.fn("platform.linux.readProcessStart")(function* (pid: number) {
      const file = processStatFile(pid);
      const stat = yield* fileSystem.readFileString(file).pipe(
        Effect.asSome,
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
      );
      if (Option.isNone(stat)) {
        return Option.none();
      }
      const startTime = readStartTimeFromStat(stat.value);
      if (Option.isNone(startTime)) {
        return yield* new ProcessStartUnreadable({ pid, source: file });
      }
      return startTime;
    }),

    readProcessArguments: Effect.fn("platform.linux.readProcessArguments")(function* (pid: number) {
      return yield* fileSystem.readFileString(processCommandLineFile(pid)).pipe(
        Effect.map((commandLine) => Option.some(splitCommandLine(commandLine))),
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
      );
    }),

    readPidDomain: Effect.gen(function* () {
      const machine = yield* readOrEmpty(
        fileSystem.readFileString(MACHINE_ID_FILE).pipe(Effect.map((text) => text.trim())),
      );
      const namespace = yield* readOrEmpty(fileSystem.readLink(PID_NAMESPACE_LINK));
      return linuxPidDomain({ machine, namespace });
    }),

    claudeDesktopDirectory: Effect.succeedNone,

    findWatchLimitReached: (directory: string) =>
      fileSystem.readFileString(INOTIFY_WATCH_LIMIT_FILE).pipe(
        Effect.flatMap((text) => decodeLimit(text.trim())),
        Effect.map((limit) => Option.some(new InotifyWatchLimitReached({ directory, limit }))),
      ),

    lockCodexBridge: (file: string) =>
      holdALock({
        file,
        heldElsewhereCodes: ABSTRACT_SOCKET_HELD_ELSEWHERE_CODES,
        lock: () => {
          const server = createServer().listen(`\0${file}`);
          return once(server, "listening").then(() =>
            Effect.callback<void>((resume) => {
              server.close(() => {
                resume(Effect.void);
              });
            }),
          );
        },
      }),
  };
});
