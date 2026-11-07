import { Task } from "@sshkeda/task";
import { Effect } from "effect";

import { startMockModel } from "../../scripts/shared/aimock.ts";
import { nudgeBuild } from "../../scripts/shared/build-nudge.ts";
import { MOCK_MODEL_PORT } from "../../scripts/shared/codex-and-claude.ts";
import { startCodexDesktop } from "../../scripts/shared/codex-desktop.ts";
import { archivingAClaudeJobWithoutAProcess } from "../shared/archiving-a-claude-job-without-a-process.ts";
import { archivingATerminalSession } from "../shared/archiving-a-terminal-session.ts";
import { archivingAnInterruptedHelper } from "../shared/archiving-an-interrupted-helper.ts";
import { archivingWhileCodexDatabaseIsLocked } from "../shared/archiving-while-codex-database-is-locked.ts";
import { blockingNudgeInTheCodexSandbox } from "../shared/blocking-nudge-in-the-codex-sandbox.ts";
import { checkingDoctorBeforeCodex } from "../shared/checking-doctor-before-codex.ts";
import { confirmingAStoppedTurnLate } from "../shared/confirming-a-stopped-turn-late.ts";
import { failingBrokenClaudeJobs } from "../shared/failing-broken-claude-jobs.ts";
import { failingToReachCodexDesktop } from "../shared/failing-to-reach-codex-desktop.ts";
import { holdingMessages } from "../shared/holding-messages.ts";
import { keepingCodexSpeed } from "../shared/keeping-codex-speed.ts";
import { limitingTheCodexHelper } from "../shared/limiting-the-codex-helper.ts";
import { listingInACodexSandboxWithNetwork } from "../shared/listing-in-a-codex-sandbox-with-network.ts";
import { listingSessions } from "../shared/listing-sessions.ts";
import { makeMachine } from "../shared/machine-commands.ts";
import { matchingTheDefaultPermissions } from "../shared/matching-the-default-permissions.ts";
import { passingPromptsThatLookLikeFlags } from "../shared/passing-prompts-that-look-like-flags.ts";
import { printingHelpAndErrors } from "../shared/printing-help-and-errors.ts";
import { reachingTheWatchLimit } from "../shared/reaching-the-watch-limit.ts";
import { readingAClaudePromptWrittenLate } from "../shared/reading-a-claude-prompt-written-late.ts";
import { readingCodexStatus } from "../shared/reading-codex-status.ts";
import { recordingTraces } from "../shared/recording-traces.ts";
import { recoveringCodexStatusAfterACrash } from "../shared/recovering-codex-status-after-a-crash.ts";
import { rejectingBadNewSessions } from "../shared/rejecting-bad-new-sessions.ts";
import { rejectingUnknownCodexModels } from "../shared/rejecting-unknown-codex-models.ts";
import { renamingAndArchiving } from "../shared/renaming-and-archiving.ts";
import { resumingAKilledClaudeSession } from "../shared/resuming-a-killed-claude-session.ts";
import { runningCodexWithNudge } from "../shared/running-codex-with-nudge.ts";
import { sendingFromSessions } from "../shared/sending-from-sessions.ts";
import { sendingMessages } from "../shared/sending-messages.ts";
import { sendingToABusyCodexTask } from "../shared/sending-to-a-busy-codex-task.ts";
import { showingAClaudePermissionPrompt } from "../shared/showing-a-claude-permission-prompt.ts";
import { showingACodexProject } from "../shared/showing-a-codex-project.ts";
import { showingSessions } from "../shared/showing-sessions.ts";
import { startingCodexInItsProject } from "../shared/starting-codex-in-its-project.ts";
import { strippingControlCharacters } from "../shared/stripping-control-characters.ts";
import { warningAboutAnUnarchivedHelper } from "../shared/warning-about-an-unarchived-helper.ts";

const TEST_OPTIONS = { timeout: "10 minutes", cleanup: "1 minute" } as const;

const nudgeAndTheMockModel = Task.make(
  "build-nudge-and-start-the-mock-model",
  Effect.gen(function* () {
    yield* nudgeBuild;
    yield* startMockModel;
    return yield* Task.serve(MOCK_MODEL_PORT);
  }),
  TEST_OPTIONS,
);

const codexDesktop = Task.make(
  "start-codex-desktop",
  Effect.gen(function* () {
    yield* nudgeAndTheMockModel;
    yield* startCodexDesktop();
    return yield* Task.serve(true);
  }),
  TEST_OPTIONS,
);

const beforeCodex = Effect.andThen(nudgeAndTheMockModel, makeMachine);

const withCodex = Effect.andThen(codexDesktop, makeMachine);

