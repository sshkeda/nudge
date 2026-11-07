import { Schema } from "effect";

import { toOneLine } from "../../../shared/print-line.ts";
import { homePath, messageOf, prose, Report } from "../../../shared/report.ts";

export class ProcessStartUnreadable extends Schema.TaggedError<ProcessStartUnreadable>()(
  "ProcessStartUnreadable",
  { pid: Schema.Int, source: Schema.String },
) {
  public get report(): Report {
    return new Report({
      message: prose`${this.source} shows no start time for process ${this.pid}`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class CodexBridgeLockFailed extends Schema.TaggedError<CodexBridgeLockFailed>()(
  "CodexBridgeLockFailed",
  { file: Schema.String, reason: Schema.String },
) {
  public get report(): Report {
    return new Report({
      message: prose`nudge can't lock ${homePath(this.file)}: ${toOneLine(this.reason)}`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class PlatformUnsupported extends Schema.TaggedError<PlatformUnsupported>()(
  "PlatformUnsupported",
  { platform: Schema.String },
) {
  public get report(): Report {
    return new Report({
      message: prose`nudge runs on Linux and macOS, not on ${this.platform}`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class CodexBridgeLockHeldElsewhere extends Schema.TaggedError<CodexBridgeLockHeldElsewhere>()(
  "CodexBridgeLockHeldElsewhere",
  { file: Schema.String },
) {
  public override get message() {
    return `another Codex helper holds ${this.file}`;
  }
}
