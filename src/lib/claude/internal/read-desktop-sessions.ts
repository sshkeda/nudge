import { Effect, FileSystem, Option, Result, Schema } from "effect";

import { toOneLine } from "../../../shared/print-line.ts";
import { NUDGE_CLAUDE_DESKTOP_DIRECTORY } from "../../../shared/read-environment.ts";
import { Platform } from "../../platform/index.ts";
import { ClaudeDesktopSessionUnreadable } from "./errors.ts";

const Identifier = Schema.String.check(Schema.isPattern(/^[\w-]+$/u));

const LATEST_DATE = 8_640_000_000_000_000;

const DesktopSessionFile = Schema.fromJsonString(
  Schema.Struct({
    sessionId: Identifier,
    cliSessionId: Schema.optional(Identifier),
    isArchived: Schema.optional(Schema.Boolean),
    title: Schema.optional(Schema.String),
    cwd: Schema.optional(Schema.String),
    originCwd: Schema.optional(Schema.String),
    lastActivityAt: Schema.Finite.check(
      Schema.isBetween({ minimum: -LATEST_DATE, maximum: LATEST_DATE }),
    ),
  }),
);

export const DesktopSession = Schema.Struct({
  sessionId: Schema.String,
  cliSessionId: Schema.Option(Schema.String),
  isArchived: Schema.Boolean,
  title: Schema.Option(Schema.String),
  directory: Schema.Option(Schema.String),
  originDirectory: Schema.Option(Schema.String),
  lastActivityAt: Schema.Finite,
});

const SESSIONS_DIRECTORY = "claude-code-sessions";

const nonEmpty = (value: string | undefined) =>
  Option.filter(Option.fromUndefinedOr(value), (text) => text.trim() !== "");

const isIdentifier = Schema.is(Identifier);

const listDirectories = ({
  fileSystem,
  directory,
}: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly directory: string;
}) =>
  Effect.gen(function* () {
    const names = yield* fileSystem
      .readDirectory(directory)
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])));
    return yield* Effect.filter(
      names
        .filter((name) => isIdentifier(name))
        .toSorted((left, right) => left.localeCompare(right)),
      (name) =>
        fileSystem.stat(`${directory}/${name}`).pipe(
          Effect.map((information) => information.type === "Directory"),
          Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
        ),
    );
  });

const readDesktopSessionFile = ({
  fileSystem,
  path,
}: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: string;
}) =>
  fileSystem.readFileString(path).pipe(
    Effect.flatMap(Schema.decodeEffect(DesktopSessionFile)),
    Effect.mapBoth({
      onFailure: (error) =>
        new ClaudeDesktopSessionUnreadable({ path, reason: toOneLine(error.message) }),
      onSuccess: (session) =>
        Result.succeed(
          DesktopSession.make({
            sessionId: session.sessionId,
            cliSessionId: Option.fromUndefinedOr(session.cliSessionId),
            isArchived: session.isArchived === true,
            title: Option.map(nonEmpty(session.title), (title) => title.trim()),
            directory: nonEmpty(session.cwd),
            originDirectory: nonEmpty(session.originCwd),
            lastActivityAt: session.lastActivityAt,
          }),
        ),
    }),
    Effect.catchTag("ClaudeDesktopSessionUnreadable", (unreadable) =>
      Effect.succeed(Result.fail(unreadable)),
    ),
  );

export const readDesktopSessions = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const chosen = yield* NUDGE_CLAUDE_DESKTOP_DIRECTORY;
  const found = Option.isSome(chosen) ? chosen : yield* (yield* Platform).claudeDesktopDirectory;
  if (Option.isNone(found)) {
    return [];
  }
  const root = `${found.value}/${SESSIONS_DIRECTORY}`;
  const accounts = yield* listDirectories({ fileSystem, directory: root });
  const organizations = yield* Effect.forEach(accounts, (account) =>
    Effect.map(listDirectories({ fileSystem, directory: `${root}/${account}` }), (names) =>
      names.map((organization) => `${root}/${account}/${organization}`),
    ),
  );
  const files = yield* Effect.forEach(organizations.flat(), (directory) =>
    Effect.map(fileSystem.readDirectory(directory), (names) =>
      names
        .filter((name) => name.startsWith("local_") && name.endsWith(".json"))
        .toSorted((left, right) => left.localeCompare(right))
        .map((name) => `${directory}/${name}`),
    ),
  );
  return yield* Effect.forEach(files.flat(), (path) =>
    readDesktopSessionFile({ fileSystem, path }),
  );
});
