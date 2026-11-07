import { LLMock } from "@copilotkit/aimock";
import type { ChatMessage } from "@copilotkit/aimock";
import { Effect, FileSystem, Path, Queue, Schema, Stream } from "effect";
import type { Cause, Context } from "effect";

import { thisMachine } from "../lib/platform/index.ts";
import { MOCK_MODEL_PORT } from "./codex-and-claude.ts";

export const BOGUS_CLAUDE_MODEL = "nudge-bogus-model";

export const BOGUS_CODEX_MODEL = "nudge-bogus-codex-model";

export const OUT_OF_CREDIT = "OUT_OF_CREDIT";

export const LONG_REPLY = "LONG_REPLY";

const LONG_REPLY_CHARACTERS = 300_000;

const RUN_COMMAND = /RUN_COMMAND: (?<command>[^\n<]+)/u;

const RUN_OUTSIDE_SANDBOX = /RUN_OUTSIDE_SANDBOX: (?<command>[^\n<]+)/u;

const HOLD_UNTIL = /HOLD_UNTIL: (?<file>[^\n<]+)/u;

const PERMISSIONS_HELPER_PROMPT = "Nudge started this session to give the session it starts next";

export const PERMISSIONS_HELPER_HOLD = ".local/state/nudge-tests/hold-permissions-helper";

const COMMAND_CALL_PREFIX = "call_nudge_command_";

const RUNNING_COMMAND = /^Process running with session ID (?<session>\d+)$/mu;

const CODEX_LONGEST_STANDARD_INPUT_WAIT_MILLISECONDS = 300_000;

const CLAUDE_LONGEST_BASH_MILLISECONDS = 600_000;

const textOf = (message: ChatMessage | undefined) => {
  const content = message?.content ?? "";
  return typeof content === "string" ? content : content.map((part) => part.text ?? "").join("");
};

const encodeCommandArguments = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Struct({ cmd: Schema.String })),
);

const encodeEscalatedCommandArguments = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      cmd: Schema.String,
      sandbox_permissions: Schema.Literal("require_escalated"),
      justification: Schema.String,
    }),
  ),
);

const encodeStandardInputArguments = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ session_id: Schema.Int, chars: Schema.String, yield_time_ms: Schema.Int }),
  ),
);

const encodeBashArguments = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ command: Schema.String, description: Schema.String, timeout: Schema.Int }),
  ),
);

const isCommandResult = (message: ChatMessage | undefined) =>
  message?.tool_call_id?.startsWith(COMMAND_CALL_PREFIX) === true;

const holdUntil = (file: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.writeFileString(`${file}.started`, "ready");
    const watching = yield* Queue.unbounded<true, Cause.Done>();
    yield* Stream.merge(
      Stream.fromQueue(watching),
      fileSystem.watch(path.dirname(file), {
        onReady: () => {
          Queue.offerUnsafe(watching, true);
          Queue.endUnsafe(watching);
        },
      }),
    ).pipe(
      Stream.mapEffect(() => fileSystem.exists(file)),
      Stream.filter(Boolean),
      Stream.runHead,
    );
    return { content: "Released." };
  });

