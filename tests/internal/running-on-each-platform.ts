import assert from "node:assert/strict";

import { BunServices } from "@effect/platform-bun";
import { Task } from "@sshkeda/task";
import { ConfigProvider, Effect, Exit, FileSystem, Layer, Option, PlatformError } from "effect";

import { thisMachine } from "../../scripts/lib/platform/index.ts";
import { BUN, PROJECT } from "../../scripts/shared/codex-and-claude.ts";
import { runShell } from "../../scripts/shared/run-shell.ts";
import { Platform, platformLayer } from "../../src/lib/platform/index.ts";
import { makeLinuxPlatform } from "../../src/lib/platform/internal/linux-platform.ts";
import { makeMacosPlatform } from "../../src/lib/platform/internal/macos-platform.ts";
import { CommandFailed, runCommand } from "../../src/shared/run-command.ts";
import { exitOf } from "../shared/failure-as-value.ts";

const PID = 4242;

const STAT_FILE = `/proc/${PID}/stat`;

const COMMAND_LINE_FILE = `/proc/${PID}/cmdline`;

const START_TIME = "98765";

const FIELDS_BEFORE_START_TIME = 18;

const statWithStart = ({ command, start }: { readonly command: string; readonly start: string }) =>
  [
    `${PID} (${command}) S`,
    ...[...Array.from({ length: FIELDS_BEFORE_START_TIME }).keys()].map((index) =>
      String(index + 1),
    ),
    start,
    "1234",
    "5678\n",
  ].join(" ");

const LINUX_STATS = [
  { stat: statWithStart({ command: "claude", start: START_TIME }), start: START_TIME },
  { stat: statWithStart({ command: "a) S (b", start: START_TIME }), start: START_TIME },
  { stat: statWithStart({ command: "two words", start: "1" }), start: "1" },
] as const;

const UNREADABLE_LINUX_STATS = [
  `${PID} (claude) S 1 2 3`,
  statWithStart({ command: "claude", start: "soon" }),
  "",
] as const;

const LINUX_COMMAND_LINES = [
  {
    commandLine: "claude\0--bg\0--no-session-persistence\0",
    words: ["claude", "--bg", "--no-session-persistence"],
  },
  { commandLine: "node\0two words\0\0last\0", words: ["node", "two words", "", "last"] },
  { commandLine: "claude", words: ["claude"] },
  { commandLine: "", words: [] },
] as const;

const PS_STARTS = [
  { output: "Fri Oct 23 19:50:01 2026\n", start: "Fri Oct 23 19:50:01 2026" },
  { output: "  Mon Jan  5 03:04:05 2026  \n", start: "Mon Jan  5 03:04:05 2026" },
] as const;

const PS_ARGUMENTS = [
  {
    output: "/usr/local/bin/claude --bg --no-session-persistence\n",
    words: ["/usr/local/bin/claude", "--bg", "--no-session-persistence"],
  },
  { output: "  claude   --resume\tabc  \n", words: ["claude", "--resume", "abc"] },
  { output: "claude\n", words: ["claude"] },
  { output: "\n", words: [] },
  { output: "", words: [] },
] as const;

const PS_START_ARGUMENTS = ["-o", "lstart=", "-p", String(PID)];

const PS_COMMAND_LINE_ARGUMENTS = ["-ww", "-o", "args=", "-p", String(PID)];

const PS_NO_SUCH_PROCESS = 1;

const PS_BAD_OPTION = 2;

const PS_START_FORMAT = /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/u;

const WATCH_LIMIT = 8192;

const MACOS_HOME = "/Users/someone";

const notFound = (method: string, path: string) =>
  PlatformError.systemError({
    _tag: "NotFound",
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
  });

const PERMISSION_DENIED = "permission denied";

const fakeFiles = ({
  files,
  links = {},
}: {
  readonly files: Readonly<Record<string, string>>;
  readonly links?: Readonly<Record<string, string>>;
}) =>
  FileSystem.layerNoop({
    readFileString: (path) => {
      const text = files[path];
      if (text === PERMISSION_DENIED) {
        return Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "readFileString",
            pathOrDescriptor: path,
          }),
        );
      }
      return text === undefined
        ? Effect.fail(notFound("readFileString", path))
        : Effect.succeed(text);
    },
    readLink: (path) => {
      const target = links[path];
      return target === undefined
        ? Effect.fail(notFound("readLink", path))
        : Effect.succeed(target);
    },
  });

