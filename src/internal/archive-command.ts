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
import { archiveSession } from "./session-operations.ts";
import {
  annotateSession,
  findArchivedSession,
  findSession,
  requireSessionArguments,
} from "./session-resolution.ts";

export const archiveCommand = Command.make(
  "archive",
  { target: sessionArgument, json: jsonFlag },
  Effect.fn("nudge.archive", { attributes: { "nudge.command": "archive" } })(function* ({
    target,
  }) {
    yield* requireSessionArguments({
      command: "nudge archive",
      archived: false,
      targets: [target],
    });
    yield* requireNudgeOutsideSandbox;
    const output = yield* Output;
    const archived = yield* findSession(target).pipe(
      Effect.map((session) => ({ session, isArchived: false })),
      Effect.catchTag("SessionArchived", () =>
        Effect.map(findArchivedSession(target), (session) => ({ session, isArchived: true })),
      ),
    );
    const { session, isArchived } = archived;
    yield* annotateSession(session);
    const outcome = yield* archiveSession({ session, isArchived });
    yield* Effect.annotateCurrentSpan({
      "nudge.status": outcome,
      "nudge.archive.required": outcome !== "unchanged",
    });
    yield* output.print({
      shown: Match.value(outcome).pipe(
        Match.when("unchanged", () => prose`${describeSession(session)} is already archived.`),
        Match.when("archived", () => prose`Archived ${describeSession(session)}.`),
        Match.exhaustive,
      ),
      json: {
        action: "archive",
        provider: describeProvider(session.provider),
        status: outcome,
        target: describeTarget(session),
      },
    });
  }),
).pipe(Command.withDescription(`Archive a session.\n\n${DESCRIBE_SESSION_ARGUMENT}`));
