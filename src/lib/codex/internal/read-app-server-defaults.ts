import { Effect, Option, Pull, Queue, Ref, Schema, Stream } from "effect";
import type { Cause, PlatformError } from "effect";
import { ChildProcess } from "effect/process";

import { toOneLine } from "../../../shared/print-line.ts";
import { Platform } from "../../platform/index.ts";
import { APP_SERVER_WAIT, CodexAppServerUnreadable } from "./errors.ts";

const NUDGE_CLIENT = { name: "nudge", title: null, version: "2.0.0" } as const;

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

const decodeReply = Schema.decodeOption(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optional(Schema.Json),
      method: Schema.optional(Schema.String),
      result: Schema.optional(Schema.Json),
      error: Schema.optional(Schema.Struct({ message: Schema.String })),
    }),
  ),
);

const decodeDefectMessage = Schema.decodeUnknownOption(Schema.Struct({ message: Schema.String }));

export const ApprovalPolicy = Schema.Union([
  Schema.String,
  Schema.Struct({ granular: Schema.Record(Schema.String, Schema.Boolean) }),
]);

export const AppServerConfig = Schema.Struct({
  model: Schema.optional(Schema.NullOr(Schema.String)),
  approval_policy: Schema.optional(Schema.NullOr(ApprovalPolicy)),
  approvals_reviewer: Schema.optional(Schema.NullOr(Schema.String)),
  sandbox_mode: Schema.optional(Schema.NullOr(Schema.String)),
  sandbox_workspace_write: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        network_access: Schema.optional(Schema.NullOr(Schema.Boolean)),
        exclude_slash_tmp: Schema.optional(Schema.NullOr(Schema.Boolean)),
        exclude_tmpdir_env_var: Schema.optional(Schema.NullOr(Schema.Boolean)),
      }),
    ),
  ),
  default_permissions: Schema.optional(Schema.NullOr(Schema.String)),
  features: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Json))),
  "features.guardian_approval": Schema.optional(Schema.Json),
});

export const AppServerRequirements = Schema.Struct({
  allowedApprovalPolicies: Schema.optional(Schema.NullOr(Schema.Array(ApprovalPolicy))),
  allowedApprovalsReviewers: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  allowedPermissionProfiles: Schema.optional(
    Schema.NullOr(Schema.Record(Schema.String, Schema.Boolean)),
  ),
  defaultPermissions: Schema.optional(Schema.NullOr(Schema.String)),
  autoReview: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        requiredOnModels: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
      }),
    ),
  ),
});

export const PermissionProfile = Schema.Struct({ id: Schema.String, allowed: Schema.Boolean });

const ConfigRead = Schema.Struct({ config: AppServerConfig });

const RequirementsRead = Schema.Struct({ requirements: Schema.NullOr(AppServerRequirements) });

const ProfilePage = Schema.Struct({
  data: Schema.Array(PermissionProfile),
  nextCursor: Schema.NullOr(Schema.String),
});

