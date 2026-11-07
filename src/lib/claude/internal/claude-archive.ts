import { Effect, Option } from "effect";
import type { FileSystem } from "effect";

import { waitFor } from "../../../shared/wait-until.ts";
import type { Platform } from "../../platform/index.ts";
import type { readSessionFiles } from "./claude-discovery.ts";
import { jobStateFile, readJobOfSession } from "./claude-jobs.ts";
import { describeSession, isProcessAlive } from "./claude-session-files.ts";
import type { ClaudeSession } from "./claude-session.ts";
import { findTranscript, readLastBridgeId } from "./claude-transcript.ts";
import {
  ClaudeAppSessionNotArchivable,
  ClaudeRemoteControlAmbiguous,
  ClaudeRemoteControlChanged,
  ClaudeRemoteControlNotReconnected,
  ClaudeSessionRestarting,
} from "./errors.ts";

const BUSY = "busy";

const BRIDGE_PREFIX = /^(?:cse|session)_/u;

export const REMOTE_CONTROL_WAIT = "60 seconds";

export const sameBridge = (left: string, right: string) =>
  left.replace(BRIDGE_PREFIX, "") === right.replace(BRIDGE_PREFIX, "");

export const readBridgeIds = ({
  root,
  fileSystem,
  sessionFiles,
  sessionId,
}: {
  readonly root: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly sessionFiles: ReturnType<typeof readSessionFiles>;
  readonly sessionId: string;
}) =>
  Effect.gen(function* () {
    const job = yield* readJobOfSession({ root, fileSystem, sessionId });
    const registrations = (yield* sessionFiles)
      .map(({ file }) => file)
      .filter((file) => file.sessionId === sessionId);
    const registered = registrations.flatMap((file) =>
      file.bridgeSessionId === undefined ? [] : [file.bridgeSessionId],
    );
    const transcript = yield* findTranscript({ root, fileSystem, id: sessionId });
    const recorded = Option.isSome(transcript)
      ? yield* readLastBridgeId(transcript.value)
      : Option.none<string>();
    const found = [
      ...Option.toArray(Option.flatMap(job, (record) => record.bridgeId)),
      ...registered,
      ...Option.toArray(recorded),
    ];
    const bridgeIds = found.filter(
      (bridgeId, index) => found.findIndex((earlier) => sameBridge(earlier, bridgeId)) === index,
    );
    const busy = registrations.flatMap((file) => (file.status === BUSY ? [file.status] : []));
    const unfinished = [
      ...Option.toArray(
        Option.map(
          Option.filter(job, (record) => !record.isQuiet),
          (record) => record.state,
        ),
      ),
      ...busy,
    ];
    return { bridgeIds, unfinished };
  });

export const planStoppedArchive = ({
  session,
  bridgeIds,
  unfinished,
}: {
  readonly session: typeof ClaudeSession.Type;
  readonly bridgeIds: readonly string[];
  readonly unfinished: readonly string[];
}) =>
  Effect.gen(function* () {
    if (session.appState === "archived") {
      return Option.none<string>();
    }
    if (session.appState === "listed") {
      return yield* new ClaudeAppSessionNotArchivable({ session: describeSession(session) });
    }
    const [bridgeId, ...others] = bridgeIds;
    if (bridgeId === undefined) {
      return Option.none<string>();
    }
    if (others.length > 0) {
      yield* Effect.annotateCurrentSpan("nudge.claude.archive.bridgeIds", bridgeIds.join(" "));
      return yield* new ClaudeRemoteControlAmbiguous({
        session: describeSession(session),
        bridgeIds: [...bridgeIds],
      });
    }
    const [state] = unfinished;
    if (state !== undefined) {
      yield* Effect.annotateCurrentSpan("nudge.claude.archive.unfinishedState", state);
      return yield* new ClaudeSessionRestarting({ session: describeSession(session), state });
    }
    return Option.some(bridgeId);
  });

export const checkResumedBridge = ({
  session,
  expected,
  found,
}: {
  readonly session: typeof ClaudeSession.Type;
  readonly expected: string;
  readonly found: string;
}) =>
  Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan({
      "nudge.claude.archive.bridgeId.expected": expected,
      "nudge.claude.archive.bridgeId.found": found,
    });
    if (!sameBridge(expected, found)) {
      return yield* new ClaudeRemoteControlChanged({
        session: describeSession(session),
        expected,
        found,
      });
    }
  });

export const waitForRemoteControl = ({
  root,
  sessions,
  fileSystem,
  platform,
  sessionFiles,
  session,
  jobId,
  expected,
}: {
  readonly root: string;
  readonly sessions: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly platform: Platform["Service"];
  readonly sessionFiles: ReturnType<typeof readSessionFiles>;
  readonly session: typeof ClaudeSession.Type;
  readonly jobId: string;
  readonly expected: string;
}) =>
  waitFor({
    watch: Effect.succeed([sessions, jobStateFile({ root, jobId })]),
    check: Effect.gen(function* () {
      for (const { file } of yield* sessionFiles) {
        const isResumedRuntime =
          file.jobId === jobId &&
          file.sessionId === session.id &&
          file.bridgeSessionId !== undefined &&
          file.messagingSocketPath !== undefined &&
          file.procStart !== undefined &&
          isProcessAlive(file.pid) &&
          (yield* fileSystem.exists(file.messagingSocketPath)) &&
          Option.contains(yield* platform.readProcessStart(file.pid), file.procStart);
        if (isResumedRuntime) {
          return Option.fromUndefinedOr(file.bridgeSessionId);
        }
      }
      return Option.none<string>();
    }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: REMOTE_CONTROL_WAIT,
      orElse: () =>
        Effect.andThen(
          Effect.annotateCurrentSpan("nudge.claude.archive.bridgeId.expected", expected),
          new ClaudeRemoteControlNotReconnected({
            session: describeSession(session),
            bridgeId: expected,
            waited: REMOTE_CONTROL_WAIT,
          }),
        ),
    }),
  );
