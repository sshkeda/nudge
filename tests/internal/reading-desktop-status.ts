import assert from "node:assert/strict";

import * as BunSocketServer from "@effect/platform-bun/BunSocketServer";
import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Layer, Result, Schema, Sink, Stdio, Stream } from "effect";
import type { Socket } from "effect/socket";

import { BUN } from "../../scripts/shared/codex-and-claude.ts";
import { runShell } from "../../scripts/shared/run-shell.ts";
import {
  askCodexDesktop,
  frame,
  splitFrames,
} from "../../src/lib/codex/internal/codex-desktop-ipc.ts";
import { Output, outputLayerFor } from "../../src/shared/output.ts";
import { quoteForShell } from "../../src/shared/report.ts";
import { resultOf } from "../shared/failure-as-value.ts";

const Request = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.String,
    method: Schema.optional(Schema.String),
    requestId: Schema.optional(Schema.String),
  }),
);
const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

const METHOD = "thread-owner-discovery";

const HISTORY_METHOD = "thread-follower-load-complete-history";

const ACTIVE_SNAPSHOT = {
  type: "broadcast",
  method: "thread-stream-state-changed",
  sourceClientId: "owner",
  params: {
    conversationId: "thread",
    change: {
      type: "snapshot",
      conversationState: { threadRuntimeStatus: { type: "active", activeFlags: [] } },
    },
  },
} as const;

const OWNER_DISCONNECTED = {
  type: "broadcast",
  method: "client-status-changed",
  sourceClientId: "router",
  params: { clientId: "owner", status: "disconnected" },
} as const;

const UNREADABLE_REASON = [
  `Codex Desktop sent a message nudge can't read: Expected`,
  '{ readonly "type": "response", readonly "resultType": "error", ... } |',
  '{ readonly "type": "response", readonly "resultType": "success", ... } |',
  '{ readonly "type": "client-discovery-request", ... } |',
  '{ readonly "type": "broadcast", ... }',
].join(" ");

const answerAsCodexDesktop = (
  method: string | undefined,
  response: Readonly<Record<string, Schema.Json>>,
): readonly Schema.Json[] => {
  if (method === "initialize") {
    return [{ ...response, result: { clientId: "nudge" } }];
  }
  if (method === METHOD) {
    return [{ ...response, handledByClientId: "owner", result: {} }];
  }
  return [{ ...response, result: { revision: 1 } }, ACTIVE_SNAPSHOT];
};

const SCENARIOS = [
  {
    name: "silent",
    answer: "silent",
    reason: `Codex Desktop did not answer ${METHOD} within 30 seconds`,
  },
  {
    name: "closes",
    answer: "closes",
    reason: "Codex Desktop closed the connection before answering",
  },
  {
    name: "unreadable",
    answer: (method: string | undefined, response: Readonly<Record<string, Schema.Json>>) =>
      method === "initialize" ? [{ type: "surprise" }] : answerAsCodexDesktop(method, response),
    reason: UNREADABLE_REASON,
  },
  {
    name: "loses the owner",
    answer: (method: string | undefined, response: Readonly<Record<string, Schema.Json>>) =>
      method === HISTORY_METHOD ? [OWNER_DISCONNECTED] : answerAsCodexDesktop(method, response),
    reason: "the thread stream owner disconnected before sending its status",
  },
  {
    name: "hides the owner",
    answer: (method: string | undefined, response: Readonly<Record<string, Schema.Json>>) =>
      method === METHOD ? [{ ...response, result: {} }] : answerAsCodexDesktop(method, response),
    reason: "owner discovery didn't identify the thread stream owner",
  },
] as const;