const addFixtures = ({
  mock,
  services,
  home,
}: {
  readonly mock: LLMock;
  readonly services: Context.Context<FileSystem.FileSystem | Path.Path>;
  readonly home: string;
}) => {
  mock.on({ predicate: (request) => HOLD_UNTIL.test(textOf(request.messages.at(-1))) }, (request) =>
    Effect.runPromise(
      holdUntil(HOLD_UNTIL.exec(textOf(request.messages.at(-1)))?.groups?.["file"] ?? "").pipe(
        Effect.provide(services),
      ),
    ),
  );
  mock.on(
    {
      predicate: (request) => textOf(request.messages.at(-1)).includes(PERMISSIONS_HELPER_PROMPT),
    },
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const hold = `${home}/${PERMISSIONS_HELPER_HOLD}`;
          if (!(yield* fileSystem.exists(hold))) {
            return { content: "Mocked reply." };
          }
          return yield* holdUntil((yield* fileSystem.readFileString(hold)).trim());
        }).pipe(Effect.provide(services)),
      ),
  );
  mock.on(
    { predicate: (request) => textOf(request.messages.at(-1)).includes(OUT_OF_CREDIT) },
    {
      error: {
        type: "invalid_request_error",
        message:
          "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
      },
      status: 400,
    },
  );
  mock.on(
    { predicate: (request) => textOf(request.messages.at(-1)).includes(LONG_REPLY) },
    { content: "x".repeat(LONG_REPLY_CHARACTERS) },
  );
  mock.on(
    {
      predicate: (request) => {
        const last = request.messages.at(-1);
        return (
          isCommandResult(last) ||
          RUN_COMMAND.test(textOf(last)) ||
          RUN_OUTSIDE_SANDBOX.test(textOf(last))
        );
      },
    },
    (request) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const last = request.messages.at(-1);
          const id = `${COMMAND_CALL_PREFIX}${request.messages.length}`;
          if (isCommandResult(last)) {
            const session = RUNNING_COMMAND.exec(textOf(last))?.groups?.["session"];
            if (session === undefined) {
              return { content: "Command finished." };
            }
            const standardInputArguments = yield* encodeStandardInputArguments({
              session_id: Number(session),
              chars: "",
              yield_time_ms: CODEX_LONGEST_STANDARD_INPUT_WAIT_MILLISECONDS,
            });
            return { toolCalls: [{ name: "write_stdin", id, arguments: standardInputArguments }] };
          }
          const outsideSandbox = RUN_OUTSIDE_SANDBOX.exec(textOf(last))?.groups?.["command"];
          if (outsideSandbox !== undefined) {
            const escalatedArguments = yield* encodeEscalatedCommandArguments({
              cmd: outsideSandbox,
              sandbox_permissions: "require_escalated",
              justification: "The test asks to run this command outside the sandbox.",
            });
            return { toolCalls: [{ name: "exec_command", id, arguments: escalatedArguments }] };
          }
          const command = RUN_COMMAND.exec(textOf(last))?.groups?.["command"] ?? "";
          const hasBash = (request.tools ?? []).some((tool) => tool.function.name === "Bash");
          if (hasBash) {
            return {
              toolCalls: [
                {
                  name: "Bash",
                  id,
                  arguments: yield* encodeBashArguments({
                    command,
                    description: "Run the requested command",
                    timeout: CLAUDE_LONGEST_BASH_MILLISECONDS,
                  }),
                },
              ],
            };
          }
          const commandArguments = yield* encodeCommandArguments({ cmd: command });
          return { toolCalls: [{ name: "exec_command", id, arguments: commandArguments }] };
        }),
      ),
  );
};

class MockModelPortTaken extends Schema.TaggedError<MockModelPortTaken>()("MockModelPortTaken", {
  port: Schema.Int,
  reason: Schema.String,
}) {
  public override get message() {
    return `the mock model can't listen on 127.0.0.1:${this.port}: ${this.reason}\nhint: Stop whatever listens there, such as another run of scripts/ci.ts`;
  }
}

export const startMockModel = Effect.acquireRelease(
  Effect.gen(function* () {
    const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    const { home } = yield* thisMachine;
    const created = new LLMock({ host: "127.0.0.1", port: MOCK_MODEL_PORT });
    addFixtures({ mock: created, services, home });
    created.onMessage(/.*/u, { content: "Mocked reply." });
    return created;
  }).pipe(
    Effect.tap((created) =>
      Effect.tryPromise({
        try: () => created.start(),
        catch: (cause) => new MockModelPortTaken({ port: MOCK_MODEL_PORT, reason: String(cause) }),
      }),
    ),
  ),
  (started) => Effect.promise(() => started.stop()),
);
