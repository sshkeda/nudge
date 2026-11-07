import { Effect, Option } from "effect";
import { Command } from "effect/cli";

import { Claude } from "../lib/claude/index.ts";
import { Codex } from "../lib/codex/index.ts";
import { columns } from "../shared/columns.ts";
import { Output } from "../shared/output.ts";
import { homePath, showOnTerminal, trusted } from "../shared/report.ts";
import {
  DESCRIBE_SESSION_ARGUMENT,
  jsonFlag,
  requireNudgeOutsideSandbox,
  sessionArgument,
} from "./command-arguments.ts";
import { encodeSession } from "./session-json.ts";
import {
  annotateSession,
  findArchivedSession,
  findSession,
  requireSessionArguments,
} from "./session-resolution.ts";

export const showCommand = Command.make(
  "show",
  { target: sessionArgument, json: jsonFlag },
  Effect.fn("nudge.show", { attributes: { "nudge.command": "show" } })(function* ({ target }) {
    yield* requireSessionArguments({ command: "nudge show", archived: false, targets: [target] });
    yield* requireNudgeOutsideSandbox;
    const output = yield* Output;
    const session = yield* findSession(target).pipe(
      Effect.catchTag("SessionArchived", () => findArchivedSession(target)),
    );
    yield* annotateSession(session);
    yield* Effect.annotateCurrentSpan("nudge.status", session.status);
    const showPath = (value: string) => homePath(value).show(output.audience);
    const modelChoice =
      session.provider === "Codex"
        ? yield* (yield* Codex).readModelChoice(session)
        : yield* (yield* Claude).readModelChoice(session);
    const showRecorded = Option.match({ onNone: () => "unknown", onSome: showOnTerminal });
    yield* output.print({
      shown: trusted(
        columns([
          ["Name:", showOnTerminal(session.name)],
          ["Provider:", session.provider],
          ["ID:", showOnTerminal(session.id)],
          ["Status:", showOnTerminal(session.status)],
          ["Model:", showRecorded(modelChoice.model)],
          ["Effort:", showRecorded(modelChoice.effort)],
          ["Speed:", showRecorded(modelChoice.speed)],
          [
            "Project:",
            session.project.startsWith("/")
              ? showPath(session.project)
              : showOnTerminal(session.project),
          ],
          ["Section:", showOnTerminal(session.section)],
          ["Updated:", showOnTerminal(session.lastActiveAt)],
          ["Directory:", session.directory === "" ? "" : showPath(session.directory)],
          [
            "Transcript:",
            Option.match(session.transcript, {
              onNone: () => "none, because Claude hasn't saved one",
              onSome: showPath,
            }),
          ],
        ]),
      ),
      json: {
        action: "show",
        target: yield* encodeSession(session),
        model: Option.getOrNull(modelChoice.model),
        effort: Option.getOrNull(modelChoice.effort),
        speed: Option.getOrNull(Option.map(modelChoice.speed, (name) => name.toLowerCase())),
      },
    });
  }),
).pipe(
  Command.withDescription(
    `Show a session's details and the path of its transcript, even if it's archived.\n\n${DESCRIBE_SESSION_ARGUMENT}`,
  ),
);
