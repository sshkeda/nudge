import {
  Array as EffectArray,
  Context,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Match,
  Option,
  Path,
  Schema,
} from "effect";
import { SecureRandom } from "effect/crypto";
import type { ChildProcessSpawner } from "effect/process";

import { envelopeForClaude, envelopeForNewSession } from "../../../shared/message-envelope.ts";
import type { Sender } from "../../../shared/message-envelope.ts";
import { Output } from "../../../shared/output.ts";
import { CLAUDE_CONFIG_DIRECTORY } from "../../../shared/read-environment.ts";
import { runCommand } from "../../../shared/run-command.ts";
import type { Speed } from "../../../shared/speed.ts";
import { waitUntil } from "../../../shared/wait-until.ts";
import { Platform } from "../../platform/index.ts";
import {
  checkResumedBridge,
  REMOTE_CONTROL_WAIT,
  planStoppedArchive,
  readBridgeIds,
  waitForRemoteControl,
} from "./claude-archive.ts";
import {
  findSessionRunningIn,
  listClaudeSessions,
  makeSessionFileReader,
  readSessionFiles,
} from "./claude-discovery.ts";
import { renameSavedSession } from "./claude-history.ts";
import {
  deliverResumedPrompt,
  hasJobEnded,
  isJobProcessAlive,
  jobStateFile,
  finishResume,
  resume,
  startJob,
  startResume,
  waitForFirstReply,
  waitForJobSession,
} from "./claude-jobs.ts";
import { readClaudeModelChoice } from "./claude-model-choice.ts";
import { deliverThroughSocket, sendToSessionSocket } from "./claude-peer.ts";
import { describeSession, isProcessAlive } from "./claude-session-files.ts";
import { ClaudeRegistration } from "./claude-session.ts";
import type { ClaudeSession } from "./claude-session.ts";
import { makeNewRecordCheck } from "./claude-transcript.ts";
import {
  ClaudeAnsweredInStandardMode,
  ClaudeFastModeUnconfirmed,
  ClaudeFirstRequestFailed,
  ClaudeModelChangeUnsupported,
  ClaudeNotOnPath,
  ClaudeSessionEndedBeforeRename,
  ClaudeSessionNotStopped,
  ClaudeRemoteControlNotReconnected,
  ClaudeSpeedChangeUnsupported,
  ClaudeWarning,
  orClaudeMissing,
} from "./errors.ts";
import { listClaudeModels } from "./model-list.ts";

const isRunning = Schema.is(ClaudeRegistration);

const isOpen = (session: typeof ClaudeSession.Type) =>
  isRunning(session.handle) || session.appState === "listed";

const STOP_WAIT = "60 seconds";

const CLAUDE_WARNING = /^Warning: (?<warning>.+)$/gmu;

