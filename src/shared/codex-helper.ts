import { connect } from "node:net";

import { Effect, Schema } from "effect";

import { codeOf } from "./error-code.ts";
import { CODEX_SANDBOX_BLOCKS_NETWORK } from "./read-environment.ts";
import { homePath, messageOf, prose, Report } from "./report.ts";

export const RECORD_TRACES_METHOD = "nudge/recordTraces";

export const APP_TOOLS_METHOD = "tools/call";

export const APP_TOOLS_NAMESPACE = "codex_app";

export const FORWARDED_APP_TOOLS = [
  "list_projects",
  "create_thread",
  "send_message_to_thread",
  "set_thread_title",
  "set_thread_archived",
] as const;

export const RecordTracesRequest = Schema.Struct({
  method: Schema.Literal(RECORD_TRACES_METHOD),
  parameters: Schema.Struct({ line: Schema.String }),
}).pipe(Schema.encodeKeys({ parameters: "params" }));

export const CodexHelperReply = Schema.Union([
  Schema.Struct({ result: Schema.Struct({}) }),
  Schema.Struct({ error: Schema.Struct({ message: Schema.String }) }),
]);

export class CodexHelperUnreachable extends Schema.TaggedError<CodexHelperUnreachable>()(
  "CodexHelperUnreachable",
  { socket: Schema.String, code: Schema.optional(Schema.String), reason: Schema.String },
) {
  public get report(): Report {
    return new Report({
      message: prose`can't reach nudge's Codex helper at ${homePath(this.socket)}: ${this.reason}`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class CodexSandboxBlocksNudge extends Schema.TaggedError<CodexSandboxBlocksNudge>()(
  "CodexSandboxBlocksNudge",
  { socket: Schema.String },
) {
  public get report(): Report {
    return new Report({
      message: prose`Codex's sandbox blocks nudge from reaching Codex at ${homePath(this.socket)}, so run this nudge command outside the sandbox`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

const SANDBOX_BLOCK_CODES: ReadonlySet<string | undefined> = new Set(["ECONNREFUSED", "EPERM"]);

export const isBlockedByCodexSandbox = (error: CodexHelperUnreachable) =>
  Effect.map(
    CODEX_SANDBOX_BLOCKS_NETWORK,
    (blocksNetwork) => blocksNetwork && SANDBOX_BLOCK_CODES.has(error.code),
  );

export class CodexHelperClosedWithoutReply extends Schema.TaggedError<CodexHelperClosedWithoutReply>()(
  "CodexHelperClosedWithoutReply",
  { socket: Schema.String },
) {
  public get report(): Report {
    return new Report({
      message: prose`nudge's Codex helper at ${homePath(this.socket)} closed the connection without replying`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export const sendToCodexHelper = ({
  socket,
  request,
}: {
  readonly socket: string;
  readonly request: string;
}) =>
  Effect.callback<string, CodexHelperClosedWithoutReply | CodexHelperUnreachable>((resume) => {
    const client = connect(socket);
    client.setEncoding("utf8");
    const chunks: string[] = [];
    client.on("connect", () => {
      client.write(`${request}\n`);
    });
    client.on("data", (chunk) => {
      chunks.push(String(chunk));
    });
    client.on("end", () => {
      resume(Effect.succeed(chunks.join("")));
    });
    client.on("error", (error) => {
      resume(
        Effect.fail(
          new CodexHelperUnreachable({ socket, code: codeOf(error), reason: error.message }),
        ),
      );
    });
    client.on("close", () => {
      resume(Effect.fail(new CodexHelperClosedWithoutReply({ socket })));
    });
    return Effect.sync(() => client.destroy());
  });

const connectToCodexHelper = (socket: string) =>
  Effect.callback<void, CodexHelperUnreachable>((resume) => {
    const client = connect(socket);
    client.on("connect", () => {
      client.destroy();
      resume(Effect.void);
    });
    client.on("error", (error) => {
      resume(
        Effect.fail(
          new CodexHelperUnreachable({ socket, code: codeOf(error), reason: error.message }),
        ),
      );
    });
    return Effect.sync(() => client.destroy());
  });

export const requireCodexHelperOutsideSandbox = (socket: string) =>
  Effect.gen(function* () {
    if (!(yield* CODEX_SANDBOX_BLOCKS_NETWORK)) {
      return;
    }
    yield* connectToCodexHelper(socket).pipe(
      Effect.catchTag("CodexHelperUnreachable", (unreachable) =>
        Effect.flatMap(isBlockedByCodexSandbox(unreachable), (isBlocked) =>
          isBlocked ? Effect.fail(new CodexSandboxBlocksNudge({ socket })) : Effect.void,
        ),
      ),
    );
  });
