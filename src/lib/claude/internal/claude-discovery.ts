import { Array as EffectArray, Effect, Option, Result } from "effect";
import type { Context, FileSystem, Path, PlatformError } from "effect";
import type { ChildProcessSpawner } from "effect/process";

import type { Output } from "../../../shared/output.ts";
import type { SessionStatus } from "../../../shared/session.ts";
import type { Platform } from "../../platform/index.ts";
import {
  describeCatalogSession,
  groupSources,
  needsAgentName,
  needsLastMessageTime,
} from "./claude-catalog.ts";
import { findInHistory, listHistory } from "./claude-history.ts";
import type { HistorySession } from "./claude-history.ts";
import {
  isProcessAlive,
  listClaudeSessionFiles,
  readClaudeSessionFile,
  runsASavedSession,
} from "./claude-session-files.ts";
import { ClaudeRegistration, ClaudeSession } from "./claude-session.ts";
import {
  findTranscript,
  isProgrammaticRun,
  isProgrammaticTranscript,
  isTurnFinished,
  listTranscripts,
  readAgentName,
  readLastMessageTime,
} from "./claude-transcript.ts";
import { readDesktopSessions } from "./read-desktop-sessions.ts";

const APPROVAL_REQUESTS: ReadonlySet<string> = new Set([
  "permission prompt",
  "sandbox request",
  "worker request",
]);

const describeWaiting = (waitingFor: string | undefined): typeof SessionStatus.Type => {
  const isApproval =
    waitingFor !== undefined &&
    (waitingFor.startsWith("approve ") || APPROVAL_REQUESTS.has(waitingFor));
  return isApproval ? "waiting-for-approval" : "waiting-for-input";
};

export const makeSessionFileReader =
  (services: Context.Context<Effect.Services<ReturnType<typeof readClaudeSessionFile>>>) =>
  (file: string) =>
    readClaudeSessionFile(file).pipe(Effect.provide(services));

export const readSessionFiles = ({
  sessions,
  nudgeOutput,
  services,
}: {
  readonly sessions: string;
  readonly nudgeOutput: Output["Service"];
  readonly services: Context.Context<
    Effect.Services<ReturnType<typeof listClaudeSessionFiles | typeof readClaudeSessionFile>>
  >;
}) =>
  Effect.gen(function* () {
    const files = yield* Effect.forEach(yield* listClaudeSessionFiles(sessions), (path) =>
      readClaudeSessionFile(path).pipe(
        Effect.map((read) => Option.map(read, (file) => ({ path, file }))),
        Effect.catchTag("ClaudeSessionFileUnreadable", (unreadable) =>
          nudgeOutput.warnOnce({ key: path, warning: unreadable }).pipe(Effect.as(Option.none())),
        ),
      ),
    );
    return EffectArray.getSomes(files);
  }).pipe(Effect.provide(services));

const describeSessionStatus = ({
  nudgeOutput,
  services,
  status,
  waitingFor,
  transcript,
}: {
  readonly nudgeOutput: Output["Service"];
  readonly services: Context.Context<FileSystem.FileSystem>;
  readonly status: string;
  readonly waitingFor: string | undefined;
  readonly transcript: Option.Option<string>;
}) =>
  Effect.gen(function* () {
    if (status === "idle") {
      return (yield* isTurnFinished({ nudgeOutput, services, transcript })) ? "idle" : "running";
    }
    if (status === "waiting") {
      return describeWaiting(waitingFor);
    }
    return status === "busy" ? "running" : "unknown";
  });

const listRegisteredSessions = ({
  root,
  fileSystem,
  platform,
  nudgeOutput,
  services,
  sessionFiles,
}: {
  readonly root: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly platform: Platform["Service"];
  readonly nudgeOutput: Output["Service"];
  readonly services: Context.Context<
    Effect.Services<ReturnType<typeof runsASavedSession>> | FileSystem.FileSystem
  >;
  readonly sessionFiles: ReturnType<typeof readSessionFiles>;
}) =>
  Effect.gen(function* () {
    const found = yield* Effect.forEach(yield* sessionFiles, ({ path, file }) =>
      Effect.gen(function* () {
        const isStillItsProcess =
          isProcessAlive(file.pid) &&
          (file.procStart === undefined ||
            Option.contains(yield* platform.readProcessStart(file.pid), file.procStart));
        const isListed =
          isStillItsProcess &&
          !isProgrammaticRun({ entrypoint: file.entrypoint, kind: file.kind }) &&
          (yield* runsASavedSession(file.pid).pipe(Effect.provide(services)));
        if (!isListed) {
          return [];
        }
        const transcript = yield* findTranscript({ root, fileSystem, id: file.sessionId });
        const status = yield* describeSessionStatus({
          nudgeOutput,
          services,
          status: file.status ?? "idle",
          waitingFor: file.waitingFor,
          transcript,
        });
        const session = ClaudeSession.make({
          provider: "Claude",
          appTitle: Option.none(),
          appState: "absent",
          id: file.sessionId,
          name: file.name ?? "",
          status,
          project: file.cwd ?? "",
          section: "",
          directory: file.cwd ?? "",
          transcript,
          lastActiveAt: new Date(file.updatedAt ?? file.startedAt).toISOString(),
          handle: ClaudeRegistration.make({ file: path }),
        });
        return [session];
      }),
    );
    return found.flat();
  });

