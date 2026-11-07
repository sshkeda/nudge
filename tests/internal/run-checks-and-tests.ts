import { check } from "@sshkeda/check/tasks";
import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Schema } from "effect";

import {
  MOCK_MODEL_PROVIDER,
  requireGitCheckout,
  requireSetUpMachine,
  SELECTED_MODEL_PROVIDER,
} from "../../scripts/shared/codex-and-claude.ts";
import { refuseUnsafeMachines } from "../../scripts/shared/refuse-unsafe-machines.ts";
import { checkingTheInstallation } from "./checking-the-installation.ts";
import { choosingACodexProject } from "./choosing-a-codex-project.ts";
import { decodingSplitCharacters } from "./decoding-split-characters.ts";
import { judgingClaudeReplySpeed } from "./judging-claude-reply-speed.ts";
import { listingClaudeSessions } from "./listing-claude-sessions.ts";
import { listingUpdatedTimes } from "./listing-updated-times.ts";
import { managingSessions } from "./managing-sessions.ts";
import { matchingFlagsToTheLexer } from "./matching-flags-to-the-lexer.ts";
import { readingCodexDefaultPermissions } from "./reading-codex-default-permissions.ts";
import { readingCodexToolOutput } from "./reading-codex-tool-output.ts";
import { readingDesktopStatus } from "./reading-desktop-status.ts";
import { readingModelChoices } from "./reading-model-choices.ts";
import { readingTheLatestCodexSpeed } from "./reading-the-latest-codex-speed.ts";
import { refusingACopyWithoutGit } from "./refusing-a-copy-without-git.ts";
import { refusingFastWithoutSupport } from "./refusing-fast-without-support.ts";
import { retryingALockedCodexArchive } from "./retrying-a-locked-codex-archive.ts";
import { runningOnEachPlatform } from "./running-on-each-platform.ts";
import { showingTextSafely } from "./showing-text-safely.ts";
import { stoppingWhenCodexDoesNotAnswer } from "./stopping-when-codex-does-not-answer.ts";
import { switchingCodexSpeedBeforeSending } from "./switching-codex-speed-before-sending.ts";
import { waitingForAClaudeSocket } from "./waiting-for-a-claude-socket.ts";

class CodexNotOnTheMockModel extends Schema.TaggedError<CodexNotOnTheMockModel>()(
  "CodexNotOnTheMockModel",
  { file: Schema.String, selected: Schema.String },
) {
  public override get message() {
    return `${this.file} selects the model provider "${this.selected}" instead of "${MOCK_MODEL_PROVIDER}"\nhint: Run ci.ts in a fresh copy of the set-up machine`;
  }
}

const requireTheMockModel = (file: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const selected =
      SELECTED_MODEL_PROVIDER.exec(yield* fileSystem.readFileString(file))?.groups?.["provider"] ??
      "";
    if (selected !== MOCK_MODEL_PROVIDER) {
      return yield* new CodexNotOnTheMockModel({ file, selected });
    }
  });

export const ci = Task.make(
  "ci",
  Effect.gen(function* () {
    yield* requireGitCheckout;
    yield* refuseUnsafeMachines;
    const machine = yield* requireSetUpMachine;
    yield* requireTheMockModel(machine.codexConfig);
    yield* Task.all([
      check,
      checkingTheInstallation,
      decodingSplitCharacters,
      judgingClaudeReplySpeed,
      refusingFastWithoutSupport,
      readingDesktopStatus,
      readingTheLatestCodexSpeed,
      readingModelChoices,
      refusingACopyWithoutGit,
      runningOnEachPlatform,
      retryingALockedCodexArchive,
      showingTextSafely,
      listingUpdatedTimes,
      listingClaudeSessions,
      managingSessions,
      matchingFlagsToTheLexer,
      waitingForAClaudeSocket,
      stoppingWhenCodexDoesNotAnswer,
      switchingCodexSpeedBeforeSending,
      choosingACodexProject,
      readingCodexDefaultPermissions,
      readingCodexToolOutput,
    ]);
  }),
);
