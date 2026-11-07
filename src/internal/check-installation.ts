import { Effect, FileSystem, Option, Path, Result, Schema } from "effect";

import { version } from "../../package.json" with { type: "json" };
import { Platform } from "../lib/platform/index.ts";
import {
  CodexHelperReply,
  isBlockedByCodexSandbox,
  sendToCodexHelper,
} from "../shared/codex-helper.ts";
import { toOneLine } from "../shared/print-line.ts";
import {
  BUN_BIN_DIRECTORY,
  CLAUDE_CONFIG_DIRECTORY,
  CODEX_BRIDGE_SOCKET,
  CODEX_HOME,
  HOME,
  PATH,
} from "../shared/read-environment.ts";
import {
  homePath,
  messageOf,
  prose,
  quoteForShell,
  Report,
  showOnTerminal,
} from "../shared/report.ts";
import type { Audience, Shown } from "../shared/report.ts";
import { runCommand } from "../shared/run-command.ts";

const HELPER_DEADLINE = "5 seconds";

const PIPE_PATH_VARIABLE = "CODEX_APP_TOOLS_PIPE_PATH";

const ACCEPT_LINE = '"crossSessionInbound": "accept"';

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

const decodeHelperReply = Schema.decodeOption(Schema.fromJsonString(CodexHelperReply));

