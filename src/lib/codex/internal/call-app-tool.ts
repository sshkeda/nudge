import { Effect, Match, Option, Schema } from "effect";
import { SecureRandom } from "effect/crypto";

import {
  APP_TOOLS_METHOD,
  APP_TOOLS_NAMESPACE,
  sendToCodexHelper,
} from "../../../shared/codex-helper.ts";
import {
  CODEX_BRIDGE_SOCKET,
  CODEX_HOME,
  CODEX_THREAD_ID,
} from "../../../shared/read-environment.ts";
import {
  CodexArchiveDatabaseLocked,
  CodexDesktopDidNotLoadUnarchivedThread,
  CodexDidNotAnswer,
  CodexEffortNotValidated,
  CodexHelperNotRunning,
  CodexToolFailed,
  NOTHING_LISTENS_CODES,
} from "./errors.ts";

const Response = Schema.Union([
  Schema.Struct({
    result: Schema.Struct({
      success: Schema.Boolean,
      contentItems: Schema.Array(Schema.Struct({ text: Schema.String })),
    }),
  }),
  Schema.Struct({ error: Schema.Struct({ message: Schema.String }) }),
]);

export const CODEX_ANSWER_WAIT = "60 seconds";

const EFFORT_NOT_VALIDATED = /could not validate reasoning effort/u;

const ARCHIVE_DATABASE_LOCKED =
  "failed to update archived thread metadata: error returned from database: (code: 5) database is locked";

const UNARCHIVED_THREAD_NOT_LOADED = /^Unarchived conversation \S+ could not be loaded$/u;

const CreateThread = Schema.Struct({
  tool: Schema.Literal("create_thread"),
  toolArguments: Schema.Struct({
    prompt: Schema.String,
    target: Schema.Union([
      Schema.Struct({ type: Schema.Literal("projectless") }),
      Schema.Struct({
        type: Schema.Literal("project"),
        projectId: Schema.String,
        environment: Schema.Struct({ type: Schema.Literal("local") }),
      }),
    ]),
    title: Schema.optional(Schema.String),
    model: Schema.optional(Schema.String),
    thinking: Schema.optional(Schema.String),
  }),
});

const ListProjects = Schema.Struct({
  tool: Schema.Literal("list_projects"),
  toolArguments: Schema.Struct({}),
});

const SendMessageToThread = Schema.Struct({
  tool: Schema.Literal("send_message_to_thread"),
  toolArguments: Schema.Struct({
    threadId: Schema.String,
    prompt: Schema.String,
    model: Schema.optional(Schema.String),
    thinking: Schema.optional(Schema.String),
  }),
});

const SetThreadTitle = Schema.Struct({
  tool: Schema.Literal("set_thread_title"),
  toolArguments: Schema.Struct({ threadId: Schema.String, title: Schema.String }),
});

const SetThreadArchived = Schema.Struct({
  tool: Schema.Literal("set_thread_archived"),
  toolArguments: Schema.Struct({
    threadId: Schema.String,
    source: Schema.Literal("codex"),
    hostId: Schema.Literal("local"),
    archived: Schema.Boolean,
  }),
});

const ToolCall = Schema.Union([
  ListProjects,
  CreateThread,
  SendMessageToThread,
  SetThreadTitle,
  SetThreadArchived,
]);

const ToolsCallRequest = Schema.Struct({
  method: Schema.Literal(APP_TOOLS_METHOD),
  parameters: Schema.Struct({
    tool: Schema.String,
    namespace: Schema.Literal(APP_TOOLS_NAMESPACE),
    threadId: Schema.String,
    turnId: Schema.String,
    callId: Schema.String,
    callerSource: Schema.Literal("codex"),
    toolArguments: Schema.Unknown,
  }).pipe(Schema.encodeKeys({ toolArguments: "arguments" })),
}).pipe(Schema.encodeKeys({ parameters: "params" }));

const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(ToolsCallRequest));