const make = Effect.gen(function* () {
  const root = yield* CLAUDE_CONFIG_DIRECTORY;
  const sessions = `${root}/sessions`;
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const platform = yield* Platform;
  const services = yield* Effect.context<
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path | Platform
  >();

  const nudgeOutput = yield* Output;

  const readSessionFile = makeSessionFileReader(services);

  const sessionFiles = readSessionFiles({ sessions, nudgeOutput, services });

  const listing = { root, fileSystem, platform, nudgeOutput, services, sessionFiles };

  const jobs = { root, sessions, fileSystem, nudgeOutput, sessionFiles };

  const peer = { fileSystem, paths, platform, sessions, readSessionFile };

  const listSessions = (only: Option.Option<string>) => listClaudeSessions({ ...listing, only });

  const stopRuntime = ({
    session,
    registration,
    file,
  }: {
    readonly session: typeof ClaudeSession.Type;
    readonly registration: string;
    readonly file: Effect.Success<typeof sessionFiles>[number]["file"];
  }) =>
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan(
        "nudge.claude.archive.stop",
        file.jobId === undefined ? "signal" : "job",
      );
      if (file.jobId === undefined) {
        process.kill(file.pid, "SIGTERM");
      } else {
        yield* runCommand("claude", ["stop", file.jobId]);
      }
      yield* waitUntil({
        watch: Effect.succeed([
          registration,
          ...(file.jobId === undefined ? [] : [jobStateFile({ root, jobId: file.jobId })]),
        ]),
        done: Effect.gen(function* () {
          const hasExited = !(yield* fileSystem.exists(registration)) || !isProcessAlive(file.pid);
          return (
            hasExited &&
            (file.jobId === undefined ||
              (yield* hasJobEnded({ root, fileSystem, jobId: file.jobId })))
          );
        }),
      });
    }).pipe(
      Effect.timeoutOrElse({
        duration: STOP_WAIT,
        orElse: () => Effect.fail(new ClaudeSessionNotStopped({ session, waited: STOP_WAIT })),
      }),
    );

  const findRuntime = (
    matches: (file: Effect.Success<typeof sessionFiles>[number]["file"]) => boolean,
  ) =>
    Effect.gen(function* () {
      for (const found of yield* sessionFiles) {
        const isItsProcess =
          matches(found.file) &&
          isProcessAlive(found.file.pid) &&
          (found.file.procStart === undefined ||
            Option.contains(
              yield* platform.readProcessStart(found.file.pid),
              found.file.procStart,
            ));
        if (isItsProcess) {
          return Option.some(found);
        }
      }
      return Option.none();
    });

  const stopJobNudgeStarted = (jobId: string, session: typeof ClaudeSession.Type) =>
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan("nudge.claude.archive.stop", "job");
      yield* runCommand("claude", ["stop", jobId]);
      yield* waitUntil({
        watch: Effect.succeed([sessions, jobStateFile({ root, jobId })]),
        done: Effect.gen(function* () {
          const isAlive = yield* isJobProcessAlive({ sessionFiles, jobId });
          return !isAlive && (yield* hasJobEnded({ root, fileSystem, jobId }));
        }),
      });
    }).pipe(
      Effect.timeoutOrElse({
        duration: STOP_WAIT,
        orElse: () => Effect.fail(new ClaudeSessionNotStopped({ session, waited: STOP_WAIT })),
      }),
    );

  const archiveThroughRemoteControl = ({
    session,
    bridgeId,
  }: {
    readonly session: typeof ClaudeSession.Type;
    readonly bridgeId: string;
  }) =>
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan("nudge.claude.archive.path", "remote-control-repair");
      const job = yield* startResume({ ...jobs, session, prompt: [] });
      yield* Effect.gen(function* () {
        yield* finishResume({ ...jobs, session, job }).pipe(
          Effect.timeoutOrElse({
            duration: REMOTE_CONTROL_WAIT,
            orElse: () =>
              Effect.fail(
                new ClaudeRemoteControlNotReconnected({
                  session: describeSession(session),
                  bridgeId,
                  waited: REMOTE_CONTROL_WAIT,
                }),
              ),
          }),
        );
        const found = yield* waitForRemoteControl({
          root,
          sessions,
          fileSystem,
          platform,
          sessionFiles,
          session,
          jobId: job.id,
          expected: bridgeId,
        });
        yield* checkResumedBridge({ session, expected: bridgeId, found });
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit) ? stopJobNudgeStarted(job.id, session) : Effect.void,
        ),
      );
      yield* stopJobNudgeStarted(job.id, session);
    });

  const archiveStoppedSession = (session: typeof ClaudeSession.Type) =>
    Effect.gen(function* () {
      const running = yield* findRuntime((file) => file.sessionId === session.id);
      if (Option.isSome(running)) {
        yield* Effect.annotateCurrentSpan("nudge.claude.archive.path", "session-file");
        yield* stopRuntime({ session, registration: running.value.path, file: running.value.file });
        return "archived" as const;
      }
      const { bridgeIds, unfinished } = yield* readBridgeIds({
        root,
        fileSystem,
        sessionFiles,
        sessionId: session.id,
      });
      const bridgeId = yield* planStoppedArchive({ session, bridgeIds, unfinished });
      if (Option.isNone(bridgeId)) {
        yield* Effect.annotateCurrentSpan("nudge.claude.archive.path", "nothing-to-archive");
        return "unchanged" as const;
      }
      yield* archiveThroughRemoteControl({ session, bridgeId: bridgeId.value });
      return "archived" as const;
    });

  const archiveRegisteredSession = ({
    session,
    registration,
  }: {
    readonly session: typeof ClaudeSession.Type;
    readonly registration: string;
  }) =>
    Effect.gen(function* () {
      const running = Option.filter(yield* readSessionFile(registration), (file) =>
        isProcessAlive(file.pid),
      );
      if (Option.isNone(running)) {
        return yield* archiveStoppedSession(session);
      }
      yield* Effect.annotateCurrentSpan("nudge.claude.archive.path", "session-file");
      yield* stopRuntime({ session, registration, file: running.value });
      return "archived" as const;
    });

  const renameRunningSession = <Failure>({
    session,
    name,
    registration,
    inHistory,
  }: {
    readonly session: typeof ClaudeSession.Type;
    readonly name: string;
    readonly registration: string;
    readonly inHistory: Effect.Effect<{ readonly appTitle: Option.Option<string> }, Failure>;
  }) =>
    Effect.gen(function* () {
      const current = Option.filter(yield* readSessionFile(registration), (file) =>
        isProcessAlive(file.pid),
      );
      if (Option.isNone(current)) {
        return yield* inHistory;
      }
      yield* Effect.annotateCurrentSpan({
        "nudge.claude.rename.path": "peer-socket",
        "nudge.rename.required": current.value.name !== name,
      });
      if (current.value.name === name) {
        return { appTitle: Option.none<string>() };
      }
      yield* sendToSessionSocket({
        ...peer,
        session,
        registration,
        frame: (from) => ({ type: "control", action: "rename", name, from }),
      });
      yield* waitUntil({
        watch: Effect.succeed([registration]),
        done: Effect.gen(function* () {
          const found = yield* readSessionFile(registration);
          if (Option.isNone(found)) {
            return yield* new ClaudeSessionEndedBeforeRename({
              session: describeSession(session),
            });
          }
          return found.value.name === name;
        }),
      });
      return { appTitle: Option.none<string>() };
    });

  const app = {
    list: Effect.map(listSessions(Option.none()), (found) =>
      found.filter((session) => isOpen(session)),
    ),

    findTarget: (target: string) =>
      Effect.map(listSessions(Option.none()), (found) =>
        found.filter(
          (session) =>
            (isOpen(session) || session.appState !== "archived") &&
            (session.id === target || session.name === target),
        ),
      ),

    findSessionRunningIn: (processes: readonly number[]) =>
      findSessionRunningIn({ platform, services, sessionFiles, processes }),

    listArchived: Effect.map(listSessions(Option.none()), (found) =>
      found.filter((session) => !isOpen(session)),
    ),

    findArchived: (target: string) =>
      Effect.map(listSessions(Option.none()), (found) =>
        found.filter(
          (session) => !isOpen(session) && (session.id === target || session.name === target),
        ),
      ),

    unarchive: Effect.fn("claude.unarchive")(function* (session: typeof ClaudeSession.Type) {
      yield* Effect.annotateCurrentSpan("nudge.session.id", session.id);
      return yield* Match.valueTags(session.handle, {
        ClaudeRegistration: () => Effect.succeed("unchanged" as const),
        ClaudeSavedSession: () =>
          isOpen(session)
            ? Effect.succeed("unchanged" as const)
            : Effect.as(resume({ ...jobs, session, prompt: [] }), "unarchived" as const),
      });
    }, Effect.provide(services)),

    listModels: listClaudeModels().pipe(Effect.provide(services)),

    readModelChoice: (session: typeof ClaudeSession.Type) =>
      readClaudeModelChoice(session.transcript).pipe(Effect.provide(services)),

    create: Effect.fn("claude.create")(function* ({
      prompt,
      sender,
      name,
      model,
      effort,
      speed,
    }: {
      readonly prompt: string;
      readonly sender: Option.Option<typeof Sender.Type>;
      readonly name: Option.Option<string>;
      readonly model: Option.Option<string>;
      readonly effort: Option.Option<string>;
      readonly speed: typeof Speed.Type;
    }) {
      const isFast = speed === "fast";
      const readBackName = (sessionId: string) =>
        Option.isSome(name)
          ? Effect.succeed(name)
          : Effect.map(listSessions(Option.some(sessionId)), (found) =>
              Option.filter(
                Option.map(EffectArray.head(found), (session) => session.name),
                (shown) => shown !== sessionId,
              ),
            );
      const firstPrompt = envelopeForNewSession({ prompt, sender });
      const job = yield* startJob({
        root,
        fileSystem,
        commandArguments: [
          ...Option.match(name, { onNone: () => [], onSome: (value) => [`--name=${value}`] }),
          ...Option.match(model, { onNone: () => [], onSome: (value) => [`--model=${value}`] }),
          ...Option.match(effort, { onNone: () => [], onSome: (value) => [`--effort=${value}`] }),
          `--fast-mode=${isFast ? "on" : "off"}`,
          ...(firstPrompt ? ["--", firstPrompt] : []),
        ],
        shownArguments: 0,
        resumedSessionId: Option.none(),
      }).pipe(
        Effect.catchReason("PlatformError", "NotFound", (notFound) =>
          orClaudeMissing(notFound, () => new ClaudeNotOnPath({ attempt: "starting" })),
        ),
      );
      if (!prompt) {
        const { sessionId } = yield* waitForJobSession({
          root,
          sessions,
          fileSystem,
          sessionFiles,
          job,
          sessionId: Option.none(),
        });
        yield* Effect.annotateCurrentSpan("nudge.session.id", sessionId);
        return {
          id: sessionId,
          name: yield* readBackName(sessionId),
          directory: process.cwd(),
          isOutsideAnyProject: false,
          warnings: EffectArray.empty<ClaudeWarning>(),
        };
      }
      const {
        sessionId,
        firstReply,
        speed: firstReplySpeed,
      } = yield* waitForFirstReply({ ...jobs, job });
      yield* Effect.annotateCurrentSpan({
        "nudge.session.id": sessionId,
        "nudge.claude.firstReply.apiError": firstReply.isApiErrorMessage === true,
        "nudge.claude.firstReply.speed": Option.getOrElse(firstReplySpeed, () => "unknown"),
      });
      const shownName = yield* readBackName(sessionId);
      const failedSession = { id: sessionId, name: Option.getOrElse(shownName, () => sessionId) };
      const logs = yield* runCommand("claude", ["logs", job.id]);
      const logWarnings = [...Bun.stripANSI(logs).matchAll(CLAUDE_WARNING)].map(
        (match) => new ClaudeWarning({ warning: match.groups?.["warning"] ?? "" }),
      );
      if (firstReply.isApiErrorMessage === true) {
        yield* runCommand("claude", ["stop", job.id]);
        yield* waitUntil({
          watch: Effect.succeed([sessions]),
          done: Effect.map(
            isJobProcessAlive({ sessionFiles, jobId: job.id }),
            (isAlive) => !isAlive,
          ),
        });
        const replyText = firstReply.message.content.map((part) => part.text ?? "").join("");
        return yield* new ClaudeFirstRequestFailed({
          session: failedSession,
          reply: replyText,
        });
      }
      const lostFastMode = isFast && Option.contains(firstReplySpeed, "standard");
      if (lostFastMode) {
        return yield* new ClaudeAnsweredInStandardMode({ session: failedSession });
      }
      const isFastUnconfirmed = isFast && Option.isNone(firstReplySpeed);
      return {
        id: sessionId,
        name: shownName,
        directory: process.cwd(),
        isOutsideAnyProject: false,
        warnings: [
          ...logWarnings,
          ...(isFastUnconfirmed ? [new ClaudeFastModeUnconfirmed({ session: failedSession })] : []),
        ],
      };
    }, Effect.provide(services)),

    checkSend: Effect.fn("claude.checkSend")(function* ({
      session,
      model,
      effort,
      speed,
    }: {
      readonly session: typeof ClaudeSession.Type;
      readonly model: Option.Option<string>;
      readonly effort: Option.Option<string>;
      readonly speed: Option.Option<typeof Speed.Type>;
    }) {
      const changesModelOrEffort = Option.isSome(model) || Option.isSome(effort);
      if (changesModelOrEffort) {
        return yield* new ClaudeModelChangeUnsupported({ session: describeSession(session) });
      }
      if (Option.isSome(speed)) {
        return yield* new ClaudeSpeedChangeUnsupported({ session: describeSession(session) });
      }
    }),

    send: Effect.fn("claude.send")(
      function* ({
        session,
        message,
        sender,
      }: {
        readonly session: typeof ClaudeSession.Type;
        readonly message: string;
        readonly sender: Option.Option<typeof Sender.Type>;
        readonly model: Option.Option<string>;
        readonly effort: Option.Option<string>;
        readonly speed: Option.Option<typeof Speed.Type>;
      }) {
        const content = envelopeForClaude({ message, sender });
        const hasNewRecord = yield* makeNewRecordCheck({ root, fileSystem, id: session.id });
        const messageId = yield* (yield* SecureRandom.SecureRandom).uuidV4();
        const resumed = {
          path: "resume-job",
          deliver: deliverResumedPrompt({ ...jobs, session, content, hasNewRecord }),
        } as const;
        const delivery = Match.valueTags(session.handle, {
          ClaudeRegistration: ({ file }) =>
            ({
              path: "peer-socket",
              deliver: deliverThroughSocket({
                ...peer,
                root,
                session,
                registration: file,
                messageId,
                content,
                hasNewRecord,
              }),
            }) as const,
          ClaudeSavedSession: () => resumed,
        });
        yield* Effect.annotateCurrentSpan({
          "nudge.message.id": messageId,
          "nudge.session.id": session.id,
          "nudge.delivery.path": delivery.path,
        });
        yield* delivery.deliver;
        yield* Effect.annotateCurrentSpan("nudge.status", "delivered");
        return { messageId, status: "delivered" as const };
      },
      Effect.scoped,
      Effect.provide(services),
    ),

    rename: Effect.fn("claude.rename")(
      function* ({
        session,
        name,
      }: {
        readonly session: typeof ClaudeSession.Type;
        readonly name: string;
      }) {
        yield* Effect.annotateCurrentSpan("nudge.session.id", session.id);
        const inHistory = renameSavedSession({ session, name });
        return yield* Match.valueTags(session.handle, {
          ClaudeRegistration: ({ file }) =>
            renameRunningSession({ session, name, registration: file, inHistory }),
          ClaudeSavedSession: () => inHistory,
        });
      },
      Effect.scoped,
      Effect.provide(services),
    ),

    archive: Effect.fn("claude.archive")(function* (session: typeof ClaudeSession.Type) {
      yield* Effect.annotateCurrentSpan("nudge.session.id", session.id);
      return yield* Match.valueTags(session.handle, {
        ClaudeRegistration: ({ file }) => archiveRegisteredSession({ session, registration: file }),
        ClaudeSavedSession: () => archiveStoppedSession(session),
      });
    }, Effect.provide(services)),
  };
  return app;
});

export class Claude extends Context.Service<Claude, Effect.Success<typeof make>>()(
  "nudge/Claude",
) {}

export const claudeLayer = Layer.effect(Claude, make);
