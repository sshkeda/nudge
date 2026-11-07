import { Option, Schema } from "effect";

import {
  homePath,
  joined,
  messageOf,
  prose,
  Report,
  shellCommand,
  showOnTerminal,
  trusted,
} from "../../../shared/report.ts";

export const NOTHING_LISTENS_CODES: ReadonlySet<string | undefined> = new Set([
  "ENOENT",
  "ECONNREFUSED",
]);

export class CodexIndexLineUnreadable extends Schema.TaggedError<CodexIndexLineUnreadable>()(
  "CodexIndexLineUnreadable",
  { path: Schema.String, reason: Schema.String },
) {
  public get report(): Report {
    return new Report({
      message: prose`can't read a line of the Codex thread index ${homePath(this.path)}: ${this.reason}`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class CodexDesktopDidNotLoadUnarchivedThread extends Schema.TaggedError<CodexDesktopDidNotLoadUnarchivedThread>()(
  "CodexDesktopDidNotLoadUnarchivedThread",
  { failure: Schema.String },
) {
  public get report(): Report {
    return new Report({ message: prose`Codex's set_thread_archived tool failed: ${this.failure}` });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class CodexHelperNotRunning extends Schema.TaggedError<CodexHelperNotRunning>()(
  "CodexHelperNotRunning",
  { socket: Schema.String, reason: Schema.String, config: Schema.String },
) {
  public get report(): Report {
    return new Report({
      message: prose`nothing answers at ${homePath(this.socket)}, where nudge's Codex helper listens while Codex Desktop is open and ${homePath(this.config)} has the [mcp_servers.nudge] entry from nudge's README: ${this.reason}`,
      hint: shellCommand(["nudge", "doctor"]),
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class CodexDesktopIpcUnreachable extends Schema.TaggedError<CodexDesktopIpcUnreachable>()(
  "CodexDesktopIpcUnreachable",
  {
    socket: Schema.String,
    method: Schema.String,
    code: Schema.optional(Schema.String),
    reason: Schema.String,
  },
) {
  public get report(): Report {
    return new Report({
      message: prose`can't ask Codex Desktop for ${this.method} at ${homePath(this.socket)}: ${this.reason}`,
      hint: NOTHING_LISTENS_CODES.has(this.code) ? shellCommand(["nudge", "doctor"]) : undefined,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class CodexDesktopIpcRefused extends Schema.TaggedError<CodexDesktopIpcRefused>()(
  "CodexDesktopIpcRefused",
  { method: Schema.String, error: Schema.String },
) {
  public get report(): Report {
    return new Report({
      message: prose`Codex Desktop refused ${this.method}, a request that Codex doesn't document: ${this.error}`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class CodexDefaultPermissionsUnreadable extends Schema.TaggedError<CodexDefaultPermissionsUnreadable>()(
  "CodexDefaultPermissionsUnreadable",
  { path: Schema.String, reason: Schema.String },
) {
  public get report(): Report {
    return new Report({
      message: prose`can't read your Codex default permissions from ${homePath(this.path)}: ${this.reason}`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export const APP_SERVER_WAIT = "15 seconds";

const APP_SERVER_FAILURES = {
  "not-started": "Codex's app-server didn't start.",
  stopped: "Codex's app-server stopped before answering.",
  "timed-out": `Codex's app-server didn't answer within ${APP_SERVER_WAIT}.`,
  "unknown-answer": "Codex's app-server answered in a way nudge doesn't understand.",
  "no-profiles": "Codex's app-server listed no permission profiles.",
} as const;

export class CodexAppServerUnreadable extends Schema.TaggedError<CodexAppServerUnreadable>()(
  "CodexAppServerUnreadable",
  {
    command: Schema.Array(Schema.String),
    method: Schema.String,
    failure: Schema.Literals([
      "error",
      "no-profiles",
      "not-started",
      "stopped",
      "timed-out",
      "unknown-answer",
    ]),
    error: Schema.optional(Schema.String),
    detail: Schema.optional(Schema.String),
  },
) {
  public get report(): Report {
    const failure =
      this.failure === "error"
        ? prose`Codex's app-server returned an error, "${this.error ?? ""}".`
        : prose`${APP_SERVER_FAILURES[this.failure]}`;
    const detailLines = (this.detail ?? "")
      .trim()
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => trusted(showOnTerminal(line)));
    return new Report({
      message: joined(
        [
          prose`nudge didn't start the session, because it couldn't read your Codex default permissions. ${failure}`,
          ...detailLines,
        ],
        "\n",
      ),
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class CodexProjectsUnread extends Schema.TaggedError<CodexProjectsUnread>()(
  "CodexProjectsUnread",
  { reason: Schema.String },
) {
  public get report(): Report {
    return new Report({
      message: prose`can't read Codex Desktop's projects, so nudge didn't start the session: ${this.reason}`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class CodexProjectsShareADirectory extends Schema.TaggedError<CodexProjectsShareADirectory>()(
  "CodexProjectsShareADirectory",
  { directory: Schema.String, count: Schema.Int },
) {
  public get report(): Report {
    return new Report({
      message: prose`${this.count} Codex Desktop projects use ${homePath(this.directory)}, so nudge can't tell which one to start the session in. Remove the extra projects in Codex Desktop.`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class CodexTaskNotGivenFullAccess extends Schema.TaggedError<CodexTaskNotGivenFullAccess>()(
  "CodexTaskNotGivenFullAccess",
  {
    threadId: Schema.String,
    approvalPolicy: Schema.String,
    sandbox: Schema.String,
    archived: Schema.optional(Schema.Boolean),
  },
) {
  public get report(): Report {
    return new Report({
      message: prose`Codex session ${this.threadId} got approval ${this.approvalPolicy} and sandbox ${this.sandbox} instead of your default Full access, so nudge stopped its turn${this.archived === true ? " and archived it" : ""}`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class CodexTurnNotStopped extends Schema.TaggedError<CodexTurnNotStopped>()(
  "CodexTurnNotStopped",
  { threadId: Schema.String, turnId: Schema.String, waited: Schema.String },
) {
  public get report(): Report {
    return new Report({
      message: prose`Codex Desktop didn't confirm in time that it stopped turn ${this.turnId} of Codex session ${this.threadId}, and the turn was still running ${this.waited} later`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class CodexEffortNotValidated extends Schema.TaggedError<CodexEffortNotValidated>()(
  "CodexEffortNotValidated",
  { tool: Schema.String, failure: Schema.String },
) {
  public get report(): Report {
    return new Report({
      message: prose`Codex's ${this.tool} tool couldn't validate the reasoning effort: ${this.failure}`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class CodexToolFailed extends Schema.TaggedError<CodexToolFailed>()("CodexToolFailed", {
  tool: Schema.String,
  failure: Schema.String,
}) {
  public get report(): Report {
    return new Report({ message: prose`Codex's ${this.tool} tool failed: ${this.failure}` });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

const MAY_STILL = {
  start: prose`Codex may still start the session, so check ${shellCommand(["nudge", "list"])} before trying again.`,
  deliver: prose`Codex may still deliver the message, so check the session's transcript before sending again.`,
  archive: prose`Codex may still archive the session, so check ${shellCommand(["nudge", "list"])} before trying again.`,
  unarchive: prose`Codex may still unarchive the session, so check ${shellCommand(["nudge", "list"])} before trying again.`,
  rename: prose`Codex may still rename the session, so check ${shellCommand(["nudge", "list"])} before trying again.`,
};

export class CodexDidNotAnswer extends Schema.TaggedError<CodexDidNotAnswer>()(
  "CodexDidNotAnswer",
  {
    tool: Schema.String,
    waited: Schema.String,
    mayStill: Schema.Option(
      Schema.Literals(["start", "deliver", "archive", "unarchive", "rename"]),
    ),
  },
) {
  public get report(): Report {
    const mayStill = Option.match(this.mayStill, {
      onNone: () => prose``,
      onSome: (pending) => prose` ${MAY_STILL[pending]}`,
    });
    return new Report({
      message: prose`Codex Desktop didn't answer within ${this.waited}, so nudge stopped waiting.${mayStill} If Codex is stuck, restarting it usually helps.`,
      data: { tool: this.tool },
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class CodexHelperStillUnarchived extends Schema.TaggedError<CodexHelperStillUnarchived>()(
  "CodexHelperStillUnarchived",
  { threadId: Schema.String },
) {
  public get report(): Report {
    return new Report({
      message: prose`started the session, but nudge couldn't archive its permissions helper session ${this.threadId}, so it may stay in your Codex list. You can archive it in Codex Desktop.`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class CodexArchiveDatabaseLocked extends Schema.TaggedError<CodexArchiveDatabaseLocked>()(
  "CodexArchiveDatabaseLocked",
  { failure: Schema.String },
) {
  public get report(): Report {
    return new Report({ message: prose`Codex's set_thread_archived tool failed: ${this.failure}` });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class CodexArchiveStillLocked extends Schema.TaggedError<CodexArchiveStillLocked>()(
  "CodexArchiveStillLocked",
  { threadId: Schema.String, retriedFor: Schema.String, failure: Schema.String },
) {
  public get report(): Report {
    return new Report({
      message: prose`Codex didn't archive session ${this.threadId}, because another writer kept Codex's state database locked while nudge retried for ${this.retriedFor}: ${this.failure}`,
      hint: shellCommand(["nudge", "archive", this.threadId]),
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class CodexStateDatabaseMissing extends Schema.TaggedError<CodexStateDatabaseMissing>()(
  "CodexStateDatabaseMissing",
  { directory: Schema.String },
) {
  public get report(): Report {
    return new Report({
      message: prose`${homePath(this.directory)} has no Codex state database, which Codex Desktop creates when it first starts`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class CodexHasNoTask extends Schema.TaggedError<CodexHasNoTask>()("CodexHasNoTask", {
  database: Schema.String,
}) {
  public get report(): Report {
    return new Report({
      message: prose`${homePath(this.database)} has no unarchived top-level session, and nudge needs one to start a session from`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class CodexSubagentRootNotFound extends Schema.TaggedError<CodexSubagentRootNotFound>()(
  "CodexSubagentRootNotFound",
  { threadId: Schema.String, database: Schema.String },
) {
  public get report(): Report {
    return new Report({
      message: prose`can't find the top-level session of subagent thread ${this.threadId} in ${homePath(this.database)}`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class CodexUnarchiveNotApplied extends Schema.TaggedError<CodexUnarchiveNotApplied>()(
  "CodexUnarchiveNotApplied",
  { threadId: Schema.String, database: Schema.String, reply: Schema.String },
) {
  public get report(): Report {
    return new Report({
      message: prose`${this.reply}, but ${homePath(this.database)} still shows ${this.threadId} archived`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class CodexSpeedNotSwitched extends Schema.TaggedError<CodexSpeedNotSwitched>()(
  "CodexSpeedNotSwitched",
  {
    threadId: Schema.String,
    speed: Schema.String,
    current: Schema.String,
    isStillFast: Schema.Boolean,
    reason: Schema.String,
    outcome: Schema.Literals(["not-sent", "sent", "started"]),
  },
) {
  public get report(): Report {
    const notSwitched = prose`nudge couldn't switch Codex session ${this.threadId} to ${this.speed}: ${this.reason}`;
    if (this.outcome === "not-sent") {
      return new Report({ message: prose`${notSwitched}, so nudge didn't send the message` });
    }
    const outcome =
      this.outcome === "sent" ? prose`sent the message, but ${notSwitched}` : notSwitched;
    if (!this.isStillFast) {
      return new Report({ message: prose`${outcome}, so it still runs in ${this.current} mode` });
    }
    return new Report({
      message: prose`${outcome}, so it still runs in ${this.current} mode. Turn off Fast for it in Codex Desktop, or archive it`,
      hint: shellCommand(["nudge", "archive", this.threadId]),
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class CodexSpeedAfterThisTurn extends Schema.TaggedError<CodexSpeedAfterThisTurn>()(
  "CodexSpeedAfterThisTurn",
  { threadId: Schema.String, speed: Schema.String, current: Schema.String },
) {
  public get report(): Report {
    return new Report({
      message: prose`nudge switched Codex session ${this.threadId} to ${this.speed}, but it's in the middle of a turn, which keeps running in ${this.current} mode until it ends`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class CodexDesktopChoseFast extends Schema.TaggedError<CodexDesktopChoseFast>()(
  "CodexDesktopChoseFast",
  {
    threadId: Schema.String,
    applied: Schema.String,
    speed: Schema.String,
    isNewTask: Schema.Boolean,
    isRequested: Schema.Boolean,
  },
) {
  public get report(): Report {
    if (this.isNewTask) {
      return new Report({
        message: prose`Codex Desktop started Codex session ${this.threadId} in ${this.applied} mode, its default speed, so nudge switched it to ${this.speed}, but its first model request may already have run in ${this.applied} mode`,
      });
    }
    return new Report({
      message: this.isRequested
        ? prose`Codex Desktop started the turn for this message in ${this.applied} mode, so nudge switched Codex session ${this.threadId} to ${this.speed}, but the turn's first model request may already have run in ${this.applied} mode`
        : prose`Codex Desktop started the turn for this message in ${this.applied} mode, its default speed, so nudge switched Codex session ${this.threadId} back to ${this.speed}, but the turn's first model request may already have run in ${this.applied} mode`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class CodexModelListFailed extends Schema.TaggedError<CodexModelListFailed>()(
  "CodexModelListFailed",
  { command: Schema.Array(Schema.String), failure: Schema.String },
) {
  public get report(): Report {
    return new Report({
      message: prose`nudge can't list Codex's models, because ${shellCommand(this.command)} failed: ${this.failure}`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class CodexModelListMissing extends Schema.TaggedError<CodexModelListMissing>()(
  "CodexModelListMissing",
  { command: Schema.Array(Schema.String) },
) {
  public get report(): Report {
    return new Report({
      message: prose`nudge can't list Codex's models, because ${shellCommand(this.command)} printed no model list`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class CodexModelsUnreadable extends Schema.TaggedError<CodexModelsUnreadable>()(
  "CodexModelsUnreadable",
  { command: Schema.Array(Schema.String), reason: Schema.String },
) {
  public get report(): Report {
    return new Report({
      message: prose`nudge can't check --model and --effort, because ${shellCommand(this.command)} didn't list Codex's models, so nudge didn't send the message: ${this.reason}`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class CodexSpeedUnconfirmed extends Schema.TaggedError<CodexSpeedUnconfirmed>()(
  "CodexSpeedUnconfirmed",
  {
    threadId: Schema.String,
    speed: Schema.String,
    wait: Schema.String,
  },
) {
  public get report(): Report {
    return new Report({
      message: prose`nudge couldn't confirm the speed of Codex session ${this.threadId} within ${this.wait}, so Codex Desktop may run this message at its default speed instead of ${this.speed} mode`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}
