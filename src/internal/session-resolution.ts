import { Effect } from "effect";

import { Claude } from "../lib/claude/index.ts";
import { Codex } from "../lib/codex/index.ts";
import type { Session } from "../shared/session.ts";
import {
  SessionArchived,
  SessionArgumentMissing,
  SessionNameAmbiguous,
  SessionNotFound,
} from "./errors.ts";

const activeTime = (session: typeof Session.Type) => {
  const time = Date.parse(session.lastActiveAt);
  return Number.isFinite(time) ? time : Number.MIN_SAFE_INTEGER;
};

const byMostRecent = <Found extends typeof Session.Type>(sessions: readonly Found[]) =>
  sessions.toSorted((left, right) => activeTime(right) - activeTime(left));

const liveSessions = (target?: string) =>
  Effect.gen(function* () {
    const claude = yield* Claude;
    const codex = yield* Codex;
    const lists = yield* Effect.all(
      [
        target === undefined ? claude.list : claude.findTarget(target),
        target === undefined ? codex.list : codex.findTarget(target),
      ],
      {
        concurrency: "unbounded",
      },
    );
    return byMostRecent(lists.flat());
  });

export const listAllSessions = liveSessions();

export const listAllArchivedSessions = Effect.gen(function* () {
  const lists = yield* Effect.all([(yield* Claude).listArchived, (yield* Codex).listArchived], {
    concurrency: "unbounded",
  });
  return byMostRecent(lists.flat());
});

const findArchivedSessions = (target: string) =>
  Effect.gen(function* () {
    const lists = yield* Effect.all(
      [(yield* Claude).findArchived(target), (yield* Codex).findArchived(target)],
      { concurrency: "unbounded" },
    );
    return lists.flat();
  });

const CODEX_THREAD_LINK = /^codex:\/\/threads\/(?<id>[^/?#]+)\/?(?:[?#].*)?$/u;

const normalizeTarget = (target: string) => {
  const trimmed = target.trim();
  return CODEX_THREAD_LINK.exec(trimmed)?.groups?.["id"] ?? trimmed;
};

export const annotateSession = (session: typeof Session.Type) =>
  Effect.annotateCurrentSpan({
    "nudge.provider": session.provider,
    "nudge.session.id": session.id,
  });

const findOneSession = Effect.fn("findOneSession")(function* <Found extends typeof Session.Type>({
  target,
  sessions,
  archived,
}: {
  readonly target: string;
  readonly sessions: readonly Found[];
  readonly archived: boolean;
}) {
  const byId = sessions.filter((session) => session.id === target);
  const matches = byId.length > 0 ? byId : sessions.filter((session) => session.name === target);
  yield* Effect.annotateCurrentSpan({
    "nudge.resolution.by": byId.length > 0 ? "id" : "name",
    "nudge.resolution.match.count": matches.length,
    "nudge.resolution.match.ids": matches.map((session) => session.id).join(" "),
    "nudge.resolution.archived": archived,
  });
  const [session, ...others] = matches;
  if (session === undefined) {
    return yield* new SessionNotFound({ target, archived });
  }
  if (others.length > 0) {
    return yield* new SessionNameAmbiguous({
      target,
      archived,
      candidates: matches.map(({ provider, id, name }) => ({ provider, id, name })),
    });
  }
  yield* annotateSession(session);
  return session;
});

export const findSession = Effect.fn("findSession")(function* (rawTarget: string) {
  const target = normalizeTarget(rawTarget);
  const sessions = yield* liveSessions(target);
  if (!sessions.some((session) => session.id === target || session.name === target)) {
    const archived = yield* findArchivedSessions(target);
    if (archived.length > 0) {
      return yield* new SessionArchived({ target, ids: archived.map((session) => session.id) });
    }
  }
  return yield* findOneSession({ target, sessions, archived: false }).pipe(
    Effect.tap(annotateSession),
  );
});

export const findArchivedSession = Effect.fn("findArchivedSession")(function* (rawTarget: string) {
  const target = normalizeTarget(rawTarget);
  return yield* findOneSession({
    target,
    sessions: yield* findArchivedSessions(target),
    archived: true,
  }).pipe(Effect.tap(annotateSession));
});

export const requireSessionArguments = ({
  command,
  archived,
  targets,
}: {
  readonly command: string;
  readonly archived: boolean;
  readonly targets: readonly string[];
}) =>
  Effect.gen(function* () {
    if (targets.some((target) => normalizeTarget(target) === "")) {
      return yield* new SessionArgumentMissing({ command, archived });
    }
  });