const handleConnection =
  (answer: (typeof SCENARIOS)[number]["answer"] | typeof answerAsCodexDesktop) =>
  (socket: Socket.Socket) =>
    Effect.scoped(
      Effect.gen(function* () {
        const reader = yield* socket.reader;
        if (answer === "silent") {
          return yield* Effect.never;
        }
        if (answer === "closes") {
          yield* reader.pull;
          return;
        }
        const writer = yield* socket.writer;
        yield* Stream.fromIterableEffectRepeat(reader.pull).pipe(
          Stream.mapAccum(
            (): Buffer => Buffer.alloc(0),
            (pending, chunk) => {
              const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
              const split = splitFrames({ buffer: Buffer.concat([pending, bytes]), bodies: [] });
              return [split.buffer, split.bodies] as const;
            },
          ),
          Stream.mapEffect((message) => Schema.decodeEffect(Request)(message)),
          Stream.runForEach((request) =>
            Effect.gen(function* () {
              const isRequest = request.type === "request" && request.requestId !== undefined;
              if (!isRequest) {
                return;
              }
              const response = {
                type: "response",
                requestId: request.requestId ?? "",
                resultType: "success",
              };
              for (const message of answer(request.method, response)) {
                yield* writer.write(frame(yield* encode(message)));
                yield* Effect.yieldNow;
              }
            }),
          ),
        );
      }),
    ).pipe(Effect.catchTags({ SocketError: () => Effect.void }));

const ask = (socket: string) =>
  resultOf(
    askCodexDesktop({
      socket,
      method: METHOD,
      version: 1,
      parameters: { conversationId: "thread" },
      followThread: "thread",
    }),
  );

const printed = ({ failure, home }: { readonly failure: Error; readonly home: string }) =>
  Effect.gen(function* () {
    const chunks: (Uint8Array | string)[] = [];
    const standardError = Stdio.layerTest({
      stderr: () =>
        Sink.forEachArray((written) =>
          Effect.sync(() => {
            chunks.push(...written);
          }),
        ),
    });
    yield* Effect.gen(function* () {
      yield* (yield* Output).fail(failure);
    }).pipe(
      Effect.provide(outputLayerFor({ mode: "terminal", home }).pipe(Layer.provide(standardError))),
    );
    return chunks
      .map((chunk) => (typeof chunk === "string" ? chunk : Buffer.from(chunk).toString()))
      .join("");
  });

const failureOf = <Success>(answer: Result.Result<Success, Error>) => {
  assert.ok(Result.isFailure(answer));
  return answer.failure;
};

export const readingDesktopStatus = Task.make(
  "reading-desktop-status",
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const home = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
      const askAnswering = (answer: Parameters<typeof handleConnection>[0]) =>
        Effect.scoped(
          Effect.gen(function* () {
            const path = `${home}/desktop.sock`;
            const server = yield* BunSocketServer.make({ path });
            return yield* ask(path).pipe(Effect.raceFirst(server.run(handleConnection(answer))));
          }),
        );

      const answered = yield* askAnswering(answerAsCodexDesktop);
      assert.ok(Result.isSuccess(answered));
      assert.equal(answered.success.resultType, "success");
      assert.deepEqual(answered.success.result, { type: "active", activeFlags: [] });

      for (const scenario of SCENARIOS) {
        assert.equal(
          yield* printed({ failure: failureOf(yield* askAnswering(scenario.answer)), home }),
          `error: can't ask Codex Desktop for ${METHOD} at ~/desktop.sock: ${scenario.reason}\n`,
          scenario.name,
        );
      }

      const missing = `${home}/missing.sock`;
      assert.equal(
        yield* printed({ failure: failureOf(yield* ask(missing)), home }),
        `error: can't ask Codex Desktop for ${METHOD} at ~/missing.sock: connect ENOENT ${missing}\nhint: nudge doctor\n`,
      );

      const crashed = `${home}/crashed.sock`;
      yield* runShell(
        `${BUN} -e 'require("node:net").createServer().listen(process.argv[1], () => process.exit(0))' ${quoteForShell(crashed)}`,
      );
      assert.ok(yield* fileSystem.exists(crashed));
      assert.equal(
        yield* printed({ failure: failureOf(yield* ask(crashed)), home }),
        `error: can't ask Codex Desktop for ${METHOD} at ~/crashed.sock: connect ECONNREFUSED ${crashed}\nhint: nudge doctor\n`,
      );
    }),
  ),
);
