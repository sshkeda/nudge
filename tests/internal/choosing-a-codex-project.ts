import assert from "node:assert/strict";
import { createServer } from "node:net";
import type { Server } from "node:net";

import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import { Task } from "@sshkeda/task";
import { ConfigProvider, Effect, FileSystem, Option, Result, Schema } from "effect";

import { chooseProject } from "../../src/lib/codex/internal/choose-project.ts";
import { CodexProjectsShareADirectory } from "../../src/lib/codex/internal/errors.ts";
import { resultOf } from "../shared/failure-as-value.ts";

const CALLER = "01a1b000-0000-7000-8000-000000000003";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

const toolReply = ({ success, text }: { readonly success: boolean; readonly text: string }) =>
  encodeJson({ result: { success, contentItems: [{ text }] } });

const answerEveryCall = ({ socket, reply }: { readonly socket: string; readonly reply: string }) =>
  Effect.acquireRelease(
    Effect.callback<Server>((resume) => {
      const server = createServer((connection) => {
        connection.once("data", () => {
          connection.end(reply);
        });
      });
      server.listen(socket, () => {
        resume(Effect.succeed(server));
      });
    }),
    (server) => Effect.sync(() => server.close()),
  );

const choose = ({
  home,
  reply,
  here,
}: {
  readonly home: string;
  readonly reply: string;
  readonly here: string;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = `${home}/.local/state/nudge/codex`;
      yield* fileSystem.makeDirectory(directory, { recursive: true });
      const socket = `${directory}/codex.sock`;
      yield* fileSystem.remove(socket, { force: true });
      yield* answerEveryCall({ socket, reply });
      return yield* resultOf(chooseProject({ caller: CALLER, here })).pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: home }))),
      );
    }),
  );

const idOf = (
  chosen: Result.Result<Option.Option<{ readonly id: string }>, { readonly message: string }>,
) => {
  assert.ok(Result.isSuccess(chosen), Result.isFailure(chosen) ? chosen.failure.message : "");
  return Option.map(chosen.success, (found) => found.id);
};

const messageOf = <Success>(chosen: Result.Result<Success, { readonly message: string }>) => {
  assert.ok(Result.isFailure(chosen), "nudge chose a project although it shouldn't");
  return chosen.failure.message;
};

export const choosingACodexProject = Task.make(
  "choosing-a-codex-project",
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const home = yield* fileSystem.realPath(
        yield* fileSystem.makeTempDirectoryScoped({ directory: "/tmp" }),
      );
      const paths = {
        alpha: `${home}/alpha`,
        shared: `${home}/shared`,
        nowhere: `${home}/nowhere`,
      };
      for (const path of Object.values(paths)) {
        yield* fileSystem.makeDirectory(`${path}/inside`, { recursive: true });
      }
      const listed = yield* toolReply({
        success: true,
        text: yield* encodeJson({
          projects: [
            { projectId: "project-alpha", projectKind: "local", path: paths.alpha },
            { projectId: "project-shared-one", projectKind: "local", path: paths.shared },
            { projectId: "project-shared-two", projectKind: "local", path: paths.shared },
            { projectId: "project-remote", projectKind: "remote", path: paths.nowhere },
          ],
        }),
      });
      const chooseFrom = (here: string) => choose({ home, reply: listed, here });

      assert.deepEqual(idOf(yield* chooseFrom(paths.alpha)), Option.some("project-alpha"));
      assert.deepEqual(
        idOf(yield* chooseFrom(`${paths.alpha}/inside/..`)),
        Option.some("project-alpha"),
        "the current folder matches its project by its real path",
      );
      assert.deepEqual(
        idOf(yield* chooseFrom(`${paths.alpha}/inside`)),
        Option.none(),
        "a subfolder of a project isn't the project, so the session starts outside any project",
      );
      assert.deepEqual(
        idOf(yield* chooseFrom(paths.nowhere)),
        Option.none(),
        "a remote project's folder isn't a local project",
      );
      const shared = yield* chooseFrom(paths.shared);
      assert.equal(
        messageOf(shared),
        `2 Codex Desktop projects use ${paths.shared}, so nudge can't tell which one to start the session in. Remove the extra projects in Codex Desktop.`,
      );
      assert.ok(
        Result.isFailure(shared) && Schema.is(CodexProjectsShareADirectory)(shared.failure),
      );

      assert.equal(
        messageOf(
          yield* choose({
            home,
            reply: yield* toolReply({ success: false, text: "projects are unavailable" }),
            here: paths.alpha,
          }),
        ),
        "can't read Codex Desktop's projects, so nudge didn't start the session: Codex's list_projects tool failed: projects are unavailable",
      );
      assert.equal(
        messageOf(
          yield* choose({
            home,
            reply: yield* toolReply({ success: true, text: '{"folders":[]}' }),
            here: paths.alpha,
          }),
        ),
        "can't read Codex Desktop's projects, so nudge didn't start the session: Codex's list_projects tool replied in an unknown shape",
      );
    }),
  ).pipe(Effect.provide(BunCrypto.layerSecureRandom)),
);
