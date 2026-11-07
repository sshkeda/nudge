import { Clock, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { columns } from "../shared/columns.ts";
import { Output } from "../shared/output.ts";
import { joined, prose, quoted, showOnTerminal, trusted } from "../shared/report.ts";
import type { Session } from "../shared/session.ts";
import { jsonFlag, requireNudgeOutsideSandbox } from "./command-arguments.ts";
import { VALUE_FLAGS } from "./command-flags.ts";
import { END_OF_FLAGS, renderCommand, rerun, withoutFlags } from "./command-line.ts";
import { commandWords } from "./command-words.ts";
import { FlagsConflict, FlagValueTooSmall } from "./errors.ts";
import { encodeSession } from "./session-json.ts";
import { listAllArchivedSessions, listAllSessions } from "./session-resolution.ts";
import { updatedAgo } from "./updated-ago.ts";

const encodeSessions = (sessions: readonly (typeof Session.Type)[]) =>
  Effect.forEach(sessions, encodeSession);

const DEFAULT_LIST_LIMIT = 20;

const shortenProject = (project: string) =>
  project.split("/").findLast((part) => part !== "") ?? project;

const hintLines = (hints: readonly (string | null)[]) =>
  hints.flatMap((hint) => (hint === null ? [] : [trusted(`hint: ${hint}`)]));

const START_HINT = renderCommand(["new", "--help"]);

const listHint = ({
  archived,
  query,
  flags,
}: {
  readonly archived: boolean;
  readonly query: string;
  readonly flags: readonly string[];
}) => {
  const queryWords = query.startsWith("-") ? [END_OF_FLAGS, query] : [query];
  return renderCommand([
    "list",
    ...(archived ? ["--archived"] : []),
    ...flags,
    ...(query === "" ? [] : queryWords),
  ]);
};

const matchingSessions = <Found extends typeof Session.Type>(
  sessions: readonly Found[],
  filter: string,
) => {
  const lowerFilter = filter.toLowerCase();
  return sessions.filter(
    (session) =>
      session.name.toLowerCase().includes(lowerFilter) ||
      session.id.toLowerCase().includes(lowerFilter) ||
      session.provider.toLowerCase().includes(lowerFilter),
  );
};

const searchOtherList = ({
  archived,
  filter,
}: {
  readonly archived: boolean;
  readonly filter: string;
}) =>
  (archived ? listAllSessions : listAllArchivedSessions).pipe(
    Effect.map((sessions) => matchingSessions(sessions, filter).length > 0),
    Effect.catch(() => Effect.succeed(false)),
  );

const describeEmptyList = ({
  archived,
  filter,
  total,
  offset,
  limitFlags,
  otherListMatches,
}: {
  readonly archived: boolean;
  readonly filter: string;
  readonly total: number;
  readonly offset: number;
  readonly limitFlags: readonly string[];
  readonly otherListMatches: boolean;
}) => {
  if (total > 0) {
    return joined(
      [
        prose`No matches on this page, because --offset ${offset} skips all ${total} matches.`,
        ...hintLines([listHint({ archived, query: filter, flags: limitFlags })]),
      ],
      "\n",
    );
  }
  if (filter !== "") {
    return joined(
      [
        prose`No matches for ${quoted(filter)}.`,
        ...hintLines([
          otherListMatches
            ? listHint({ archived: !archived, query: filter, flags: [] })
            : listHint({ archived, query: "", flags: [] }),
        ]),
      ],
      "\n",
    );
  }
  if (archived) {
    return joined(
      [trusted("No archived sessions found."), ...hintLines([renderCommand(["list"])])],
      "\n",
    );
  }
  return joined([trusted("No sessions found."), ...hintLines([START_HINT])], "\n");
};

export const listCommand = Command.make(
  "list",
  {
    query: Argument.String("query").pipe(Argument.optional),
    archived: Flag.Boolean("archived").pipe(
      Flag.withDescription("List archived sessions instead."),
      Flag.withDefault(false),
    ),
    json: jsonFlag,
    all: Flag.Boolean("all").pipe(
      Flag.withDescription("List every match. You can't use it with --limit."),
      Flag.withDefault(false),
    ),
    limit: VALUE_FLAGS.limit.pipe(
      Flag.withDescription(`List at most this many matches. The default is ${DEFAULT_LIST_LIMIT}.`),
      Flag.optional,
    ),
    offset: VALUE_FLAGS.offset.pipe(
      Flag.withDescription("Skip this many matches first."),
      Flag.withDefault(0),
    ),
  },
  Effect.fn("nudge.list", { attributes: { "nudge.command": "list" } })(function* ({
    query,
    archived,
    all,
    limit,
    offset,
  }) {
    const output = yield* Output;
    const words = yield* commandWords;
    const combinesAllAndLimit = all && Option.isSome(limit);
    if (combinesAllAndLimit) {
      return yield* new FlagsConflict({
        flag: "--all",
        other: "--limit",
        hint: rerun(withoutFlags(words, new Set(["limit"]))),
      });
    }
    const tooSmall = [
      { flag: "--limit", value: Option.getOrElse(limit, () => DEFAULT_LIST_LIMIT), least: 1 },
      { flag: "--offset", value: offset, least: 0 },
    ].find(({ value, least }) => value < least);
    if (tooSmall !== undefined) {
      return yield* new FlagValueTooSmall({ command: "nudge list", ...tooSmall });
    }
    yield* requireNudgeOutsideSandbox;
    const filter = Option.getOrElse(query, () => "");
    const matches = matchingSessions(
      yield* archived ? listAllArchivedSessions : listAllSessions,
      filter,
    );
    const pageSize = all ? matches.length : Option.getOrElse(limit, () => DEFAULT_LIST_LIMIT);
    const page = matches.slice(offset, offset + pageSize);
    yield* Effect.annotateCurrentSpan({
      "nudge.list.archived": archived,
      "nudge.list.match.count": matches.length,
      "nudge.list.page.count": page.length,
      "nudge.list.offset": offset,
    });
    const hasMore = offset + page.length < matches.length;
    const nextOffset = hasMore ? offset + page.length : null;
    const limitFlags = Option.match(limit, {
      onNone: () => [],
      onSome: (value) => ["--limit", String(value)],
    });
    const json = {
      action: "list",
      targets: yield* encodeSessions(page),
      total: matches.length,
      offset,
      nextOffset,
    };
    if (page.length === 0) {
      const onlyOtherListCanMatch = !output.isJson && filter !== "" && matches.length === 0;
      const otherMatches = onlyOtherListCanMatch
        ? yield* searchOtherList({ archived, filter })
        : false;
      return yield* output.print({
        shown: describeEmptyList({
          archived,
          filter,
          total: matches.length,
          offset,
          limitFlags,
          otherListMatches: otherMatches,
        }),
        json,
      });
    }
    const now = yield* Clock.currentTimeMillis;
    const table = columns([
      ["NAME", "ID", "PROVIDER", "STATUS", "UPDATED", "PROJECT", "SECTION"],
      ...page.map((session) =>
        [
          session.name,
          session.id,
          session.provider,
          session.status,
          updatedAgo(session.lastActiveAt, now),
          shortenProject(session.project),
          session.section,
        ].map((cell) => showOnTerminal(cell)),
      ),
    ]);
    const paging =
      nextOffset === null
        ? []
        : [
            trusted(`Showing ${offset + 1}–${nextOffset} of ${matches.length} matches.`),
            ...hintLines([
              listHint({
                archived,
                query: filter,
                flags: [...limitFlags, "--offset", String(nextOffset)],
              }),
            ]),
          ];
    yield* output.print({ shown: joined([trusted(table), ...paging], "\n"), json });
  }),
).pipe(
  Command.withDescription(
    `List sessions, most recent first, ${DEFAULT_LIST_LIMIT} at a time.\n\nWith [query], nudge lists only the ones whose name, provider or ID contains it, ignoring case.`,
  ),
);