const checkingDoctorBeforeCodexTask = Task.make(
  "checking-doctor-before-codex",
  Effect.flatMap(beforeCodex, checkingDoctorBeforeCodex),
  TEST_OPTIONS,
);

const failingBrokenClaudeJobsTask = Task.make(
  "failing-broken-claude-jobs",
  Effect.flatMap(beforeCodex, failingBrokenClaudeJobs),
  TEST_OPTIONS,
);

const sendingFromSessionsTask = Task.make(
  "sending-from-sessions",
  Effect.flatMap(withCodex, sendingFromSessions),
  TEST_OPTIONS,
);

const sendingMessagesTask = Task.make(
  "sending-messages",
  Effect.flatMap(withCodex, sendingMessages),
  TEST_OPTIONS,
);

const sendingToABusyCodexTaskTask = Task.make(
  "sending-to-a-busy-codex-task",
  Effect.flatMap(withCodex, sendingToABusyCodexTask),
  TEST_OPTIONS,
);

const holdingMessagesTask = Task.make(
  "holding-messages",
  Effect.flatMap(withCodex, holdingMessages),
  TEST_OPTIONS,
);

const keepingCodexSpeedTask = Task.make(
  "keeping-codex-speed",
  Effect.flatMap(withCodex, keepingCodexSpeed),
  TEST_OPTIONS,
);

const renamingAndArchivingTask = Task.make(
  "renaming-and-archiving",
  Effect.flatMap(withCodex, renamingAndArchiving),
  TEST_OPTIONS,
);

const archivingATerminalSessionTask = Task.make(
  "archiving-a-terminal-session",
  Effect.flatMap(withCodex, archivingATerminalSession),
  TEST_OPTIONS,
);

const showingSessionsTask = Task.make(
  "showing-sessions",
  Effect.flatMap(withCodex, showingSessions),
  TEST_OPTIONS,
);

const showingAClaudePermissionPromptTask = Task.make(
  "showing-a-claude-permission-prompt",
  Effect.flatMap(withCodex, showingAClaudePermissionPrompt),
  TEST_OPTIONS,
);

const showingACodexProjectTask = Task.make(
  "showing-a-codex-project",
  Effect.flatMap(withCodex, showingACodexProject),
  TEST_OPTIONS,
);

const rejectingBadNewSessionsTask = Task.make(
  "rejecting-bad-new-sessions",
  Effect.flatMap(withCodex, rejectingBadNewSessions),
  TEST_OPTIONS,
);

const rejectingUnknownCodexModelsTask = Task.make(
  "rejecting-unknown-codex-models",
  Effect.flatMap(withCodex, rejectingUnknownCodexModels),
  TEST_OPTIONS,
);

const runningCodexWithNudgeTask = Task.make(
  "running-codex-with-nudge",
  Effect.flatMap(withCodex, runningCodexWithNudge),
  TEST_OPTIONS,
);

const printingHelpAndErrorsTask = Task.make(
  "printing-help-and-errors",
  Effect.flatMap(withCodex, printingHelpAndErrors),
  TEST_OPTIONS,
);

const limitingTheCodexHelperTask = Task.make(
  "limiting-the-codex-helper",
  Effect.flatMap(withCodex, limitingTheCodexHelper),
  TEST_OPTIONS,
);

const passingPromptsThatLookLikeFlagsTask = Task.make(
  "passing-prompts-that-look-like-flags",
  Effect.flatMap(withCodex, passingPromptsThatLookLikeFlags),
  TEST_OPTIONS,
);

const strippingControlCharactersTask = Task.make(
  "stripping-control-characters",
  Effect.flatMap(withCodex, strippingControlCharacters),
  TEST_OPTIONS,
);

const listingInACodexSandboxWithNetworkTask = Task.make(
  "listing-in-a-codex-sandbox-with-network",
  Effect.flatMap(withCodex, listingInACodexSandboxWithNetwork),
  TEST_OPTIONS,
);

const listingSessionsTask = Task.make(
  "listing-sessions",
  Effect.flatMap(withCodex, listingSessions),
  TEST_OPTIONS,
);

const blockingNudgeInTheCodexSandboxTask = Task.make(
  "blocking-nudge-in-the-codex-sandbox",
  Effect.flatMap(withCodex, blockingNudgeInTheCodexSandbox),
  TEST_OPTIONS,
);

const resumingAKilledClaudeSessionTask = Task.make(
  "resuming-a-killed-claude-session",
  Effect.flatMap(withCodex, resumingAKilledClaudeSession),
  TEST_OPTIONS,
);

const archivingAClaudeJobWithoutAProcessTask = Task.make(
  "archiving-a-claude-job-without-a-process",
  Effect.flatMap(withCodex, archivingAClaudeJobWithoutAProcess),
  TEST_OPTIONS,
);

