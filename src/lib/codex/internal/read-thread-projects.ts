import { Effect, FileSystem, Schema } from "effect";

const DesktopProjects = Schema.fromJsonString(
  Schema.Struct({
    "thread-project-assignments": Schema.optional(
      Schema.Record(Schema.String, Schema.Struct({ projectId: Schema.String })),
    ),
    "local-projects": Schema.optional(
      Schema.Record(Schema.String, Schema.Struct({ name: Schema.String })),
    ),
  }),
);

const readDesktopProjects = (root: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.readFileString(`${root}/.codex-global-state.json`).pipe(
      Effect.flatMap(Schema.decodeEffect(DesktopProjects)),
      Effect.catchTags({
        PlatformError: () => Effect.succeed<typeof DesktopProjects.Type>({}),
        SchemaError: () => Effect.succeed<typeof DesktopProjects.Type>({}),
      }),
    );
  });

export const readThreadProjects = Effect.fn("codex.readThreadProjects")(function* (root: string) {
  const projects = new Map<string, string>();
  const state = yield* readDesktopProjects(root);
  for (const [threadId, { projectId }] of Object.entries(
    state["thread-project-assignments"] ?? {},
  )) {
    const project = state["local-projects"]?.[projectId];
    if (project !== undefined) {
      projects.set(threadId, project.name);
    }
  }
  return projects;
});
