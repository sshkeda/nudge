import assert from "node:assert/strict";

import { Task } from "@sshkeda/task";
import { Duration, Effect, FileSystem, Ref, Schema } from "effect";
import type { PlatformError } from "effect";

import { makeSessionFileReader } from "../../src/lib/claude/internal/claude-discovery.ts";
import { readOnceItHasASocket } from "../../src/lib/claude/internal/claude-peer.ts";
import type { readClaudeSessionFile } from "../../src/lib/claude/internal/claude-session-files.ts";
import { ClaudeSessionFileUnreadable } from "../../src/lib/claude/internal/errors.ts";
import { platformLayer } from "../../src/lib/platform/index.ts";
import { Session } from "../../src/shared/session.ts";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

const OTHER_SESSION_ID = "22222222-2222-4222-8222-222222222222";

const PROCESS_START = "Fri Nov  6 01:00:00 2026";

const STARTED_AT = 1_793_944_800_000;

const NO_SUCH_PROCESS = 2_147_483_646;

const QUICK_ANSWER_MILLISECONDS = 2000;

const registrationFor = ({
  pid,
  socket,
  sessionId = SESSION_ID,
}: {
  readonly pid: number;
  readonly socket: string;
  readonly sessionId?: string;
}) =>
  Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
    pid,
    sessionId,
    name: "Socket Claude",
    startedAt: STARTED_AT,
    procStart: PROCESS_START,
    ...(socket === "" ? {} : { messagingSocketPath: socket }),
  });

export const waitingForAClaudeSocket = Task.make(
  "waiting-for-a-claude-socket",
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const readSessionFile = makeSessionFileReader(
        yield* Effect.context<Effect.Services<ReturnType<typeof readClaudeSessionFile>>>(),
      );
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      const socket = `${directory}/claude.sock`;
      const session = yield* Schema.decodeEffect(Session)({
        provider: "Claude",
        id: SESSION_ID,
        name: "Socket Claude",
        status: "idle",
        project: "",
        section: "",
        directory,
        transcript: "",
        lastActiveAt: "",
      });
      const registerWithoutASocket = (pid: number) =>
        Effect.gen(function* () {
          const registration = `${directory}/${pid}.json`;
          yield* fileSystem.writeFileString(
            registration,
            yield* registrationFor({ pid, socket: "" }),
          );
          return registration;
        });
      const readAndThen = ({
        reads,
        change,
      }: {
        readonly reads: number;
        readonly change: Effect.Effect<void, PlatformError.PlatformError>;
      }) =>
        Effect.map(
          Ref.make(0),
          (readCount) => (file: string) =>
            readSessionFile(file).pipe(
              Effect.tap(() =>
                Effect.flatMap(
                  Ref.updateAndGet(readCount, (count) => count + 1),
                  (count) => (count === reads ? change : Effect.void),
                ).pipe(
                  Effect.mapError(
                    (error) =>
                      new ClaudeSessionFileUnreadable({ path: file, reason: error.message }),
                  ),
                ),
              ),
            ),
        );

      const published = yield* registerWithoutASocket(process.pid);
      const withSocket = yield* registrationFor({ pid: process.pid, socket });
      const found = yield* readOnceItHasASocket({
        readSessionFile: yield* readAndThen({
          reads: 1,
          change: fileSystem.writeFileString(published, withSocket),
        }),
        registration: published,
        session,
      });
      assert.equal(found.messagingSocketPath, socket);

      const replacement = yield* registrationFor({
        pid: process.pid,
        socket,
        sessionId: OTHER_SESSION_ID,
      });
      const replaced = yield* readOnceItHasASocket({
        readSessionFile: yield* readAndThen({
          reads: 1,
          change: fileSystem.writeFileString(published, replacement),
        }),
        registration: yield* registerWithoutASocket(process.pid),
        session,
      }).pipe(
        Effect.as("read"),
        Effect.catchTag("ClaudeSessionEnded", () => Effect.succeed("ended")),
      );
      assert.equal(replaced, "ended");

      const claude = Bun.spawn(["sleep", "30"]);
      const [tookUntilExit, exitedFile] = yield* Effect.timed(
        readOnceItHasASocket({
          readSessionFile: yield* readAndThen({
            reads: 2,
            change: Effect.sync(() => {
              claude.kill();
            }),
          }),
          registration: yield* registerWithoutASocket(claude.pid),
          session,
        }),
      );
      assert.equal(exitedFile.messagingSocketPath, undefined);
      assert.ok(
        Duration.toMillis(tookUntilExit) < QUICK_ANSWER_MILLISECONDS,
        Duration.format(tookUntilExit),
      );

      const [took, endedFile] = yield* Effect.timed(
        readOnceItHasASocket({
          readSessionFile,
          registration: yield* registerWithoutASocket(NO_SUCH_PROCESS),
          session,
        }),
      );
      assert.equal(endedFile.messagingSocketPath, undefined);
      assert.ok(Duration.toMillis(took) < QUICK_ANSWER_MILLISECONDS, Duration.format(took));

      const missing = yield* readOnceItHasASocket({
        readSessionFile,
        registration: `${directory}/missing.json`,
        session,
      }).pipe(
        Effect.as("read"),
        Effect.catchTag("ClaudeSessionEnded", () => Effect.succeed("ended")),
      );
      assert.equal(missing, "ended");
    }).pipe(Effect.provide(platformLayer)),
  ),
);