const matchingTheDefaultPermissionsTask = Task.make(
  "matching-the-default-permissions",
  Effect.flatMap(beforeCodex, matchingTheDefaultPermissions),
  TEST_OPTIONS,
);

const confirmingAStoppedTurnLateTask = Task.make(
  "confirming-a-stopped-turn-late",
  Effect.flatMap(beforeCodex, confirmingAStoppedTurnLate),
  TEST_OPTIONS,
);

const archivingAnInterruptedHelperTask = Task.make(
  "archiving-an-interrupted-helper",
  Effect.flatMap(beforeCodex, archivingAnInterruptedHelper),
  TEST_OPTIONS,
);

const warningAboutAnUnarchivedHelperTask = Task.make(
  "warning-about-an-unarchived-helper",
  Effect.flatMap(beforeCodex, warningAboutAnUnarchivedHelper),
  TEST_OPTIONS,
);

const reachingTheWatchLimitTask = Task.make(
  "reaching-the-watch-limit",
  Effect.flatMap(withCodex, reachingTheWatchLimit),
  TEST_OPTIONS,
);

const recordingTracesTask = Task.make(
  "recording-traces",
  Effect.flatMap(withCodex, recordingTraces),
  TEST_OPTIONS,
);

const recoveringCodexStatusAfterACrashTask = Task.make(
  "recovering-codex-status-after-a-crash",
  Effect.flatMap(withCodex, recoveringCodexStatusAfterACrash),
  TEST_OPTIONS,
);

const startingCodexInItsProjectTask = Task.make(
  "starting-codex-in-its-project",
  Effect.flatMap(withCodex, startingCodexInItsProject),
  TEST_OPTIONS,
);

const archivingWhileCodexDatabaseIsLockedTask = Task.make(
  "archiving-while-codex-database-is-locked",
  Effect.flatMap(withCodex, archivingWhileCodexDatabaseIsLocked),
  TEST_OPTIONS,
);

const failingToReachCodexDesktopTask = Task.make(
  "failing-to-reach-codex-desktop",
  Effect.flatMap(beforeCodex, failingToReachCodexDesktop),
  TEST_OPTIONS,
);

const readingAClaudePromptWrittenLateTask = Task.make(
  "reading-a-claude-prompt-written-late",
  Effect.flatMap(withCodex, readingAClaudePromptWrittenLate),
  TEST_OPTIONS,
);

const readingCodexStatusTask = Task.make(
  "reading-codex-status",
  Effect.flatMap(withCodex, readingCodexStatus),
  TEST_OPTIONS,
);

export const managingSessions = Task.make(
  "managing-sessions",
  Effect.gen(function* () {
    yield* checkingDoctorBeforeCodexTask;
    yield* readingCodexStatusTask;
    yield* Effect.all(
      [
        failingBrokenClaudeJobsTask,
        Task.all(
          [
            sendingFromSessionsTask,
            sendingMessagesTask,
            sendingToABusyCodexTaskTask,
            holdingMessagesTask,
            renamingAndArchivingTask,
            archivingATerminalSessionTask,
            showingSessionsTask,
            rejectingBadNewSessionsTask,
            rejectingUnknownCodexModelsTask,
            runningCodexWithNudgeTask,
            printingHelpAndErrorsTask,
            limitingTheCodexHelperTask,
            passingPromptsThatLookLikeFlagsTask,
            strippingControlCharactersTask,
            reachingTheWatchLimitTask,
            readingAClaudePromptWrittenLateTask,
          ],
          { concurrency: navigator.hardwareConcurrency },
        ).pipe(
          Effect.andThen(
            Task.all(
              [
                listingSessionsTask,
                blockingNudgeInTheCodexSandboxTask,
                resumingAKilledClaudeSessionTask,
                archivingAClaudeJobWithoutAProcessTask,
                showingAClaudePermissionPromptTask,
                listingInACodexSandboxWithNetworkTask,
              ],
              { concurrency: 1 },
            ),
          ),
        ),
      ],
      { concurrency: "unbounded", discard: true },
    );
    yield* archivingWhileCodexDatabaseIsLockedTask;
    yield* keepingCodexSpeedTask;
    yield* recordingTracesTask;
    yield* recoveringCodexStatusAfterACrashTask;
    yield* startingCodexInItsProjectTask;
    yield* showingACodexProjectTask;
    yield* failingToReachCodexDesktopTask;
    yield* matchingTheDefaultPermissionsTask;
    yield* confirmingAStoppedTurnLateTask;
    yield* archivingAnInterruptedHelperTask;
    yield* warningAboutAnUnarchivedHelperTask;
  }),
  { timeout: "60 minutes", cleanup: "1 minute" },
);
