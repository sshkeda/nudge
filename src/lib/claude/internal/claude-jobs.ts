import { Effect, Option, Result, Schema } from "effect";
import type { FileSystem } from "effect";

import type { Output } from "../../../shared/output.ts";
import { toOneLine } from "../../../shared/print-line.ts";
import { runCommand } from "../../../shared/run-command.ts";
import type { CommandFailed } from "../../../shared/run-command.ts";
import type { Session } from "../../../shared/session.ts";
import { makeAppendedLineReader, START_OF_FILE } from "../../../shared/transcript.ts";
import { waitFor } from "../../../shared/wait-until.ts";
import type { readSessionFiles } from "./claude-discovery.ts";
import { describeSession, isProcessAlive } from "./claude-session-files.ts";
import {
  decodeTranscriptLines,
  findTranscript,
  isQueued,
  isTyped,
  readWorkingDirectory,
  replySpeedOf,
  transcriptPaths,
} from "./claude-transcript.ts";
import type { makeNewRecordCheck } from "./claude-transcript.ts";
import {
  ClaudeHomeNotTrusted,
  ClaudeJobEnded,
  ClaudeJobIdNotPrinted,
  ClaudeJobStateUnknown,
  ClaudeJobStateUnreadable,
  ClaudeNotOnPathToResume,
  ClaudeResumedAsCopy,
  ClaudeSessionDirectoryUnknown,
  ClaudeWorkspaceNotTrusted,
  orClaudeMissing,
} from "./errors.ts";

const JobState = Schema.fromJsonString(
  Schema.Struct({
    state: Schema.String,
    detail: Schema.optional(Schema.NullOr(Schema.String)),
    sessionId: Schema.optional(Schema.String),
    tempo: Schema.optional(Schema.NullOr(Schema.String)),
    bridgeSessionId: Schema.optional(Schema.String),
  }),
);

const STILL_STARTING_JOB_STATES: ReadonlySet<string> = new Set([
  "starting",
  "running",
  "resuming",
  "adopted",
  "crashed",
  "working",
  "busy",
  "shell",
  "idle",
  "waiting",
]);

const WAITING_FOR_INPUT_JOB_STATES: ReadonlySet<string> = new Set(["blocked", "done"]);

const ENDED_JOB_STATES: ReadonlySet<string> = new Set(["failed", "stopped"]);

const BACKGROUNDED = /^backgrounded · (?<jobId>\S+)/mu;

const JOB_ID_LENGTH = 8;

export const jobIdOf = (sessionId: string) => sessionId.slice(0, JOB_ID_LENGTH);

const WORKSPACE_NOT_TRUSTED = /Workspace not trusted\. Run `claude` in (?<directory>.+?) once/u;

const HOME_NOT_TRUSTED =
  /Workspace not trusted\. The home directory is trusted one session at a time/u;

export const jobStateFile = ({ root, jobId }: { readonly root: string; readonly jobId: string }) =>
  `${root}/jobs/${jobId}/state.json`;

const startInBackground = ({
  claudeArguments,
  shownArguments,
  workingDirectory,
}: {
  readonly claudeArguments: readonly string[];
  readonly shownArguments: number;
  readonly workingDirectory?: string;
}) =>
  runCommand("claude", ["--bg", ...claudeArguments], {
    workingDirectory,
    shownArguments: shownArguments + 1,
  }).pipe(
    Effect.catchTag("CommandFailed", (failed) => {
      const directory = WORKSPACE_NOT_TRUSTED.exec(failed.standardError)?.groups?.["directory"];
      if (HOME_NOT_TRUSTED.test(failed.standardError)) {
        return Effect.fail<ClaudeHomeNotTrusted | ClaudeWorkspaceNotTrusted | CommandFailed>(
          new ClaudeHomeNotTrusted(),
        );
      }
      return Effect.fail(
        directory === undefined ? failed : new ClaudeWorkspaceNotTrusted({ directory }),
      );
    }),
  );

const readJobState = ({
  root,
  fileSystem,
  jobId,
}: {
  readonly root: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly jobId: string;
}) =>
  Effect.gen(function* () {
    const path = jobStateFile({ root, jobId });
    const text = yield* fileSystem.readFileString(path).pipe(
      Effect.asSome,
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
      Effect.mapError(
        (error) => new ClaudeJobStateUnreadable({ jobId, path, reason: toOneLine(error.message) }),
      ),
    );
    return { path, text };
  });