const runLinux = <Value, Failure>({
  files,
  links,
  check,
}: {
  readonly files: Readonly<Record<string, string>>;
  readonly links?: Readonly<Record<string, string>>;
  readonly check: Effect.Effect<Value, Failure, Platform>;
}) =>
  check.pipe(
    Effect.provide(
      Layer.effect(Platform, makeLinuxPlatform).pipe(
        Layer.provide(fakeFiles({ files, ...(links && { links }) })),
      ),
    ),
    exitOf,
  );

const fakePs =
  ({
    psArguments,
    output,
    exitCode = 0,
  }: {
    readonly psArguments: readonly string[];
    readonly output: string;
    readonly exitCode?: number;
  }): Parameters<typeof makeMacosPlatform>[0] =>
  (name, commandArguments, commandOptions) =>
    Effect.suspend(() => {
      assert.equal(name, "ps");
      assert.deepEqual(commandArguments, psArguments);
      assert.ok(commandOptions?.environment);
      assert.equal(commandOptions.environment["LC_ALL"], "C");
      assert.equal(commandOptions.environment["TZ"], "UTC");
      return exitCode === 0
        ? Effect.succeed(output)
        : Effect.fail(
            new CommandFailed({
              command: [name, ...commandArguments],
              exitCode,
              standardError: "ps: no such process",
            }),
          );
    });

const runMacos = <Value, Failure>({
  ps,
  check,
}: {
  readonly ps: Parameters<typeof fakePs>[0];
  readonly check: Effect.Effect<Value, Failure, Platform>;
}) =>
  check.pipe(
    Effect.provide([
      Layer.succeed(Platform, makeMacosPlatform(fakePs(ps))),
      ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: MACOS_HOME })),
    ]),
    exitOf,
  );

const failureOf = <Value, Failure>(exit: Exit.Exit<Value, Failure>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Exit.findErrorOption(exit)) : undefined;

const readStart = Effect.gen(function* () {
  return yield* (yield* Platform).readProcessStart(PID);
});

const readArguments = Effect.gen(function* () {
  return yield* (yield* Platform).readProcessArguments(PID);
});

const readPidDomain = Effect.gen(function* () {
  return yield* (yield* Platform).readPidDomain;
});

