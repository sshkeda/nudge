import { Effect, Option, Result } from "effect";

import type { Sender } from "../shared/message-envelope.ts";
import { Output } from "../shared/output.ts";
import { prose } from "../shared/report.ts";
import { describeProvider, describeSession } from "../shared/session.ts";
import type { Session } from "../shared/session.ts";
import type { Speed } from "../shared/speed.ts";
import { FAILED_EXIT_CODE, hintFor, readText } from "./command-arguments.ts";
import { commandWords } from "./command-words.ts";
import { FailureReported, MessageEmpty, MessageMissing } from "./errors.ts";
import { findSender } from "./find-sender.ts";
import { describeTarget } from "./session-json.ts";
import { checkSend, sendToSession } from "./session-operations.ts";
import { annotateSession, findSession } from "./session-resolution.ts";

const deliver = Effect.fn("nudge.deliver")(
  function* ({
    session,
    message,
    sender,
    model,
    effort,
    speed,
  }: {
    readonly session: Effect.Success<ReturnType<typeof findSession>>;
    readonly message: string;
    readonly sender: Option.Option<typeof Sender.Type>;
    readonly model: Option.Option<string>;
    readonly effort: Option.Option<string>;
    readonly speed: Option.Option<typeof Speed.Type>;
  }) {
    yield* annotateSession(session);
    const sent = yield* sendToSession({
      session,
      message,
      sender,
      model,
      effort,
      speed,
    });
    const output = yield* Output;
    const warnings = "warnings" in sent ? sent.warnings : [];
    yield* Effect.forEach(warnings, (warning) => output.warn(warning), { discard: true });
    yield* Effect.annotateCurrentSpan({
      "nudge.status": sent.status,
      "nudge.message.id": sent.messageId,
      "nudge.warning.count": warnings.length,
    });
    return { session, messageId: sent.messageId, status: sent.status };
  },
  Effect.tapError((error) => Effect.annotateCurrentSpan("nudge.error", error.name)),
);

const describeDelivered = ({
  session,
  messageId,
  status,
}: {
  readonly session: typeof Session.Type;
  readonly messageId: string;
  readonly status: string;
}) => ({
  action: "send",
  provider: describeProvider(session.provider),
  status,
  ...(session.provider === "Codex" ? { delivery: "native" } : {}),
  target: describeTarget(session),
  messageId,
});

const HELD_EXIT_CODE = 3;

const REPLIES_COME_AS_MESSAGES = "Replies come to you as new messages.";

const describeSent = (delivered: {
  readonly session: typeof Session.Type;
  readonly status: string;
}) =>
  delivered.status === "accepted"
    ? prose`Sent the message to ${describeSession(delivered.session)}, which is in the middle of a turn, so it reads the message after its current step.`
    : prose`Sent the message to ${describeSession(delivered.session)}.`;

export const sendMessage = ({
  target,
  message,
  model,
  effort,
  speed,
}: {
  readonly target: string;
  readonly message: Option.Option<string>;
  readonly model: Option.Option<string>;
  readonly effort: Option.Option<string>;
  readonly speed: Option.Option<typeof Speed.Type>;
}) =>
  Effect.gen(function* () {
    const output = yield* Output;
    const words = yield* commandWords;
    const given = yield* readText(message, {
      empty: new MessageEmpty(),
      missing: new MessageMissing(),
    });
    const sender = yield* findSender;
    const found = yield* findSession(target).pipe(Effect.result);
    if (Result.isSuccess(found)) {
      yield* checkSend({ session: found.success, model, effort, speed });
    }
    const report = (error: Error) =>
      output.fail(error, { hint: hintFor({ failure: error, words }) });
    const outcome = yield* Effect.fromResult(found).pipe(
      Effect.flatMap((session) =>
        deliver({ session, message: given, sender, model, effort, speed }),
      ),
      Effect.flatMap((delivered) =>
        output.print({
          shown: Option.isSome(sender)
            ? prose`${describeSent(delivered)} ${REPLIES_COME_AS_MESSAGES}`
            : describeSent(delivered),
          json: describeDelivered(delivered),
        }),
      ),
      Effect.as("sent" as const),
      Effect.catchTag("MessageHeld", (error) => report(error).pipe(Effect.as("held" as const))),
      Effect.catch((error) => report(error).pipe(Effect.as("failed" as const))),
    );
    const wasSent = outcome === "sent";
    yield* Effect.annotateCurrentSpan({
      "nudge.sent": wasSent ? 1 : 0,
      "nudge.error": wasSent ? 0 : 1,
    });
    if (outcome === "failed") {
      return yield* new FailureReported({ exitCode: FAILED_EXIT_CODE });
    }
    if (outcome === "held") {
      return yield* new FailureReported({ exitCode: HELD_EXIT_CODE });
    }
  });