export const startJob = Effect.fn("claude.startJob")(function* ({
  root,
  fileSystem,
  commandArguments,
  shownArguments,
  workingDirectory,
  resumedSessionId,
}: {
  readonly root: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly commandArguments: readonly string[];
  readonly shownArguments: number;
  readonly workingDirectory?: string;
  readonly resumedSessionId: Option.Option<string>;
}) {
  const resumedJobId = Option.map(resumedSessionId, jobIdOf);
  const stateBefore = Option.isSome(resumedJobId)
    ? (yield* readJobState({ root, fileSystem, jobId: resumedJobId.value })).text
    : Option.none();
  const output = yield* startInBackground({
    claudeArguments: commandArguments,
    shownArguments,
    ...(workingDirectory === undefined ? {} : { workingDirectory }),
  });
  const jobId = BACKGROUNDED.exec(Bun.stripANSI(output))?.groups?.["jobId"];
  if (jobId === undefined) {
    return yield* new ClaudeJobIdNotPrinted({ output });
  }
  yield* Effect.annotateCurrentSpan("nudge.claude.job.id", jobId);
  const isSameJob = Option.exists(resumedJobId, (resumed) => resumed === jobId);
  yield* Effect.annotateCurrentSpan({
    "nudge.claude.job.resumed": Option.isSome(resumedSessionId),
    "nudge.claude.job.same": isSameJob,
  });
  return { id: jobId, stateBefore: isSameJob ? stateBefore : Option.none() };
});

const failIfJobStopped = ({
  root,
  fileSystem,
  job,
  awaitsFirstReply,
}: {
  readonly root: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly job: Effect.Success<ReturnType<typeof startJob>>;
  readonly awaitsFirstReply: boolean;
}) =>
  Effect.gen(function* () {
    const { path, text } = yield* readJobState({ root, fileSystem, jobId: job.id });
    if (Option.isNone(text)) {
      return yield* new ClaudeJobStateUnreadable({
        jobId: job.id,
        path,
        reason: "the file doesn't exist",
      });
    }
    const isFromBeforeTheJob = Option.exists(job.stateBefore, (before) => before === text.value);
    if (isFromBeforeTheJob) {
      return;
    }
    const { state, detail } = yield* Schema.decodeEffect(JobState)(text.value).pipe(
      Effect.mapError(
        (error) =>
          new ClaudeJobStateUnreadable({ jobId: job.id, path, reason: toOneLine(error.message) }),
      ),
    );
    const isKnown =
      STILL_STARTING_JOB_STATES.has(state) ||
      WAITING_FOR_INPUT_JOB_STATES.has(state) ||
      ENDED_JOB_STATES.has(state);
    if (!isKnown) {
      return yield* new ClaudeJobStateUnknown({ jobId: job.id, state });
    }
    const hasStopped =
      ENDED_JOB_STATES.has(state) || (awaitsFirstReply && WAITING_FOR_INPUT_JOB_STATES.has(state));
    if (hasStopped) {
      return yield* new ClaudeJobEnded({ jobId: job.id, state, detail: detail ?? "" });
    }
  });

const readJobSessionId = ({
  root,
  fileSystem,
  jobId,
}: {
  readonly root: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly jobId: string;
}) =>
  Effect.gen(function* () {
    const { path, text } = yield* readJobState({ root, fileSystem, jobId });
    if (Option.isNone(text)) {
      return Option.none<string>();
    }
    const { sessionId } = yield* Schema.decodeEffect(JobState)(text.value).pipe(
      Effect.mapError(
        (error) => new ClaudeJobStateUnreadable({ jobId, path, reason: toOneLine(error.message) }),
      ),
    );
    return Option.fromUndefinedOr(sessionId);
  });

export const hasJobEnded = ({
  root,
  fileSystem,
  jobId,
}: {
  readonly root: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly jobId: string;
}) =>
  Effect.gen(function* () {
    const { path, text } = yield* readJobState({ root, fileSystem, jobId });
    if (Option.isNone(text)) {
      return true;
    }
    const { state } = yield* Schema.decodeEffect(JobState)(text.value).pipe(
      Effect.mapError(
        (error) => new ClaudeJobStateUnreadable({ jobId, path, reason: toOneLine(error.message) }),
      ),
    );
    return ENDED_JOB_STATES.has(state) || WAITING_FOR_INPUT_JOB_STATES.has(state);
  });

const QUIET_JOB_STATES: ReadonlySet<string> = new Set([
  ...WAITING_FOR_INPUT_JOB_STATES,
  ...ENDED_JOB_STATES,
  "idle",
  "waiting",
]);

const ACTIVE_TEMPO = "active";