const checkTheLinuxLayer = Effect.gen(function* () {
  for (const { stat, start } of LINUX_STATS) {
    assert.deepEqual(
      yield* runLinux({ files: { [STAT_FILE]: stat }, check: readStart }),
      Exit.succeed(Option.some(start)),
      stat,
    );
  }
  for (const stat of UNREADABLE_LINUX_STATS) {
    const failure = failureOf(yield* runLinux({ files: { [STAT_FILE]: stat }, check: readStart }));
    assert.equal(failure?._tag, "ProcessStartUnreadable", stat);
    assert.equal(failure.message, `${STAT_FILE} shows no start time for process ${PID}`);
  }
  assert.deepEqual(yield* runLinux({ files: {}, check: readStart }), Exit.succeed(Option.none()));
  const deniedStart = failureOf(
    yield* runLinux({ files: { [STAT_FILE]: PERMISSION_DENIED }, check: readStart }),
  );
  assert.equal(deniedStart?._tag, "PlatformError");

  for (const { commandLine, words } of LINUX_COMMAND_LINES) {
    assert.deepEqual(
      yield* runLinux({ files: { [COMMAND_LINE_FILE]: commandLine }, check: readArguments }),
      Exit.succeed(Option.some(words)),
      commandLine,
    );
  }
  assert.deepEqual(
    yield* runLinux({ files: {}, check: readArguments }),
    Exit.succeed(Option.none()),
  );
  const deniedArguments = failureOf(
    yield* runLinux({ files: { [COMMAND_LINE_FILE]: PERMISSION_DENIED }, check: readArguments }),
  );
  assert.equal(deniedArguments?._tag, "PlatformError");

  assert.deepEqual(
    yield* runLinux({
      files: { "/etc/machine-id": "0123abcd\n" },
      links: { "/proc/self/ns/pid": "pid:[4026531836]" },
      check: readPidDomain,
    }),
    Exit.succeed("linux:0123abcd:pid:[4026531836]"),
  );
  assert.deepEqual(yield* runLinux({ files: {}, check: readPidDomain }), Exit.succeed("linux::"));

  const others = yield* runLinux({
    files: { "/proc/sys/fs/inotify/max_user_watches": `${WATCH_LIMIT}\n` },
    check: Effect.gen(function* () {
      const platform = yield* Platform;
      return {
        name: platform.name,
        desktop: yield* platform.claudeDesktopDirectory,
        limitReached: yield* platform.findWatchLimitReached("/home/someone/.claude"),
      };
    }),
  });
  assert.ok(Exit.isSuccess(others));
  assert.equal(others.value.name, "linux");
  assert.deepEqual(others.value.desktop, Option.none());
  assert.ok(Option.isSome(others.value.limitReached));
  assert.equal(others.value.limitReached.value._tag, "InotifyWatchLimitReached");
  assert.equal(others.value.limitReached.value.directory, "/home/someone/.claude");
  assert.equal(others.value.limitReached.value.limit, WATCH_LIMIT);

  const unreadableLimit = failureOf(
    yield* runLinux({
      files: { "/proc/sys/fs/inotify/max_user_watches": "lots\n" },
      check: Effect.gen(function* () {
        return yield* (yield* Platform).findWatchLimitReached("/tmp");
      }),
    }),
  );
  assert.equal(unreadableLimit?._tag, "SchemaError");
});

const checkTheMacosLayer = Effect.gen(function* () {
  for (const { output, start } of PS_STARTS) {
    assert.deepEqual(
      yield* runMacos({ ps: { psArguments: PS_START_ARGUMENTS, output }, check: readStart }),
      Exit.succeed(Option.some(start)),
      output,
    );
  }
  for (const output of ["", "  \n"]) {
    const failure = failureOf(
      yield* runMacos({ ps: { psArguments: PS_START_ARGUMENTS, output }, check: readStart }),
    );
    assert.equal(failure?._tag, "ProcessStartUnreadable");
    assert.equal(failure.message, `ps -o lstart= -p ${PID} shows no start time for process ${PID}`);
  }
  assert.deepEqual(
    yield* runMacos({
      ps: { psArguments: PS_START_ARGUMENTS, output: "", exitCode: PS_NO_SUCH_PROCESS },
      check: readStart,
    }),
    Exit.succeed(Option.none()),
  );
  const badStart = failureOf(
    yield* runMacos({
      ps: { psArguments: PS_START_ARGUMENTS, output: "", exitCode: PS_BAD_OPTION },
      check: readStart,
    }),
  );
  assert.equal(badStart?._tag, "CommandFailed");
  assert.equal(badStart.exitCode, PS_BAD_OPTION);

  for (const { output, words } of PS_ARGUMENTS) {
    assert.deepEqual(
      yield* runMacos({
        ps: { psArguments: PS_COMMAND_LINE_ARGUMENTS, output },
        check: readArguments,
      }),
      Exit.succeed(Option.some(words)),
      output,
    );
  }
  assert.deepEqual(
    yield* runMacos({
      ps: { psArguments: PS_COMMAND_LINE_ARGUMENTS, output: "", exitCode: PS_NO_SUCH_PROCESS },
      check: readArguments,
    }),
    Exit.succeed(Option.none()),
  );
  const badPs = failureOf(
    yield* runMacos({
      ps: { psArguments: PS_COMMAND_LINE_ARGUMENTS, output: "", exitCode: PS_BAD_OPTION },
      check: readArguments,
    }),
  );
  assert.equal(badPs?._tag, "CommandFailed");
  assert.equal(badPs.exitCode, PS_BAD_OPTION);

  const others = yield* runMacos({
    ps: { psArguments: [], output: "" },
    check: Effect.gen(function* () {
      const platform = yield* Platform;
      return {
        name: platform.name,
        pidDomain: yield* platform.readPidDomain,
        desktop: yield* platform.claudeDesktopDirectory,
        limitReached: yield* platform.findWatchLimitReached("/Users/someone/.claude"),
      };
    }),
  });
  assert.deepEqual(
    others,
    Exit.succeed({
      name: "macos",
      pidDomain: "darwin",
      desktop: Option.some(`${MACOS_HOME}/Library/Application Support/Claude`),
      limitReached: Option.none(),
    }),
  );
});

