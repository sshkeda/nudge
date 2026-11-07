import { Effect, PlatformError, Schema } from "effect";

import { toOneLine } from "../../../shared/print-line.ts";
import {
  homePath,
  messageOf,
  prose,
  quoted,
  Report,
  shellCommand,
} from "../../../shared/report.ts";
import { describeSession } from "../../../shared/session.ts";

const OUTPUT_START_LENGTH = 80;

const ClaudeSession = Schema.Struct({ id: Schema.String, name: Schema.String });

const describeClaudeSession = (session: typeof ClaudeSession.Type) =>
  describeSession({ provider: "Claude", ...session });

const withReason = (reason: string | undefined) => (reason === undefined ? "" : `: ${reason}`);

const describeOutputStart = (output: string) => toOneLine(output).slice(0, OUTPUT_START_LENGTH);

const claudeLogs = (jobId: string) => shellCommand(["claude", "logs", jobId]);

export class ClaudeJobIdNotPrinted extends Schema.TaggedError<ClaudeJobIdNotPrinted>()(
  "ClaudeJobIdNotPrinted",
  { output: Schema.String },
) {
  public get report(): Report {
    const start = describeOutputStart(this.output);
    return new Report({
      message:
        start === ""
          ? prose`claude --bg printed no background job ID`
          : prose`claude --bg printed no background job ID, and its output starts with ${quoted(start)}`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class ClaudeJobStateUnreadable extends Schema.TaggedError<ClaudeJobStateUnreadable>()(
  "ClaudeJobStateUnreadable",
  { jobId: Schema.String, path: Schema.String, reason: Schema.String },
) {
  public get report(): Report {
    return new Report({
      message: prose`can't read the state of Claude's background job ${this.jobId} in ${homePath(this.path)}: ${this.reason}`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class ClaudeJobStateUnknown extends Schema.TaggedError<ClaudeJobStateUnknown>()(
  "ClaudeJobStateUnknown",
  { jobId: Schema.String, state: Schema.String },
) {
  public get report(): Report {
    return new Report({
      message: prose`Claude's background job ${this.jobId} is in the state ${quoted(this.state)}, which nudge doesn't know`,
      hint: claudeLogs(this.jobId),
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class ClaudeJobEnded extends Schema.TaggedError<ClaudeJobEnded>()("ClaudeJobEnded", {
  jobId: Schema.String,
  state: Schema.String,
  detail: Schema.String,
}) {
  public get report(): Report {
    const detail = this.detail === "" ? "" : `: ${this.detail}`;
    return new Report({
      message: prose`Claude's background job ${this.jobId} is in the state ${quoted(this.state)}${detail}`,
      hint: claudeLogs(this.jobId),
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class ClaudeResumedAsCopy extends Schema.TaggedError<ClaudeResumedAsCopy>()(
  "ClaudeResumedAsCopy",
  { session: ClaudeSession, jobId: Schema.String },
) {
  public get report(): Report {
    return new Report({
      message: prose`Claude resumed ${describeClaudeSession(this.session)} as a copy in background job ${this.jobId} instead of resuming it in place`,
      hint: claudeLogs(this.jobId),
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class ClaudeSocketFailed extends Schema.TaggedError<ClaudeSocketFailed>()(
  "ClaudeSocketFailed",
  {
    session: ClaudeSession,
    socket: Schema.String,
    operation: Schema.Literals(["listen for replies on", "send to"]),
    code: Schema.optional(Schema.String),
    reason: Schema.String,
  },
) {
  public get report(): Report {
    return new Report({
      message: prose`can't ${this.operation} the socket ${homePath(this.socket)} of ${describeClaudeSession(this.session)}: ${this.reason}`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

const Undelivered = {
  session: ClaudeSession,
  messageId: Schema.String,
  reason: Schema.optional(Schema.String),
};

const describeUndelivered = ({
  session,
  messageId,
  reason,
  outcome,
}: {
  readonly session: typeof ClaudeSession.Type;
  readonly messageId: string;
  readonly reason: string | undefined;
  readonly outcome: string;
}) =>
  new Report({
    message: prose`${describeClaudeSession(session)} ${outcome}${withReason(reason)}`,
    data: {
      target: { id: session.id, name: session.name },
      messageId,
      ...(reason === undefined ? {} : { reason }),
    },
  });

export class MessageHeld extends Schema.TaggedError<MessageHeld>()("MessageHeld", Undelivered) {
  public get report(): Report {
    return describeUndelivered({
      session: this.session,
      messageId: this.messageId,
      reason: this.reason,
      outcome: "held the message for approval, so don't send it again",
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class MessageRefused extends Schema.TaggedError<MessageRefused>()(
  "MessageRefused",
  Undelivered,
) {
  public get report(): Report {
    return describeUndelivered({
      session: this.session,
      messageId: this.messageId,
      reason: this.reason,
      outcome: "refused the message",
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class MessageDenied extends Schema.TaggedError<MessageDenied>()(
  "MessageDenied",
  Undelivered,
) {
  public get report(): Report {
    return describeUndelivered({
      session: this.session,
      messageId: this.messageId,
      reason: this.reason,
      outcome: "denied the message",
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class MessageExpired extends Schema.TaggedError<MessageExpired>()(
  "MessageExpired",
  Undelivered,
) {
  public get report(): Report {
    return describeUndelivered({
      session: this.session,
      messageId: this.messageId,
      reason: this.reason,
      outcome: "let the message expire",
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class MessageDropped extends Schema.TaggedError<MessageDropped>()(
  "MessageDropped",
  Undelivered,
) {
  public get report(): Report {
    return describeUndelivered({
      session: this.session,
      messageId: this.messageId,
      reason: this.reason,
      outcome: "dropped the message",
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class ClaudeMessageNotQueued extends Schema.TaggedError<ClaudeMessageNotQueued>()(
  "ClaudeMessageNotQueued",
  { session: ClaudeSession, waited: Schema.String },
) {
  public get report(): Report {
    return new Report({
      message: prose`${describeClaudeSession(this.session)} didn't queue the message within ${this.waited}, so nudge can't tell whether it will arrive`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class ClaudeMessageTooLarge extends Schema.TaggedError<ClaudeMessageTooLarge>()(
  "ClaudeMessageTooLarge",
  {
    session: ClaudeSession,
    characters: Schema.Int,
    maximum: Schema.Int,
  },
) {
  public get report(): Report {
    return new Report({
      message: prose`the message to ${describeClaudeSession(this.session)} takes ${this.characters} characters once encoded, more than the ${this.maximum} characters Claude accepts`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class ClaudeFileNotPrivate extends Schema.TaggedError<ClaudeFileNotPrivate>()(
  "ClaudeFileNotPrivate",
  {
    path: Schema.String,
    type: Schema.Literals(["Directory", "File", "Socket"]),
  },
) {
  public get report(): Report {
    return new Report({
      message: prose`${homePath(this.path)} isn't a ${this.type.toLowerCase()} that only you own and can open`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class ClaudePeerKeyNotFound extends Schema.TaggedError<ClaudePeerKeyNotFound>()(
  "ClaudePeerKeyNotFound",
  {
    session: ClaudeSession,
    directory: Schema.String,
    pid: Schema.Int,
    matches: Schema.Int,
  },
) {
  public get report(): Report {
    return new Report({
      message: prose`${this.matches} peer keys in ${homePath(this.directory)} match process ${this.pid} of ${describeClaudeSession(this.session)} instead of 1`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class ClaudeProcessChanged extends Schema.TaggedError<ClaudeProcessChanged>()(
  "ClaudeProcessChanged",
  {
    session: ClaudeSession,
    pid: Schema.Int,
    expected: Schema.String,
    found: Schema.String,
  },
) {
  public get report(): Report {
    return new Report({
      message: prose`process ${this.pid} started at ${this.found}, but ${describeClaudeSession(this.session)} records a start at ${this.expected}`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class ClaudeSessionFileUnreadable extends Schema.TaggedError<ClaudeSessionFileUnreadable>()(
  "ClaudeSessionFileUnreadable",
  { path: Schema.String, reason: Schema.String },
) {
  public get report(): Report {
    return new Report({
      message: prose`can't read the Claude session file ${homePath(this.path)}: ${this.reason}`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class ClaudeTranscriptLineUnreadable extends Schema.TaggedError<ClaudeTranscriptLineUnreadable>()(
  "ClaudeTranscriptLineUnreadable",
  { path: Schema.String, reason: Schema.String },
) {
  public get report(): Report {
    return new Report({
      message: prose`can't read a line of the Claude transcript ${homePath(this.path)}: ${this.reason}`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class ClaudeTranscriptHasNoDirectory extends Schema.TaggedError<ClaudeTranscriptHasNoDirectory>()(
  "ClaudeTranscriptHasNoDirectory",
  { transcript: Schema.String },
) {
  public get report(): Report {
    return new Report({
      message: prose`the Claude transcript ${homePath(this.transcript)} doesn't record the session's working directory`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export const orClaudeMissing = <MissingError>(
  notFound: PlatformError.SystemError,
  missing: () => MissingError,
) => {
  const isClaudeMissing = notFound.module === "ChildProcess" && notFound.method === "spawn";
  return Effect.fail(isClaudeMissing ? missing() : new PlatformError.PlatformError(notFound));
};

const ATTEMPTS = {
  "listing-models": "list Claude's models",
  starting: "start a Claude session",
} as const;

export class ClaudeNotOnPath extends Schema.TaggedError<ClaudeNotOnPath>()("ClaudeNotOnPath", {
  attempt: Schema.Literals(["listing-models", "starting"]),
}) {
  public get report(): Report {
    return new Report({
      message: prose`nudge can't ${ATTEMPTS[this.attempt]}, because it can't find claude on your PATH`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class ClaudeNotOnPathToResume extends Schema.TaggedError<ClaudeNotOnPathToResume>()(
  "ClaudeNotOnPathToResume",
  { session: ClaudeSession },
) {
  public get report(): Report {
    return new Report({
      message: prose`nudge can't resume ${describeClaudeSession(this.session)}, because it can't find claude on your PATH`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class ClaudeModelListFailed extends Schema.TaggedError<ClaudeModelListFailed>()(
  "ClaudeModelListFailed",
  { command: Schema.Array(Schema.String), failure: Schema.String },
) {
  public get report(): Report {
    return new Report({
      message: prose`nudge can't list Claude's models, because ${shellCommand(this.command)} failed: ${this.failure}`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class ClaudeModelListMissing extends Schema.TaggedError<ClaudeModelListMissing>()(
  "ClaudeModelListMissing",
  { command: Schema.Array(Schema.String) },
) {
  public get report(): Report {
    return new Report({
      message: prose`nudge can't list Claude's models, because ${shellCommand(this.command)} printed no model list`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class ClaudeDesktopSessionUnreadable extends Schema.TaggedError<ClaudeDesktopSessionUnreadable>()(
  "ClaudeDesktopSessionUnreadable",
  { path: Schema.String, reason: Schema.String },
) {
  public get report(): Report {
    return new Report({
      message: prose`can't read the Claude Desktop session file ${homePath(this.path)}: ${this.reason}`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class ClaudeWorkspaceNotTrusted extends Schema.TaggedError<ClaudeWorkspaceNotTrusted>()(
  "ClaudeWorkspaceNotTrusted",
  { directory: Schema.String },
) {
  public get report(): Report {
    return new Report({
      message: prose`Claude doesn't trust ${homePath(this.directory)} yet`,
      hint: prose`cd ${homePath(this.directory)} && claude`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class ClaudeHomeNotTrusted extends Schema.TaggedError<ClaudeHomeNotTrusted>()(
  "ClaudeHomeNotTrusted",
  {},
) {
  public readonly report = new Report({
    message: prose`Claude trusts your home folder for one interactive session at a time, so it won't start a background session there, and nudge new claude needs to run in another folder`,
  });

  public override get message() {
    return messageOf(this.report);
  }
}

export class ClaudeHistoryUnreadable extends Schema.TaggedError<ClaudeHistoryUnreadable>()(
  "ClaudeHistoryUnreadable",
  { reason: Schema.String },
) {
  public get report(): Report {
    return new Report({ message: prose`can't read Claude Code's saved sessions: ${this.reason}` });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class ClaudeRenameFailed extends Schema.TaggedError<ClaudeRenameFailed>()(
  "ClaudeRenameFailed",
  { session: ClaudeSession, reason: Schema.String },
) {
  public get report(): Report {
    return new Report({
      message: prose`nudge couldn't rename ${describeClaudeSession(this.session)} in Claude Code's saved sessions: ${this.reason}`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class ClaudeAppSessionNotArchivable extends Schema.TaggedError<ClaudeAppSessionNotArchivable>()(
  "ClaudeAppSessionNotArchivable",
  { session: ClaudeSession },
) {
  public get report(): Report {
    return new Report({
      message: prose`nudge can't archive ${describeClaudeSession(this.session)}, because the Claude app owns it. Archive it in the Claude app.`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class ClaudeSessionNotStopped extends Schema.TaggedError<ClaudeSessionNotStopped>()(
  "ClaudeSessionNotStopped",
  { session: ClaudeSession, waited: Schema.String },
) {
  public get report(): Report {
    return new Report({
      message: prose`nudge didn't archive ${describeClaudeSession(this.session)}, because it didn't stop within ${this.waited}.`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class ClaudeRemoteControlAmbiguous extends Schema.TaggedError<ClaudeRemoteControlAmbiguous>()(
  "ClaudeRemoteControlAmbiguous",
  { session: ClaudeSession, bridgeIds: Schema.Array(Schema.String) },
) {
  public get report(): Report {
    return new Report({
      message: prose`nudge can't archive ${describeClaudeSession(this.session)}, because Claude recorded more than one Remote Control session for it.`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class ClaudeSessionRestarting extends Schema.TaggedError<ClaudeSessionRestarting>()(
  "ClaudeSessionRestarting",
  { session: ClaudeSession, state: Schema.String },
) {
  public get report(): Report {
    return new Report({
      message: prose`nudge can't archive ${describeClaudeSession(this.session)}, because it stopped in the middle of a turn and Claude may be restarting it.`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class ClaudeRemoteControlChanged extends Schema.TaggedError<ClaudeRemoteControlChanged>()(
  "ClaudeRemoteControlChanged",
  { session: ClaudeSession, expected: Schema.String, found: Schema.String },
) {
  public get report(): Report {
    return new Report({
      message: prose`nudge didn't archive ${describeClaudeSession(this.session)}, because Claude reconnected it to a different Remote Control session.`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class ClaudeRemoteControlNotReconnected extends Schema.TaggedError<ClaudeRemoteControlNotReconnected>()(
  "ClaudeRemoteControlNotReconnected",
  { session: ClaudeSession, bridgeId: Schema.String, waited: Schema.String },
) {
  public get report(): Report {
    return new Report({
      message: prose`nudge didn't archive ${describeClaudeSession(this.session)}, because it didn't reconnect to Remote Control within ${this.waited}.`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class ClaudeSessionEnded extends Schema.TaggedError<ClaudeSessionEnded>()(
  "ClaudeSessionEnded",
  { session: ClaudeSession },
) {
  public get report(): Report {
    return new Report({ message: prose`${describeClaudeSession(this.session)} has ended` });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class ClaudeSessionEndedBeforeDelivery extends Schema.TaggedError<ClaudeSessionEndedBeforeDelivery>()(
  "ClaudeSessionEndedBeforeDelivery",
  { session: ClaudeSession },
) {
  public get report(): Report {
    return new Report({
      message: prose`${describeClaudeSession(this.session)} ended before the message arrived`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class ClaudeSessionEndedBeforeRename extends Schema.TaggedError<ClaudeSessionEndedBeforeRename>()(
  "ClaudeSessionEndedBeforeRename",
  { session: ClaudeSession },
) {
  public get report(): Report {
    return new Report({
      message: prose`${describeClaudeSession(this.session)} ended before it took the new name`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class ClaudeSessionHasNoSocket extends Schema.TaggedError<ClaudeSessionHasNoSocket>()(
  "ClaudeSessionHasNoSocket",
  { session: ClaudeSession },
) {
  public get report(): Report {
    return new Report({
      message: prose`${describeClaudeSession(this.session)} has no messaging socket`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class ClaudeSocketPathRelative extends Schema.TaggedError<ClaudeSocketPathRelative>()(
  "ClaudeSocketPathRelative",
  { session: ClaudeSession, socket: Schema.String },
) {
  public get report(): Report {
    return new Report({
      message: prose`${describeClaudeSession(this.session)} has the relative messaging socket path ${quoted(this.socket)}`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class ClaudePeerProtocolUnsupported extends Schema.TaggedError<ClaudePeerProtocolUnsupported>()(
  "ClaudePeerProtocolUnsupported",
  { session: ClaudeSession, protocol: Schema.optional(Schema.Int), supported: Schema.Int },
) {
  public get report(): Report {
    const protocol =
      this.protocol === undefined ? "no peer protocol" : `peer protocol ${this.protocol}`;
    return new Report({
      message: prose`${describeClaudeSession(this.session)} speaks ${protocol}, and nudge speaks only ${this.supported}`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class ClaudeReplyUnreadable extends Schema.TaggedError<ClaudeReplyUnreadable>()(
  "ClaudeReplyUnreadable",
  { socket: Schema.String, reason: Schema.String },
) {
  public get report(): Report {
    return new Report({
      message: prose`can't read a reply from Claude on ${homePath(this.socket)}: ${this.reason}`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class ClaudeFirstRequestFailed extends Schema.TaggedError<ClaudeFirstRequestFailed>()(
  "ClaudeFirstRequestFailed",
  { session: ClaudeSession, reply: Schema.String },
) {
  public get report(): Report {
    return new Report({
      message: prose`${describeClaudeSession(this.session)} failed its first request and nudge stopped it: ${this.reply}`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class ClaudeAnsweredInStandardMode extends Schema.TaggedError<ClaudeAnsweredInStandardMode>()(
  "ClaudeAnsweredInStandardMode",
  { session: ClaudeSession },
) {
  public get report(): Report {
    return new Report({
      message: prose`${describeClaudeSession(this.session)} started, but Claude answered in Standard mode, not Fast mode`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class ClaudeFastModeUnconfirmed extends Schema.TaggedError<ClaudeFastModeUnconfirmed>()(
  "ClaudeFastModeUnconfirmed",
  { session: ClaudeSession },
) {
  public get report(): Report {
    return new Report({
      message: prose`${describeClaudeSession(this.session)} started, but Claude didn't record its first reply's speed, so nudge can't confirm Fast mode`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class ClaudeModelChangeUnsupported extends Schema.TaggedError<ClaudeModelChangeUnsupported>()(
  "ClaudeModelChangeUnsupported",
  { session: ClaudeSession },
) {
  public get report(): Report {
    return new Report({
      message: prose`${describeClaudeSession(this.session)} can't change its model or effort while it runs`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class ClaudeSpeedChangeUnsupported extends Schema.TaggedError<ClaudeSpeedChangeUnsupported>()(
  "ClaudeSpeedChangeUnsupported",
  { session: ClaudeSession },
) {
  public get report(): Report {
    return new Report({
      message: prose`${describeClaudeSession(this.session)} can't change its speed while it runs`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class ClaudeSessionDirectoryUnknown extends Schema.TaggedError<ClaudeSessionDirectoryUnknown>()(
  "ClaudeSessionDirectoryUnknown",
  { session: ClaudeSession },
) {
  public get report(): Report {
    return new Report({
      message: prose`${describeClaudeSession(this.session)} has no directory and no transcript to find it in`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class ClaudeWarning extends Schema.TaggedError<ClaudeWarning>()("ClaudeWarning", {
  warning: Schema.String,
}) {
  public get report(): Report {
    return new Report({ message: prose`${this.warning}` });
  }

  public override get message() {
    return messageOf(this.report);
  }
}
