import { Effect, FileSystem, Option, Schema } from "effect";

import { callTool } from "./call-app-tool.ts";
import { CodexProjectsShareADirectory, CodexProjectsUnread } from "./errors.ts";

const Projects = Schema.fromJsonString(
  Schema.Struct({
    projects: Schema.Array(
      Schema.Struct({
        projectId: Schema.String,
        projectKind: Schema.String,
        path: Schema.optional(Schema.String),
      }),
    ),
  }),
);

const LOCAL_PROJECT = "local";

const realPathOf = (fileSystem: FileSystem.FileSystem, path: string) =>
  path === ""
    ? Effect.succeedNone
    : fileSystem.realPath(path).pipe(
        Effect.asSome,
        Effect.catchTag("PlatformError", () => Effect.succeedNone),
      );

const listLocalProjects = Effect.fn("codex.listLocalProjects")(function* (caller: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const listed = yield* callTool({
    callerOutsideTasks: caller,
    call: { tool: "list_projects", toolArguments: {} },
  }).pipe(
    Effect.flatMap((reply) => Schema.decodeEffect(Projects)(reply)),
    Effect.catchTags({
      CodexToolFailed: (failed) => Effect.fail(new CodexProjectsUnread({ reason: failed.message })),
      CodexDidNotAnswer: (stopped) =>
        Effect.fail(new CodexProjectsUnread({ reason: stopped.message })),
      SchemaError: () =>
        Effect.fail(
          new CodexProjectsUnread({
            reason: "Codex's list_projects tool replied in an unknown shape",
          }),
        ),
    }),
  );
  return yield* Effect.forEach(
    listed.projects.filter((project) => project.projectKind === LOCAL_PROJECT),
    (project) =>
      Effect.map(realPathOf(fileSystem, project.path ?? ""), (realPath) => ({
        id: project.projectId,
        path: project.path ?? "",
        realPath,
      })),
  );
});

export const chooseProject = Effect.fn("codex.chooseProject")(function* ({
  caller,
  here,
}: {
  readonly caller: string;
  readonly here: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const projects = yield* listLocalProjects(caller);
  const hereReal = Option.getOrElse(yield* realPathOf(fileSystem, here), () => here);
  const matches = projects.filter(({ realPath }) => Option.contains(realPath, hereReal));
  const [only] = matches;
  if (only === undefined) {
    return Option.none<{ readonly id: string; readonly path: string }>();
  }
  if (matches.length > 1) {
    return yield* new CodexProjectsShareADirectory({ directory: here, count: matches.length });
  }
  return Option.some({ id: only.id, path: only.path });
});
