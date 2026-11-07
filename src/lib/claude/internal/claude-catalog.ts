import { Option, Schema } from "effect";

import { HistorySession } from "./claude-history.ts";
import { ClaudeSavedSession, ClaudeSession } from "./claude-session.ts";
import { DesktopSession } from "./read-desktop-sessions.ts";

export const desktopIdOf = (desktop: typeof DesktopSession.Type) =>
  Option.getOrElse(desktop.cliSessionId, () => desktop.sessionId);

const SourceGroup = Schema.Struct({
  id: Schema.String,
  live: Schema.Option(ClaudeSession),
  desktop: Schema.Option(DesktopSession),
  history: Schema.Option(HistorySession),
});

export const groupSources = ({
  live,
  desktop,
  history,
}: {
  readonly live: readonly (typeof ClaudeSession.Type)[];
  readonly desktop: readonly (typeof DesktopSession.Type)[];
  readonly history: readonly (typeof HistorySession.Type)[];
}) => {
  const groups = new Map<string, typeof SourceGroup.Type>();
  const groupOf = (id: string) =>
    groups.get(id) ??
    SourceGroup.make({ id, live: Option.none(), desktop: Option.none(), history: Option.none() });
  for (const record of desktop) {
    const group = groupOf(desktopIdOf(record));
    const isNewer = Option.match(group.desktop, {
      onNone: () => true,
      onSome: (kept) => record.lastActivityAt > kept.lastActivityAt,
    });
    if (isNewer) {
      groups.set(group.id, { ...group, desktop: Option.some(record) });
    }
  }
  for (const saved of history) {
    const group = groupOf(saved.id);
    if (Option.isNone(group.history)) {
      groups.set(group.id, { ...group, history: Option.some(saved) });
    }
  }
  for (const running of live) {
    const group = groupOf(running.id);
    if (Option.isNone(group.live)) {
      groups.set(group.id, { ...group, live: Option.some(running) });
    }
  }
  return [...groups.values()];
};

const desktopTitleOf = (group: typeof SourceGroup.Type) =>
  Option.flatMap(group.desktop, (desktop) => desktop.title);

const historyTitleOf = (group: typeof SourceGroup.Type) =>
  Option.flatMap(group.history, (history) => history.title);

export const needsAgentName = (group: typeof SourceGroup.Type) =>
  Option.isNone(desktopTitleOf(group)) &&
  Option.isNone(group.live) &&
  Option.isNone(historyTitleOf(group));

export const needsLastMessageTime = (group: typeof SourceGroup.Type) =>
  Option.isNone(group.desktop);

const firstSome = <Value>(...options: readonly Option.Option<Value>[]) =>
  Option.firstSomeOf(options);

export const describeCatalogSession = ({
  group,
  transcript,
  lastMessageAt,
  agentName,
}: {
  readonly group: typeof SourceGroup.Type;
  readonly transcript: Option.Option<string>;
  readonly lastMessageAt: Option.Option<number>;
  readonly agentName: Option.Option<string>;
}) => {
  const { id, live, desktop, history } = group;
  const directory = firstSome(
    Option.flatMap(desktop, (found) => found.directory),
    Option.filter(
      Option.map(live, (running) => running.directory),
      (found) => found !== "",
    ),
    Option.flatMap(history, (saved) => saved.directory),
  );
  const name = firstSome(
    desktopTitleOf(group),
    Option.filter(
      Option.map(live, (running) => running.name),
      (shown) => shown.trim() !== "",
    ),
    historyTitleOf(group),
    agentName,
  );
  const lastActive = firstSome(
    Option.map(desktop, (found) => new Date(found.lastActivityAt).toISOString()),
    Option.map(lastMessageAt, (time) => new Date(time).toISOString()),
    Option.filter(
      Option.map(live, (running) => running.lastActiveAt),
      (time) => time !== "",
    ),
    Option.map(
      Option.flatMap(history, (saved) => saved.createdAt),
      (time) => new Date(time).toISOString(),
    ),
  );
  const isArchived = Option.exists(desktop, (found) => found.isArchived);
  return ClaudeSession.make({
    provider: "Claude",
    appTitle: desktopTitleOf(group),
    appState: Option.match(desktop, {
      onNone: () => "absent" as const,
      onSome: (found) => (found.isArchived ? ("archived" as const) : ("listed" as const)),
    }),
    id,
    name: Option.getOrElse(name, () => id),
    status: Option.match(live, {
      onNone: () => (isArchived ? "archived" : "stopped"),
      onSome: (running) => running.status,
    }),
    project: Option.getOrElse(
      Option.orElse(
        Option.flatMap(desktop, (found) => found.originDirectory),
        () => directory,
      ),
      () => "",
    ),
    section: "",
    directory: Option.getOrElse(directory, () => ""),
    transcript: Option.orElse(
      Option.flatMap(live, (running) => running.transcript),
      () => transcript,
    ),
    lastActiveAt: Option.getOrElse(lastActive, () => ""),
    handle: Option.match(live, {
      onNone: () => ClaudeSavedSession.make({}),
      onSome: (running) => running.handle,
    }),
  });
};
