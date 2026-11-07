import { getSessionInfo, listSessions, renameSession } from "@anthropic-ai/claude-agent-sdk";
import type { SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { Effect, Option, Schema } from "effect";

import { toOneLine } from "../../../shared/print-line.ts";
import { describeSession } from "./claude-session-files.ts";
import type { ClaudeSession } from "./claude-session.ts";
import { ClaudeHistoryUnreadable, ClaudeRenameFailed } from "./errors.ts";

export const HistorySession = Schema.Struct({
  id: Schema.String,
  title: Schema.Option(Schema.String),
  directory: Schema.Option(Schema.String),
  createdAt: Schema.Option(Schema.Finite),
});

const nonEmpty = (value: string | undefined) =>
  Option.map(
    Option.filter(Option.fromUndefinedOr(value), (text) => text.trim() !== ""),
    (text) => text.trim(),
  );

const toHistorySession = (information: SDKSessionInfo) =>
  HistorySession.make({
    id: information.sessionId,
    title: nonEmpty(information.customTitle),
    directory: Option.filter(
      Option.fromUndefinedOr(information.cwd),
      (directory) => directory !== "",
    ),
    createdAt: Option.filter(Option.fromUndefinedOr(information.createdAt), (time) =>
      Number.isFinite(time),
    ),
  });

export const listHistory = Effect.tryPromise({
  try: () => listSessions({ includeProgrammatic: false }),
  catch: (error) =>
    new ClaudeHistoryUnreadable({
      reason: toOneLine(error instanceof Error ? error.message : String(error)),
    }),
}).pipe(Effect.map((sessions) => sessions.map((information) => toHistorySession(information))));

export const findInHistory = (id: string) =>
  Effect.tryPromise({
    try: () => getSessionInfo(id),
    catch: (error) =>
      new ClaudeHistoryUnreadable({
        reason: toOneLine(error instanceof Error ? error.message : String(error)),
      }),
  }).pipe(
    Effect.map((information) =>
      Option.map(Option.fromUndefinedOr(information), (found) => toHistorySession(found)),
    ),
    Effect.map(Option.toArray),
  );

export const renameSavedSession = ({
  session,
  name,
}: {
  readonly session: typeof ClaudeSession.Type;
  readonly name: string;
}) =>
  Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan("nudge.claude.rename.path", "saved-session");
    yield* Effect.tryPromise({
      try: () => renameSession(session.id, name),
      catch: (error) =>
        new ClaudeRenameFailed({
          session: describeSession(session),
          reason: toOneLine(error instanceof Error ? error.message : String(error)),
        }),
    });
    return { appTitle: session.appTitle };
  });