const CodexConfig = Schema.Struct({
  mcp_servers: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

const CodexEntry = Schema.Struct({
  command: Schema.String,
  args: Schema.Array(Schema.String),
  env_vars: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  enabled: Schema.optional(Schema.Boolean),
});

const ClaudeUserConfig = Schema.fromJsonString(
  Schema.Struct({ crossSessionInbound: Schema.optional(Schema.Json) }),
);

class ConfigUnreadable extends Schema.TaggedError<ConfigUnreadable>()("ConfigUnreadable", {
  reason: Schema.String,
}) {
  public override get message() {
    return this.reason;
  }
}

class InstallationFileUncheckable extends Schema.TaggedError<InstallationFileUncheckable>()(
  "InstallationFileUncheckable",
  { path: Schema.String, reason: Schema.String },
) {
  public get report(): Report {
    return new Report({
      message: prose`nudge doctor can't tell whether ${homePath(this.path)} exists: ${this.reason}`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

const fileExists = (path: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem
      .exists(path)
      .pipe(
        Effect.mapError(
          (error) => new InstallationFileUncheckable({ path, reason: toOneLine(error.message) }),
        ),
      );
  });

const row = ({
  id,
  passes,
  summary,
  hint = [],
}: {
  readonly id: string;
  readonly passes: boolean;
  readonly summary: Shown;
  readonly hint?: readonly string[];
}) => ({ id, passes, summary, hint: passes ? [] : hint });

const readOptionalFile = (file: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.readFileString(file).pipe(
      Effect.asSome,
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
      Effect.mapError((error) => new ConfigUnreadable({ reason: error.message })),
    );
  });

const readCodexServers = (file: string) =>
  Effect.gen(function* () {
    const text = yield* readOptionalFile(file);
    if (Option.isNone(text)) {
      return {};
    }
    const parsed = yield* Effect.try({
      try: () => Bun.TOML.parse(text.value),
      catch: (error) =>
        new ConfigUnreadable({ reason: error instanceof Error ? error.message : String(error) }),
    });
    const config = yield* Schema.decodeEffect(CodexConfig)(parsed).pipe(
      Effect.mapError(() => new ConfigUnreadable({ reason: "mcp_servers isn't a table" })),
    );
    return config.mcp_servers ?? {};
  });

const attemptRead = <Value, Requirements>(
  read: Effect.Effect<Value, ConfigUnreadable, Requirements>,
) =>
  read.pipe(
    Effect.map((value): Result.Result<Value, ConfigUnreadable> => Result.succeed(value)),
    Effect.catchTag("ConfigUnreadable", (unreadable) => Effect.succeed(Result.fail(unreadable))),
  );

const codexSnippet = (expected: { readonly command: string; readonly script: string }) =>
  Effect.gen(function* () {
    return [
      "[mcp_servers.nudge]",
      `command = ${yield* encodeJson(expected.command)}`,
      `args = [${yield* encodeJson(expected.script)}]`,
      `env_vars = ["${PIPE_PATH_VARIABLE}"]`,
    ];
  });

const isExpectedEntry = (
  entry: typeof CodexEntry.Type,
  expected: { readonly command: string; readonly script: string },
) =>
  entry.enabled !== false &&
  entry.command === expected.command &&
  entry.args.length === 1 &&
  entry.args[0] === expected.script &&
  (entry.env_vars ?? []).includes(PIPE_PATH_VARIABLE);

const pathInShell = (directory: string, home: string) =>
  directory.startsWith(`${home}/`)
    ? `"$HOME"/${quoteForShell(directory.slice(home.length + 1))}`
    : quoteForShell(directory);

const checkPath = ({ root, home }: { readonly root: string; readonly home: string }) =>
  Effect.gen(function* () {
    const found = Bun.which("nudge", { PATH: yield* PATH });
    if (found !== null) {
      return row({
        id: "path",
        passes: true,
        summary: prose`nudge is on PATH at ${homePath(found)}`,
      });
    }
    const bunBin = yield* BUN_BIN_DIRECTORY;
    const isLinked = yield* fileExists(`${bunBin}/nudge`);
    return row({
      id: "path",
      passes: false,
      summary: prose`nudge isn't on PATH`,
      hint: [
        isLinked
          ? `export PATH=${pathInShell(bunBin, home)}:"$PATH"`
          : `cd ${quoteForShell(root)} && bun link`,
      ],
    });
  });

const resolvedPath = (file: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem
      .realPath(file)
      .pipe(Effect.catchTag("PlatformError", () => Effect.succeed(file)));
  });

const resolveEntryPaths = (entry: typeof CodexEntry.Type) =>
  Effect.gen(function* () {
    const resolvedArguments = yield* Effect.forEach(entry.args, (file) => resolvedPath(file));
    return { ...entry, args: resolvedArguments };
  });

const checkCodexEntry = Effect.fn("doctor.checkCodexEntry")(function* ({
  config,
  servers,
  snippet,
  expected,
}: {
  readonly config: string;
  readonly servers: Result.Result<
    Effect.Success<ReturnType<typeof readCodexServers>>,
    ConfigUnreadable
  >;
  readonly snippet: readonly string[];
  readonly expected: {
    readonly command: string;
    readonly script: string;
  };
}) {
  if (Result.isFailure(servers)) {
    return row({
      id: "codex.entry",
      passes: false,
      summary: prose`can't read ${homePath(config)}: ${servers.failure.reason}`,
      hint: [`Fix the TOML syntax in ${config}, then run nudge doctor again.`],
    });
  }
  const raw = servers.success["nudge"];
  if (raw === undefined) {
    return row({
      id: "codex.entry",
      passes: false,
      summary: prose`${homePath(config)} has no [mcp_servers.nudge] entry`,
      hint: [`Add this to ${config}, then restart Codex Desktop:`, ...snippet],
    });
  }
  const entry = Schema.decodeUnknownOption(CodexEntry)(raw);
  const matches =
    Option.isSome(entry) && isExpectedEntry(yield* resolveEntryPaths(entry.value), expected);
  return row({
    id: "codex.entry",
    passes: matches,
    summary: matches
      ? prose`${homePath(config)} registers this nudge's MCP server`
      : prose`${homePath(config)}'s [mcp_servers.nudge] entry doesn't point at this nudge`,
    hint: [
      `Replace the [mcp_servers.nudge] entry in ${config} with this, then restart Codex Desktop:`,
      ...snippet,
    ],
  });
});

const checkLegacyEntry = ({
  config,
  servers,
}: {
  readonly config: string;
  readonly servers: Effect.Success<ReturnType<typeof readCodexServers>>;
}) => {
  const hasLegacy = servers["codex_app"] !== undefined;
  return row({
    id: "codex.legacy",
    passes: !hasLegacy,
    summary: hasLegacy
      ? prose`${homePath(config)} still has the [mcp_servers.codex_app] entry from an older nudge`
      : prose`${homePath(config)} has no [mcp_servers.codex_app] entry from an older nudge`,
    hint: [`Remove the [mcp_servers.codex_app] entry from ${config}, then restart Codex Desktop.`],
  });
};

const checkHelperFile = ({
  directory,
  root,
  file,
}: {
  readonly directory: string;
  readonly root: string;
  readonly file: string;
}) =>
  Effect.gen(function* () {
    const exists = yield* fileExists(file);
    return row({
      id: "codex.files",
      passes: exists,
      summary: exists
        ? prose`nudge's Codex helper is in ${homePath(directory)}`
        : prose`nudge's Codex helper is missing: ${homePath(file)}`,
      hint: [`cd ${quoteForShell(root)} && bun scripts/build.ts`],
    });
  });

const findCodexDesktop = Effect.gen(function* () {
  const { codexDesktop } = yield* Platform;
  const [program = "", ...programArguments] = codexDesktop.listProcesses;
  const listing = yield* runCommand(program, programArguments, {
    environment: { LC_ALL: "C" },
  }).pipe(
    Effect.map((text) => Result.succeed(text)),
    Effect.catchTags({
      CommandFailed: (failed) => Effect.succeed(Result.fail(failed.message)),
      PlatformError: (failed) => Effect.succeed(Result.fail(failed.message)),
    }),
  );
  return Result.map(listing, (text) =>
    text.split("\n").some((line) => codexDesktop.process.test(line.trim())),
  );
});

const askCodexHelper = (socket: string) =>
  sendToCodexHelper({ socket, request: '{"method":"nudge/doctor"}' }).pipe(
    Effect.map((reply) => (Option.isSome(decodeHelperReply(reply)) ? "answers" : "garbled")),
    Effect.timeoutOption(HELPER_DEADLINE),
    Effect.map(Option.getOrElse(() => "silent")),
    Effect.catchTags({
      CodexHelperClosedWithoutReply: () => Effect.succeed("silent"),
      CodexHelperUnreachable: (unreachable) =>
        Effect.map(isBlockedByCodexSandbox(unreachable), (isBlocked) =>
          isBlocked ? "sandboxed" : "unreachable",
        ),
    }),
  );

const checkCodexHelper = ({
  socket,
  running,
  entryPasses,
  open,
}: {
  readonly socket: string;
  readonly running: boolean;
  readonly entryPasses: boolean;
  readonly open: string;
}) =>
  Effect.gen(function* () {
    const answer = yield* askCodexHelper(socket);
    if (answer === "sandboxed") {
      return row({
        id: "codex.helper",
        passes: false,
        summary: prose`Codex's sandbox blocks nudge from reaching its Codex helper at ${homePath(socket)}`,
        hint: ["Run nudge doctor outside Codex's sandbox."],
      });
    }
    const restart = entryPasses
      ? "Quit and reopen Codex Desktop so it loads nudge's MCP server."
      : "Fix Codex's nudge MCP entry above, then quit and reopen Codex Desktop.";
    return row({
      id: "codex.helper",
      passes: answer === "answers",
      summary:
        answer === "answers"
          ? prose`nudge's Codex helper answers at ${homePath(socket)}`
          : prose`nudge's Codex helper doesn't answer at ${homePath(socket)}`,
      hint: [running ? restart : open],
    });
  });

const checkClaudeInbound = (file: string) =>
  Effect.gen(function* () {
    const restart = "then restart Claude Code:";
    const text = yield* attemptRead(readOptionalFile(file));
    if (Result.isFailure(text)) {
      return row({
        id: "claude.inbound",
        passes: false,
        summary: prose`can't read ${homePath(file)}: ${text.failure.reason}`,
        hint: [`Make ${file} readable, then run nudge doctor again.`],
      });
    }
    if (Option.isNone(text.success)) {
      return row({
        id: "claude.inbound",
        passes: false,
        summary: prose`Claude Code doesn't accept messages from other sessions because ${homePath(file)} doesn't exist`,
        hint: [`Create ${file} with this, ${restart}`, `{ ${ACCEPT_LINE} }`],
      });
    }
    const decoded = Schema.decodeOption(ClaudeUserConfig)(text.success.value);
    if (Option.isNone(decoded)) {
      return row({
        id: "claude.inbound",
        passes: false,
        summary: prose`can't read ${homePath(file)} because it isn't a JSON object`,
        hint: [`Fix the JSON syntax in ${file}, then run nudge doctor again.`],
      });
    }
    const inbound = decoded.value.crossSessionInbound;
    const accepts = inbound === "accept";
    const current = inbound === undefined ? "isn't set" : `is ${yield* encodeJson(inbound)}`;
    return row({
      id: "claude.inbound",
      passes: accepts,
      summary: accepts
        ? prose`Claude Code accepts messages from other sessions`
        : prose`Claude Code doesn't accept messages from other sessions because crossSessionInbound ${current} in ${homePath(file)}`,
      hint: [`Set this in the top-level object of ${file}, ${restart}`, ACCEPT_LINE],
    });
  });

export const checkInstallation = Effect.gen(function* () {
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const { codexDesktop } = yield* Platform;
  const home = yield* HOME;
  const executable = yield* fileSystem
    .realPath(process.execPath)
    .pipe(Effect.catchTag("PlatformError", () => Effect.succeed(process.execPath)));
  const directory = path.dirname(executable);
  const root = path.dirname(directory);
  const script = path.join(directory, "nudge-codex-desktop-helper.mjs");
  const expected = { command: codexDesktop.node, script };
  const config = path.join(yield* CODEX_HOME, "config.toml");
  const servers = yield* attemptRead(readCodexServers(config));
  const entry = yield* checkCodexEntry({
    config,
    servers,
    snippet: yield* codexSnippet(expected),
    expected,
  });
  const running = yield* findCodexDesktop;
  const isRunning = Result.isSuccess(running) && running.success;
  return [
    yield* checkPath({ root, home }),
    entry,
    ...(Result.isSuccess(servers) ? [checkLegacyEntry({ config, servers: servers.success })] : []),
    yield* checkHelperFile({ directory, root, file: script }),
    row({
      id: "codex.desktop",
      passes: isRunning,
      summary: Result.isFailure(running)
        ? prose`can't tell whether Codex Desktop is running: ${running.failure}`
        : prose`Codex Desktop ${isRunning ? "is" : "isn't"} running`,
      hint: [codexDesktop.open],
    }),
    yield* checkCodexHelper({
      socket: yield* CODEX_BRIDGE_SOCKET,
      running: isRunning,
      entryPasses: entry.passes,
      open: codexDesktop.open,
    }),
    yield* checkClaudeInbound(path.join(yield* CLAUDE_CONFIG_DIRECTORY, "settings.json")),
  ];
});

export const describeInstallation = (
  rows: Effect.Success<typeof checkInstallation>,
  audience: typeof Audience.Type,
) => ({
  shown: rows
    .map((checked) =>
      [
        `${checked.passes ? "ok" : "error"}: ${checked.summary.show(audience)}`,
        ...checked.hint.map(
          (line, index) => `${index === 0 ? "hint: " : ""}${showOnTerminal(line)}`,
        ),
      ].join("\n"),
    )
    .join("\n"),
  json: {
    nudgeVersion: version,
    status: rows.every((checked) => checked.passes) ? "ok" : "error",
    checks: rows.map((checked) => ({
      id: checked.id,
      status: checked.passes ? "ok" : "error",
      summary: checked.summary.show(audience),
      hint: checked.hint.length === 0 ? null : checked.hint.join("\n"),
    })),
  },
});
