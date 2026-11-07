import { Effect, Match } from "effect";
import { Command } from "effect/cli";

import { Output } from "../shared/output.ts";
import { prose } from "../shared/report.ts";
import { describeProvider, describeSession } from "../shared/session.ts";
import {
  DESCRIBE_SESSION_ARGUMENT,
  jsonFlag,
  requireNudgeOutsideSandbox,
  sessionArgument,
} from "./command-arguments.ts";
import { describeTarget } from "./session-json.ts";
import { unarchiveSession } from "./session-operations.ts";
import {
  annotateSession,
  findArchivedSession,
  findSession,
  requireSessionArguments,
} from "./session-resolution.ts";

export const unarchiveCommand = Command.make(
  "unarchive",
  { target: sessionArgument, json: jsonFlag },
  Effect.fn("nudge.unarchive", { attributes: { "nudge.command": "unarchive" } })(function* ({
    target,
  }) {
    yield* requireSessionArguments({
      command: "nudge unarchive",
      archived: true,
      targets: [target],
    });
    yield* requireNudgeOutsideSandbox;
    const output = yield* Output;
    const found = yield* findArchivedSession(target).pipe(
      Effect.map((session) => ({ session, isArchived: true })),
      Effect.catchTag("SessionNotFound", (notFound) =>
        findSession(target).pipe(
          Effect.map((session) => ({ session, isArchived: false })),
          Effect.catchTag("SessionNotFound", () => Effect.fail(notFound)),
        ),
      ),
    );
    const { session, isArchived } = found;
    yield* annotateSession(session);
    const outcome = yield* unarchiveSession({ session, isArchived });
    yield* Effect.annotateCurrentSpan({
      "nudge.status": outcome,
      "nudge.unarchive.required": outcome !== "unchanged",
    });
    yield* output.print({
      shown: Match.value(outcome).pipe(
        Match.when("unchanged", () => prose`${describeSession(session)} isn't archived.`),
        Match.when("unarchived", () => prose`Unarchived ${describeSession(session)}.`),
        Match.exhaustive,
      ),
      json: {
        action: "unarchive",
        provider: describeProvider(session.provider),
        status: outcome,
        target: describeTarget(session),
      },
    });
  }),
).pipe(Command.withDescription(`Unarchive a session.\n\n${DESCRIBE_SESSION_ARGUMENT}`));
