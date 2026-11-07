import assert from "node:assert/strict";
import { createServer } from "node:net";
import type { Server } from "node:net";

import { Task } from "@sshkeda/task";
import { ConfigProvider, Deferred, Effect, FileSystem, Layer, Ref } from "effect";
import { TestClock } from "effect/testing";

import { CODEX_ANSWER_WAIT, callTool } from "../../src/lib/codex/internal/call-app-tool.ts";

const THREAD_ID = "01a1b000-0000-7000-8000-000000000001";

const JUST_BEFORE_THE_LIMIT = "59 seconds";

const THE_LAST_SECOND = "1 second";

const listenWithoutAnswering = (socket: string) =>
  Effect.gen(function* () {
    const connected = yield* Deferred.make<void>();
    yield* Effect.acquireRelease(
      Effect.callback<Server>((resume) => {
        const server = createServer(() => {
          Deferred.doneUnsafe(connected, Effect.void);
        });
        server.listen(socket, () => {
          resume(Effect.succeed(server));
        });
      }),
      (server) => Effect.sync(() => server.close()),
    );
    return connected;
  });

const stopsWaiting = ({
  call,
  expected,
}: {
  readonly call: Parameters<typeof callTool>[0]["call"];
  readonly expected: string;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const home = yield* fileSystem.makeTempDirectoryScoped({ directory: "/tmp" });
      const directory = `${home}/.local/state/nudge/codex`;
      yield* fileSystem.makeDirectory(directory, { recursive: true });
      const connected = yield* listenWithoutAnswering(`${directory}/codex.sock`);
      const isDone = yield* Ref.make(false);
      const calling = callTool({
        callerOutsideTasks: THREAD_ID,
        callId: "stopping-when-codex-does-not-answer",
        call,
      }).pipe(
        Effect.catchTag("CodexDidNotAnswer", (stopped) => Effect.succeed(stopped)),
        Effect.tap(() => Ref.set(isDone, true)),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: home }))),
      );
      const advancing = Effect.gen(function* () {
        yield* Deferred.await(connected);
        yield* TestClock.adjust(JUST_BEFORE_THE_LIMIT);
        assert.equal(yield* Ref.get(isDone), false, "nudge stopped waiting before the limit");
        yield* TestClock.adjust(THE_LAST_SECOND);
      });
      const [stopped] = yield* Effect.all([calling, advancing], { concurrency: "unbounded" });
      assert.ok(typeof stopped !== "string", "Codex answered although nothing replied");
      assert.equal(stopped.message, expected);
    }),
  ).pipe(Effect.provide(Layer.fresh(TestClock.layer())));

export const stoppingWhenCodexDoesNotAnswer = Task.make(
  "stopping-when-codex-does-not-answer",
  Effect.gen(function* () {
    assert.equal(CODEX_ANSWER_WAIT, "60 seconds");
    yield* stopsWaiting({
      call: {
        tool: "create_thread",
        toolArguments: { prompt: "hello", target: { type: "projectless" } },
      },
      expected:
        "Codex Desktop didn't answer within 60 seconds, so nudge stopped waiting. Codex may still start the session, so check nudge list before trying again. If Codex is stuck, restarting it usually helps.",
    });
    yield* stopsWaiting({
      call: {
        tool: "send_message_to_thread",
        toolArguments: { threadId: THREAD_ID, prompt: "hello" },
      },
      expected:
        "Codex Desktop didn't answer within 60 seconds, so nudge stopped waiting. Codex may still deliver the message, so check the session's transcript before sending again. If Codex is stuck, restarting it usually helps.",
    });
    yield* stopsWaiting({
      call: {
        tool: "set_thread_archived",
        toolArguments: { threadId: THREAD_ID, source: "codex", hostId: "local", archived: false },
      },
      expected:
        "Codex Desktop didn't answer within 60 seconds, so nudge stopped waiting. Codex may still unarchive the session, so check nudge list before trying again. If Codex is stuck, restarting it usually helps.",
    });
    yield* stopsWaiting({
      call: { tool: "list_projects", toolArguments: {} },
      expected:
        "Codex Desktop didn't answer within 60 seconds, so nudge stopped waiting. If Codex is stuck, restarting it usually helps.",
    });
  }),
);
