import { Effect, Option } from "effect";
import { Argument, Command } from "effect/cli";

import { Output } from "../shared/output.ts";
import { prose, quoted } from "../shared/report.ts";
import { describeProvider, describeSession } from "../shared/session.ts";
import {
  DESCRIBE_SESSION_ARGUMENT,
  jsonFlag,
  requireNudgeOutsideSandbox,
  requireUsableName,
  sessionArgument,
} from "./command-arguments.ts";
import { describeTarget } from "./session-json.ts";
import { renameSession } from "./session-operations.ts";
import { annotateSession, findSession, requireSessionArguments } from "./session-resolution.ts";

export const renameCommand = Command.make(
  "rename",
  { target: sessionArgument, name: Argument.String("name"), json: jsonFlag },
  Effect.fn("nudge.rename", { attributes: { "nudge.command": "rename" } })(function* ({
    target,
    name,
  }) {
    yield* requireSessionArguments({
      command: "nudge rename",
      archived: false,
      targets: [target],
    });
    yield* requireUsableName(name);
    yield* requireNudgeOutsideSandbox;
    const output = yield* Output;
    const session = yield* findSession(target);
    yield* annotateSession(session);
    const isSameName = session.name === name;
    yield* Effect.annotateCurrentSpan("nudge.rename.required", !isSameName);
    const appTitle = isSameName ? Option.none<string>() : yield* renameSession({ session, name });
    const renamed = prose`Renamed ${describeSession(session)} to ${quoted(name)}`;
    yield* output.print({
      shown: Option.match(appTitle, {
        onNone: () =>
          isSameName
            ? prose`${describeSession(session)} already has that name.`
            : prose`${renamed}.`,
        onSome: (title) =>
          prose`${renamed} in Claude Code only. The Claude app still calls it ${quoted(title)}, and so does nudge.`,
      }),
      json: {
        action: "rename",
        provider: describeProvider(session.provider),
        status: isSameName ? "unchanged" : "renamed",
        target: describeTarget(session),
        name,
        ...Option.match(appTitle, { onNone: () => ({}), onSome: (title) => ({ appTitle: title }) }),
      },
    });
  }),
).pipe(Command.withDescription(`Rename a session.\n\n${DESCRIBE_SESSION_ARGUMENT}`));
