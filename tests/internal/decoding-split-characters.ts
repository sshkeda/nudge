import assert from "node:assert/strict";
import { createServer } from "node:net";

import { Task } from "@sshkeda/task";
import { Effect, FileSystem } from "effect";

import { sendToCodexHelper } from "../../src/shared/codex-helper.ts";

const THREE_BYTE_CHARACTERS = 400_000;

const REPLY = `{"result":{},"padding":"${"€".repeat(THREE_BYTE_CHARACTERS)}"}`;

const listenOn = (socket: string) =>
  Effect.acquireRelease(
    Effect.callback<ReturnType<typeof createServer>>((resume) => {
      const server = createServer((client) => {
        client.once("data", () => {
          client.end(REPLY);
        });
      });
      server.listen(socket, () => {
        resume(Effect.succeed(server));
      });
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => {
          resume(Effect.void);
        });
      }),
  );

export const decodingSplitCharacters = Task.make(
  "decoding-split-characters",
  Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
        directory: "/tmp",
      });
      const socket = `${directory}/helper.sock`;
      yield* listenOn(socket);
      const reply = yield* sendToCodexHelper({ socket, request: "{}" });
      assert.equal(reply.length, REPLY.length);
      assert.equal(reply, REPLY);
    }),
  ),
  { timeout: "1 minute", cleanup: "1 minute" },
);
