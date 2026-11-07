import { Task } from "@sshkeda/task";
import type { BuildConfig, BunPlugin } from "bun";
import { Effect, FileSystem, Option, Schema } from "effect";

const DIST = new URL("../../dist/", import.meta.url).pathname;

const ENTRYPOINT = new URL("../../src/index.ts", import.meta.url).pathname;

const ROOT = new URL("../../", import.meta.url).pathname;

const BUILD_COMMIT_FILE = /\/src\/internal\/build-commit\.ts$/u;

const git = (words: readonly string[]) =>
  Task.exec("git", ["-C", ROOT, ...words]).pipe(Effect.map((output) => output.trim()));

export const readBuildCommit = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const topLevel = yield* git(["rev-parse", "--show-toplevel"]);
  const root = yield* fileSystem.realPath(ROOT);
  if (topLevel !== root) {
    return Option.none<string>();
  }
  return Option.some(yield* git(["describe", "--always", "--dirty", "--exclude=*", "--abbrev=7"]));
}).pipe(
  Effect.catchTags({
    CommandFailed: () => Effect.succeedNone,
    CommandNotStarted: () => Effect.succeedNone,
  }),
);

const stampBuildCommit = (commit: string): BunPlugin => ({
  name: "stamp-build-commit",
  setup: (build) => {
    build.onLoad({ filter: BUILD_COMMIT_FILE }, () => ({
      contents: `import { Option } from "effect";\nexport const BUILD_COMMIT = Option.some("${commit}");`,
      loader: "ts",
    }));
  },
});

const READ_NO_CONFIG_FROM_THE_WORKING_DIRECTORY = {
  autoloadDotenv: false,
  autoloadBunfig: false,
  autoloadTsconfig: false,
  autoloadPackageJson: false,
} as const;

class BuildFailed extends Schema.TaggedError<BuildFailed>()("BuildFailed", {
  entrypoint: Schema.String,
  errors: Schema.Array(Schema.String),
}) {
  public override get message() {
    return [`Bun couldn't build ${this.entrypoint}`, ...this.errors].join("\n");
  }
}

const bunBuild = ({
  entrypoint,
  ...config
}: Omit<BuildConfig, "entrypoints" | "throw"> & { readonly entrypoint: string }) =>
  Effect.tryPromise({
    try: () => Bun.build({ ...config, entrypoints: [entrypoint], throw: false }),
    catch: (cause) => new BuildFailed({ entrypoint, errors: [String(cause)] }),
  }).pipe(
    Effect.filterOrFail(
      (output) => output.success,
      (output) =>
        new BuildFailed({
          entrypoint,
          errors: output.logs
            .filter((log) => log.level === "error")
            .map((log) =>
              log.position === null
                ? log.message
                : `${log.position.file}:${log.position.line}: ${log.message}`,
            ),
        }),
    ),
  );

export const nudgeBuild = Task.make(
  "build-nudge",
  Effect.gen(function* () {
    const binary = `${DIST}nudge`;
    const commit = yield* readBuildCommit;
    yield* bunBuild({
      entrypoint: ENTRYPOINT,
      compile: { outfile: binary, ...READ_NO_CONFIG_FROM_THE_WORKING_DIRECTORY },
      plugins: Option.toArray(Option.map(commit, stampBuildCommit)),
    });
    yield* bunBuild({
      entrypoint: new URL("../../src/lib/codex-helper/index.ts", import.meta.url).pathname,
      target: "node",
      format: "esm",
      outdir: DIST,
      naming: "nudge-codex-desktop-helper.mjs",
    });
    return { binary, helper: `${DIST}nudge-codex-desktop-helper.mjs` };
  }),
);