export const findSessionRunningIn = ({
  platform,
  services,
  sessionFiles,
  processes,
}: {
  readonly platform: Platform["Service"];
  readonly services: Context.Context<
    Effect.Services<ReturnType<Platform["Service"]["readProcessStart"]>>
  >;
  readonly sessionFiles: ReturnType<typeof readSessionFiles>;
  readonly processes: readonly number[];
}) =>
  Effect.gen(function* () {
    const files = yield* sessionFiles;
    for (const pid of processes) {
      const found = files.find(({ file }) => file.pid === pid);
      const isSameProcess =
        found?.file.procStart !== undefined &&
        Option.contains(yield* platform.readProcessStart(pid), found.file.procStart);
      if (isSameProcess) {
        return Option.some({
          pid,
          id: found.file.sessionId,
          name: found.file.name ?? found.file.sessionId,
        });
      }
    }
    return Option.none();
  }).pipe(Effect.provide(services));

const TRANSCRIPT_READS = 16;

const HISTORY_WARNING = "claude-history";

export const listClaudeSessions = ({
  root,
  fileSystem,
  platform,
  nudgeOutput,
  services,
  sessionFiles,
  only,
}: {
  readonly root: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly platform: Platform["Service"];
  readonly nudgeOutput: Output["Service"];
  readonly services: Context.Context<
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path | Platform
  >;
  readonly sessionFiles: ReturnType<typeof readSessionFiles>;
  readonly only: Option.Option<string>;
}) =>
  Effect.gen(function* () {
    const isWanted = (id: string) =>
      Option.getOrElse(
        Option.map(only, (wanted) => wanted === id),
        () => true,
      );
    const live = (yield* listRegisteredSessions({
      root,
      fileSystem,
      platform,
      nudgeOutput,
      services,
      sessionFiles,
    })).filter((session) => isWanted(session.id));
    const desktop = yield* Effect.forEach(yield* readDesktopSessions, (read) =>
      Result.isFailure(read)
        ? nudgeOutput
            .warnOnce({ key: read.failure.path, warning: read.failure })
            .pipe(Effect.as([]))
        : Effect.succeed([read.success]),
    );
    const transcripts = yield* listTranscripts({ root, fileSystem });
    const isPersonRun = (saved: typeof HistorySession.Type) =>
      Option.match(Option.fromUndefinedOr(transcripts.get(saved.id)), {
        onNone: () => Effect.succeed(true),
        onSome: (path) =>
          Effect.map(isProgrammaticTranscript(path), (isProgrammatic) => !isProgrammatic),
      });
    const saved = yield* Option.match(only, {
      onNone: () => listHistory,
      onSome: findInHistory,
    }).pipe(
      Effect.catchTag("ClaudeHistoryUnreadable", (unreadable) =>
        nudgeOutput.warnOnce({ key: HISTORY_WARNING, warning: unreadable }).pipe(Effect.as([])),
      ),
    );
    const history = Option.isNone(only) ? saved : yield* Effect.filter(saved, isPersonRun);
    const groups = groupSources({ live, desktop: desktop.flat(), history }).filter((group) =>
      isWanted(group.id),
    );
    return yield* Effect.forEach(
      groups,
      (group) =>
        Effect.gen(function* () {
          const transcript = Option.orElse(
            Option.flatMap(group.live, (running) => running.transcript),
            () => Option.fromUndefinedOr(transcripts.get(group.id)),
          );
          const readIf = <Found>(
            isNeeded: boolean,
            read: (
              path: string,
            ) => Effect.Effect<
              Option.Option<Found>,
              PlatformError.PlatformError,
              FileSystem.FileSystem
            >,
          ) =>
            Option.match(
              Option.filter(transcript, () => isNeeded),
              { onNone: () => Effect.succeedNone, onSome: read },
            );
          return describeCatalogSession({
            group,
            transcript,
            lastMessageAt: yield* readIf(needsLastMessageTime(group), readLastMessageTime),
            agentName: yield* readIf(needsAgentName(group), readAgentName),
          });
        }),
      { concurrency: TRANSCRIPT_READS },
    );
  }).pipe(Effect.provide(services));
