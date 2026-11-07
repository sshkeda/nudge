import { Effect, Option, Schema } from "effect";

import { CODEX_THREAD_ID } from "../../../shared/read-environment.ts";
import { turnIdFor } from "./call-app-tool.ts";
import {
  askForResult,
  PermissionsUpdated,
  UPDATE_THREAD_PERMISSIONS,
} from "./desktop-permissions.ts";

const START_TURN = { method: "thread-follower-start-turn", version: 2 } as const;

const Started = Schema.Struct({ result: Schema.Unknown });

const STANDARD_TIER = "default";

const NO_CLIENT_FOUND = "no-client-found";

const escapeDelegation = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export const startMessageWithSpeed = Effect.fn("codex.startMessageWithSpeed")(
  function* ({
    socket,
    threadId,
    messageId,
    prompt,
    tier,
    model,
    effort,
  }: {
    readonly socket: string;
    readonly threadId: string;
    readonly messageId: string;
    readonly prompt: string;
    readonly tier: Option.Option<string>;
    readonly model: Option.Option<string>;
    readonly effort: Option.Option<string>;
  }) {
    const hasModelOverride = Option.isSome(model) || Option.isSome(effort);
    if (hasModelOverride) {
      yield* askForResult({
        socket,
        request: UPDATE_THREAD_PERMISSIONS,
        parameters: {
          conversationId: threadId,
          threadSettings: {
            model: Option.getOrUndefined(model),
            effort: Option.getOrUndefined(effort),
          },
        },
        result: PermissionsUpdated,
      });
    }
    const caller = Option.getOrElse(yield* CODEX_THREAD_ID, () => threadId);
    const turnId = turnIdFor(messageId);
    yield* askForResult({
      socket,
      request: START_TURN,
      parameters: {
        conversationId: threadId,
        turnStart: {
          request: {
            threadId,
            input: [],
            toolOutput: {
              name: "send_message_to_thread",
              namespace: "codex_app",
              output: `<codex_delegation>\n  <source_thread_id>${escapeDelegation(caller)}</source_thread_id>\n  <input>${escapeDelegation(prompt)}</input>\n</codex_delegation>`,
            },
            clientUserMessageId: messageId,
            turnTrigger: "app_tool_send_message",
            parentTurnId: turnId,
            rootTurnId: turnId,
            serviceTier: Option.getOrElse(tier, () => STANDARD_TIER),
          },
        },
      },
      result: Started,
    });
  },
  (effect) =>
    effect.pipe(
      Effect.as(true),
      Effect.catchTag("CodexDesktopIpcRefused", (refused) =>
        refused.error.startsWith(NO_CLIENT_FOUND) ? Effect.succeed(false) : Effect.fail(refused),
      ),
    ),
);