const startEndedProcess = runShell("true & echo $!; wait").pipe(
  Effect.map((output) => Number(output.trim())),
);

const readOwnProcessWithPs = Effect.gen(function* () {
  const platform = yield* Platform;
  assert.equal(platform.name, "macos");
  const start = yield* platform.readProcessStart(process.pid);
  assert.ok(Option.isSome(start));
  assert.match(start.value, PS_START_FORMAT);
  assert.deepEqual(yield* platform.readProcessStart(process.pid), start);
  assert.deepEqual(yield* platform.readProcessStart(yield* startEndedProcess), Option.none());
  assert.deepEqual(yield* platform.readProcessArguments(yield* startEndedProcess), Option.none());
  const words = yield* platform.readProcessArguments(process.pid);
  assert.ok(Option.isSome(words));
  assert.ok(words.value.length > 0);
  return words.value;
});

const lockInAProcessOfItsOwn = (
  file: string,
) => `cd '${PROJECT}' && LOCK_FILE='${file}' '${BUN}' -e '
    import { BunServices } from "@effect/platform-bun";
    import { Effect, Layer, Option } from "effect";
    import { Platform, platformLayer } from "./src/lib/platform/index.ts";
    const file = process.env.LOCK_FILE;
    const releaseIfHeld = (lock) => Option.match(lock, { onNone: () => Effect.void, onSome: (held) => held.release });
    const check = Effect.gen(function* () {
      const platform = yield* Platform;
      const first = yield* platform.lockCodexBridge(file);
      const second = yield* platform.lockCodexBridge(file);
      yield* releaseIfHeld(first);
      const again = yield* platform.lockCodexBridge(file);
      yield* releaseIfHeld(again);
      return [first, second, again].map(Option.isSome).join(" ");
    });
    console.log(await Effect.runPromise(check.pipe(Effect.provide(platformLayer.pipe(Layer.provide(BunServices.layer))))));'`;

const checkTheNativeLayer = (wordsFromPs: readonly string[]) =>
  Effect.gen(function* () {
    const native = yield* Platform;
    assert.deepEqual(yield* native.readProcessArguments(process.pid), Option.some(wordsFromPs));
    assert.deepEqual(yield* native.readProcessArguments(yield* startEndedProcess), Option.none());
    const start = yield* native.readProcessStart(process.pid);
    assert.deepEqual(yield* native.readProcessStart(process.pid), start);
    assert.deepEqual(yield* native.readProcessStart(yield* startEndedProcess), Option.none());
    const machine = yield* thisMachine;
    assert.ok(Option.isSome(start));
    assert.match(start.value, machine.processStartFormat);
    assert.match(yield* native.readPidDomain, machine.pidDomainFormat);
    const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
      directory: "/tmp",
    });
    const file = `${directory}/codex.lock`;
    assert.equal((yield* runShell(lockInAProcessOfItsOwn(file))).trim(), "true false true");
  });

export const runningOnEachPlatform = Task.make(
  "running-on-each-platform",
  Effect.scoped(
    Effect.gen(function* () {
      yield* checkTheLinuxLayer;
      yield* checkTheMacosLayer;
      const wordsFromPs = yield* readOwnProcessWithPs.pipe(
        Effect.provide(
          Layer.succeed(
            Platform,
            makeMacosPlatform((...runArguments) =>
              runCommand(...runArguments).pipe(Effect.provide(BunServices.layer)),
            ),
          ),
        ),
      );
      yield* checkTheNativeLayer(wordsFromPs).pipe(
        Effect.provide(platformLayer.pipe(Layer.provide(BunServices.layer))),
      );
    }),
  ),
  { timeout: "1 minute", cleanup: "1 minute" },
);