export const readJobOfSession = ({
  root,
  fileSystem,
  sessionId,
}: {
  readonly root: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly sessionId: string;
}) =>
  Effect.gen(function* () {
    const jobId = jobIdOf(sessionId);
    const { path, text } = yield* readJobState({ root, fileSystem, jobId });
    if (Option.isNone(text)) {
      return Option.none();
    }
    const job = yield* Schema.decodeEffect(JobState)(text.value).pipe(
      Effect.mapError(
        (error) => new ClaudeJobStateUnreadable({ jobId, path, reason: toOneLine(error.message) }),
      ),
    );
    if (job.sessionId !== sessionId) {
      return Option.none();
    }
    return Option.some({
      jobId,
      state: job.state,
      isQuiet: QUIET_JOB_STATES.has(job.state) && job.tempo !== ACTIVE_TEMPO,
      bridgeId: Option.fromUndefinedOr(job.bridgeSessionId),
    });
  });

export const isJobProcessAlive = ({
  sessionFiles,
  jobId,
}: {
  readonly sessionFiles: ReturnType<typeof readSessionFiles>;
  readonly jobId: string;
}) =>
  Effect.map(sessionFiles, (files) =>
    files.some(({ file }) => file.jobId === jobId && isProcessAlive(file.pid)),
  );

const unlessJobStopped = <Value, Failure, Requirements>({
  root,
  fileSystem,
  sessionFiles,
  job,
  awaitsFirstReply,
  check,
}: {
  readonly root: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly sessionFiles: ReturnType<typeof readSessionFiles>;
  readonly job: Effect.Success<ReturnType<typeof startJob>>;
  readonly awaitsFirstReply: boolean;
  readonly check: Effect.Effect<Option.Option<Value>, Failure, Requirements>;
}) =>
  Effect.gen(function* () {
    const stoppedJob = failIfJobStopped({ root, fileSystem, job, awaitsFirstReply });
    const asFailure = (failure: Effect.Error<typeof stoppedJob>) =>
      Effect.succeed(Result.fail(failure));
    const stopped = yield* stoppedJob.pipe(
      Effect.map(Result.succeed),
      Effect.catchTags({
        ClaudeJobEnded: asFailure,
        ClaudeJobStateUnknown: asFailure,
        ClaudeJobStateUnreadable: asFailure,
      }),
    );
    const isStillWriting = yield* isJobProcessAlive({ sessionFiles, jobId: job.id });
    const found = yield* check;
    const hasStoppedFirst = Option.isNone(found) && Result.isFailure(stopped) && !isStillWriting;
    if (hasStoppedFirst) {
      return yield* stopped.failure;
    }
    return found;
  });

export const waitForJobSession = ({
  root,
  sessions,
  fileSystem,
  sessionFiles,
  job,
  sessionId,
}: {
  readonly root: string;
  readonly sessions: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly sessionFiles: ReturnType<typeof readSessionFiles>;
  readonly job: Effect.Success<ReturnType<typeof startJob>>;
  readonly sessionId: Option.Option<string>;
}) =>
  waitFor({
    watch: Effect.succeed([sessions, jobStateFile({ root, jobId: job.id })]),
    check: unlessJobStopped({
      root,
      fileSystem,
      sessionFiles,
      job,
      awaitsFirstReply: false,
      check: Effect.gen(function* () {
        const live = (yield* sessionFiles).find(
          ({ file }) =>
            file.jobId === job.id &&
            file.sessionId.startsWith(job.id) &&
            isProcessAlive(file.pid) &&
            Option.getOrElse(
              Option.map(sessionId, (id) => id === file.sessionId),
              () => true,
            ),
        );
        return Option.map(Option.fromUndefinedOr(live), ({ file }) => file);
      }),
    }),
  });

export const waitForFirstReply = ({
  root,
  sessions,
  fileSystem,
  nudgeOutput,
  sessionFiles,
  job,
}: {
  readonly root: string;
  readonly sessions: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly nudgeOutput: Output["Service"];
  readonly sessionFiles: ReturnType<typeof readSessionFiles>;
  readonly job: Effect.Success<ReturnType<typeof startJob>>;
}) =>
  Effect.gen(function* () {
    const readNewEntries = yield* makeAppendedLineReader(START_OF_FILE);
    return yield* waitFor({
      watch: Effect.gen(function* () {
        const jobSessionId = yield* readJobSessionId({ root, fileSystem, jobId: job.id });
        return [
          sessions,
          jobStateFile({ root, jobId: job.id }),
          ...(Option.isSome(jobSessionId)
            ? yield* transcriptPaths({ root, fileSystem, id: jobSessionId.value })
            : []),
        ];
      }),
      check: unlessJobStopped({
        root,
        fileSystem,
        sessionFiles,
        job,
        awaitsFirstReply: true,
        check: Effect.gen(function* () {
          const jobSessionId = yield* readJobSessionId({ root, fileSystem, jobId: job.id });
          if (Option.isNone(jobSessionId)) {
            return Option.none();
          }
          const transcript = yield* findTranscript({ root, fileSystem, id: jobSessionId.value });
          const lines = Option.isSome(transcript) ? yield* readNewEntries(transcript.value) : [];
          const entries = Option.isSome(transcript)
            ? yield* decodeTranscriptLines({ nudgeOutput, path: transcript.value, lines })
            : [];
          const firstReply = Option.firstSomeOf(entries.map((entry) => entry.assistant));
          if (Option.isNone(firstReply)) {
            return Option.none();
          }
          return Option.some({
            sessionId: jobSessionId.value,
            firstReply: firstReply.value,
            speed: replySpeedOf(firstReply.value),
          });
        }),
      }),
    });
  });

