import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import {
  DESCRIBE_SESSION_ARGUMENT,
  jsonFlag,
  requireNudgeOutsideSandbox,
  sessionArgument,
} from "./command-arguments.ts";
import { VALUE_FLAGS } from "./command-flags.ts";
import { MessageEmpty } from "./errors.ts";
import { sendMessage } from "./send-message.ts";
import { requireSessionArguments } from "./session-resolution.ts";

export const sendCommand = Command.make(
  "send",
  {
    target: sessionArgument,
    message: Argument.String("message").pipe(Argument.optional),
    json: jsonFlag,
    model: VALUE_FLAGS.model.pipe(
      Flag.withDescription(
        "Send the message with this model. A Claude session can't change model.",
      ),
      Flag.optional,
    ),
    effort: VALUE_FLAGS.effort.pipe(
      Flag.withDescription(
        "Send the message with this reasoning effort. A Claude session can't change effort.",
      ),
      Flag.optional,
    ),
    speed: VALUE_FLAGS.speed.pipe(
      Flag.withDescription(
        "Send the message at this speed: standard or fast. A Claude session can't change speed. Without it, the session keeps its current speed.",
      ),
      Flag.optional,
    ),
  },
  Effect.fn("nudge.send", { attributes: { "nudge.command": "send" } })(function* ({
    target,
    message,
    model,
    effort,
    speed,
  }) {
    if (Option.exists(message, (given) => given.trim() === "")) {
      return yield* new MessageEmpty();
    }
    yield* requireSessionArguments({ command: "nudge send", archived: false, targets: [target] });
    yield* requireNudgeOutsideSandbox;
    return yield* sendMessage({ target, message, model, effort, speed });
  }),
).pipe(
  Command.withDescription(
    `Send a message to a session.\n\n${DESCRIBE_SESSION_ARGUMENT} Without [message], or with -, nudge reads the message from stdin.\n\nnudge send exits with 0 when the message arrived, 1 when it failed, 2 when the command is wrong, and 3 when Claude holds it for approval. Don't resend a held message while it's pending.`,
  ),
);