const mayStillAfter = (call: typeof ToolCall.Type) =>
  Match.value(call).pipe(
    Match.discriminatorsExhaustive("tool")({
      create_thread: () => Option.some("start" as const),
      send_message_to_thread: () => Option.some("deliver" as const),
      set_thread_archived: ({ toolArguments }) =>
        Option.some(toolArguments.archived ? ("archive" as const) : ("unarchive" as const)),
      set_thread_title: () => Option.some("rename" as const),
      list_projects: () => Option.none(),
    }),
  );

export const turnIdFor = (callId: string) => `nudge-${callId}`;

export const callTool = Effect.fn("codex.callTool")(function* ({
  call,
  callerOutsideTasks,
  callId,
}: {
  readonly callerOutsideTasks: string;
  readonly call: typeof ToolCall.Type;
  readonly callId?: string;
}) {
  const id = callId ?? (yield* (yield* SecureRandom.SecureRandom).uuidV4());
  const encodedCall = yield* Schema.encodeEffect(ToolCall)(call);
  const taskCaller = yield* CODEX_THREAD_ID;
  const caller = Option.getOrElse(taskCaller, () => callerOutsideTasks);
  yield* Effect.annotateCurrentSpan({
    "nudge.codex.caller.id": caller,
    "nudge.codex.caller.reason": Option.isSome(taskCaller) ? "calling-task" : "borrowed-task",
    "nudge.codex.tool": call.tool,
    "nudge.codex.call.id": id,
  });
  const reply = yield* sendToCodexHelper({
    socket: yield* CODEX_BRIDGE_SOCKET,
    request: yield* encodeRequest({
      method: APP_TOOLS_METHOD,
      parameters: {
        tool: call.tool,
        namespace: APP_TOOLS_NAMESPACE,
        threadId: caller,
        turnId: turnIdFor(id),
        callId: turnIdFor(id),
        callerSource: "codex",
        toolArguments: encodedCall.toolArguments,
      },
    }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: CODEX_ANSWER_WAIT,
      orElse: () =>
        Effect.fail(
          new CodexDidNotAnswer({
            tool: call.tool,
            waited: CODEX_ANSWER_WAIT,
            mayStill: mayStillAfter(call),
          }),
        ),
    }),
    Effect.catchTag("CodexHelperUnreachable", (unreachable) =>
      Effect.gen(function* () {
        if (!NOTHING_LISTENS_CODES.has(unreachable.code)) {
          return yield* unreachable;
        }
        return yield* new CodexHelperNotRunning({
          socket: unreachable.socket,
          reason: unreachable.reason,
          config: `${yield* CODEX_HOME}/config.toml`,
        });
      }),
    ),
  );
  const response = yield* Schema.decodeEffect(Schema.fromJsonString(Response))(reply);
  const succeeded = "result" in response && response.result.success;
  yield* Effect.annotateCurrentSpan("nudge.codex.tool.succeeded", succeeded);
  if (succeeded) {
    return response.result.contentItems.map((item) => item.text).join("\n");
  }
  const failure =
    "error" in response
      ? response.error.message
      : response.result.contentItems.map((item) => item.text).join("\n");
  if (EFFORT_NOT_VALIDATED.test(failure)) {
    return yield* new CodexEffortNotValidated({ tool: call.tool, failure });
  }
  const isArchiveDatabaseLocked =
    call.tool === "set_thread_archived" &&
    call.toolArguments.archived &&
    failure.endsWith(ARCHIVE_DATABASE_LOCKED);
  if (isArchiveDatabaseLocked) {
    return yield* new CodexArchiveDatabaseLocked({ failure });
  }
  const isUnarchivedThreadNotLoaded =
    call.tool === "set_thread_archived" && UNARCHIVED_THREAD_NOT_LOADED.test(failure);
  if (isUnarchivedThreadNotLoaded) {
    return yield* new CodexDesktopDidNotLoadUnarchivedThread({ failure });
  }
  return yield* new CodexToolFailed({ tool: call.tool, failure });
});