export const startResume = Effect.fn("claude.startResume")(function* ({
  root,
  fileSystem,
  nudgeOutput,
  session,
  prompt,
}: {
  readonly root: string;
  readonly sessions: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly nudgeOutput: Output["Service"];
  readonly sessionFiles: ReturnType<typeof readSessionFiles>;
  readonly session: typeof Session.Type;
  readonly prompt: readonly string[];
}) {
  yield* Effect.annotateCurrentSpan("nudge.session.id", session.id);
  const workingDirectory =
    session.directory === ""
      ? yield* Option.match(session.transcript, {
          onNone: () =>
            Effect.fail(new ClaudeSessionDirectoryUnknown({ session: describeSession(session) })),
          onSome: (transcript) => readWorkingDirectory({ fileSystem, nudgeOutput, transcript }),
        })
      : session.directory;
  return yield* startJob({
    root,
    fileSystem,
    commandArguments: ["--resume", session.id, ...(prompt.length > 0 ? ["--", ...prompt] : [])],
    shownArguments: 2,
    workingDirectory,
    resumedSessionId: Option.some(session.id),
  }).pipe(
    Effect.catchReason("PlatformError", "NotFound", (notFound) =>
      orClaudeMissing(
        notFound,
        () => new ClaudeNotOnPathToResume({ session: describeSession(session) }),
      ),
    ),
  );
});

export const finishResume = Effect.fn("claude.finishResume")(function* ({
  root,
  sessions,
  fileSystem,
  sessionFiles,
  session,
  job,
}: {
  readonly root: string;
  readonly sessions: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly nudgeOutput: Output["Service"];
  readonly sessionFiles: ReturnType<typeof readSessionFiles>;
  readonly session: typeof Session.Type;
  readonly job: Effect.Success<ReturnType<typeof startJob>>;
}) {
  if (job.id !== jobIdOf(session.id)) {
    return yield* new ClaudeResumedAsCopy({ session: describeSession(session), jobId: job.id });
  }
  yield* waitForJobSession({
    root,
    sessions,
    fileSystem,
    sessionFiles,
    job,
    sessionId: Option.some(session.id),
  });
  return job;
});

export const resume = Effect.fn("claude.resume")(function* (
  options: Parameters<typeof startResume>[0],
) {
  yield* Effect.annotateCurrentSpan("nudge.session.id", options.session.id);
  const job = yield* startResume(options);
  return yield* finishResume({ ...options, job });
});

export const deliverResumedPrompt = ({
  root,
  sessions,
  fileSystem,
  nudgeOutput,
  sessionFiles,
  session,
  content,
  hasNewRecord,
}: {
  readonly root: string;
  readonly sessions: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly nudgeOutput: Output["Service"];
  readonly sessionFiles: ReturnType<typeof readSessionFiles>;
  readonly session: typeof Session.Type;
  readonly content: string;
  readonly hasNewRecord: Effect.Success<ReturnType<typeof makeNewRecordCheck>>;
}) =>
  Effect.gen(function* () {
    const job = yield* resume({
      root,
      sessions,
      fileSystem,
      nudgeOutput,
      sessionFiles,
      session,
      prompt: [content],
    });
    yield* waitFor({
      watch: Effect.map(transcriptPaths({ root, fileSystem, id: session.id }), (transcript) => [
        sessions,
        jobStateFile({ root, jobId: job.id }),
        ...transcript,
      ]),
      check: unlessJobStopped({
        root,
        fileSystem,
        sessionFiles,
        job,
        awaitsFirstReply: false,
        check: Effect.map(
          hasNewRecord((record) => isQueued({ record, content }) || isTyped({ record, content })),
          (isRecorded) => (isRecorded ? Option.some(true) : Option.none()),
        ),
      }),
    });
  });