const talkTo = (command: readonly [string, ...string[]]) =>
  Effect.gen(function* () {
    const unreadable = (
      fields: Omit<ConstructorParameters<typeof CodexAppServerUnreadable>[0], "command">,
    ) => new CodexAppServerUnreadable({ command, ...fields });
    const [program, ...programArguments] = command;
    const requests = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    const child = yield* ChildProcess.make(program, programArguments, {
      extendEnv: true,
      stdin: Stream.fromQueue(requests),
      stderr: "pipe",
    }).pipe(
      Effect.catchDefect((defect) =>
        Effect.fail(
          unreadable({
            method: "spawn",
            failure: "not-started",
            detail: Option.match(decodeDefectMessage(defect), {
              onNone: () => String(defect),
              onSome: (thrown) => thrown.message,
            }),
          }),
        ),
      ),
      Effect.catchTag("PlatformError", (error) =>
        Effect.fail(unreadable({ method: "spawn", failure: "not-started", detail: error.message })),
      ),
    );
    const chunks = yield* Stream.toPull(child.stdout.pipe(Stream.decodeText, Stream.splitLines));
    const waiting = yield* Ref.make<readonly string[]>([]);
    const nextId = yield* Ref.make(1);

    const nextLine: Effect.Effect<Option.Option<string>, PlatformError.PlatformError> = Effect.gen(
      function* () {
        const [first, ...rest] = yield* Ref.get(waiting);
        if (first !== undefined) {
          yield* Ref.set(waiting, rest);
          return Option.some(first);
        }
        const chunk = yield* chunks.pipe(
          Effect.asSome,
          Pull.catchDone(() => Effect.succeedNone),
        );
        if (Option.isNone(chunk)) {
          return Option.none<string>();
        }
        yield* Ref.set(waiting, chunk.value);
        return yield* nextLine;
      },
    );

    const stoppedBefore = (method: string) =>
      Effect.gen(function* () {
        const standardError = yield* Stream.mkString(Stream.decodeText(child.stderr)).pipe(
          Effect.catchTag("PlatformError", () => Effect.succeed("")),
        );
        return yield* unreadable({ method, failure: "stopped", detail: standardError });
      });

    const awaitReply = (
      method: string,
      id: number,
    ): Effect.Effect<Schema.Json | undefined, CodexAppServerUnreadable> =>
      Effect.gen(function* () {
        const line = yield* nextLine.pipe(
          Effect.catchTag("PlatformError", (error) =>
            Effect.fail(unreadable({ method, failure: "stopped", detail: error.message })),
          ),
        );
        if (Option.isNone(line)) {
          return yield* stoppedBefore(method);
        }
        const reply = Option.filter(
          decodeReply(line.value),
          (decoded) => decoded.id === id && decoded.method === undefined,
        );
        if (Option.isNone(reply)) {
          return yield* awaitReply(method, id);
        }
        if (reply.value.error !== undefined) {
          return yield* unreadable({
            method,
            failure: "error",
            error: toOneLine(reply.value.error.message),
          });
        }
        return reply.value.result;
      });

    const send = (message: Schema.Json) =>
      Effect.gen(function* () {
        const line = yield* encodeJson(message).pipe(
          Effect.catchTag("SchemaError", (error) =>
            Effect.fail(
              unreadable({ method: "send", failure: "unknown-answer", detail: error.message }),
            ),
          ),
        );
        yield* Queue.offer(requests, new TextEncoder().encode(`${line}\n`));
      });

    const request = <Decoded>({
      method,
      parameters,
      schema,
    }: {
      readonly method: string;
      readonly parameters: Schema.Json;
      readonly schema: Schema.Codec<Decoded, unknown>;
    }) =>
      Effect.gen(function* () {
        const id = yield* Ref.getAndUpdate(nextId, (current) => current + 1);
        yield* send(parameters === null ? { id, method } : { id, method, params: parameters });
        const result = yield* awaitReply(method, id);
        return yield* Schema.decodeEffect(schema)(result).pipe(
          Effect.catchTag("SchemaError", () =>
            Effect.fail(unreadable({ method, failure: "unknown-answer" })),
          ),
        );
      });

    return { send, request };
  });

const listAllProfiles = ({
  request,
  directory,
}: {
  readonly request: Effect.Success<ReturnType<typeof talkTo>>["request"];
  readonly directory: string | null;
}) => {
  const fromPage = (
    cursor: string | null,
    listed: readonly (typeof PermissionProfile.Type)[],
  ): Effect.Effect<readonly (typeof PermissionProfile.Type)[], CodexAppServerUnreadable> =>
    Effect.gen(function* () {
      const page = yield* request({
        method: "permissionProfile/list",
        parameters: { cursor, cwd: directory },
        schema: ProfilePage,
      });
      const all = [...listed, ...page.data];
      return page.nextCursor === null ? all : yield* fromPage(page.nextCursor, all);
    });
  return fromPage(null, []);
};

export const askAppServer = Effect.fn("codex.askAppServer")(
  function* ({
    command,
    directory,
  }: {
    readonly command: readonly [string, ...string[]];
    readonly directory: Option.Option<string>;
  }) {
    const shownDirectory = Option.getOrNull(directory);
    const defaults = yield* Effect.scoped(
      Effect.gen(function* () {
        const { send, request } = yield* talkTo(command);
        yield* request({
          method: "initialize",
          parameters: { clientInfo: NUDGE_CLIENT, capabilities: { experimentalApi: false } },
          schema: Schema.Json,
        });
        yield* send({ method: "initialized" });
        const { config } = yield* request({
          method: "config/read",
          parameters: { cwd: shownDirectory },
          schema: ConfigRead,
        });
        const { requirements } = yield* request({
          method: "configRequirements/read",
          parameters: null,
          schema: RequirementsRead,
        });
        const profiles = yield* listAllProfiles({ request, directory: shownDirectory });
        return { config, requirements, profiles };
      }),
    ).pipe(
      Effect.timeoutOrElse({
        duration: APP_SERVER_WAIT,
        orElse: () =>
          Effect.fail(
            new CodexAppServerUnreadable({ command, method: "any", failure: "timed-out" }),
          ),
      }),
    );
    yield* Effect.annotateCurrentSpan({
      "nudge.codex.appServer.profileCount": defaults.profiles.length,
      "nudge.codex.appServer.hasRequirements": defaults.requirements !== null,
    });
    if (defaults.profiles.length === 0) {
      return yield* new CodexAppServerUnreadable({
        command,
        method: "permissionProfile/list",
        failure: "no-profiles",
      });
    }
    return defaults;
  },
  Effect.tapError((failed) =>
    Effect.annotateCurrentSpan({
      "nudge.codex.appServer.command": failed.command.join(" "),
      "nudge.codex.appServer.method": failed.method,
      "nudge.codex.appServer.failure": failed.failure,
    }),
  ),
);

export const appServerCommand = Effect.gen(function* () {
  const codex = (yield* Platform).codexDesktop.codex;
  return [codex, "app-server", "--listen", "stdio://"] as const;
});
