import { Schema } from "effect";

import { homePath, messageOf, prose, Report, shellCommand } from "./report.ts";

const LIMIT_GROWTH = 2;

export class InotifyWatchLimitReached extends Schema.TaggedError<InotifyWatchLimitReached>()(
  "InotifyWatchLimitReached",
  { directory: Schema.String, limit: Schema.Int },
) {
  public get report(): Report {
    return new Report({
      message: prose`nudge can't watch ${homePath(this.directory)} because your user reached the inotify watch limit, fs.inotify.max_user_watches = ${this.limit}`,
      hint: shellCommand([
        "sudo",
        "sysctl",
        `fs.inotify.max_user_watches=${this.limit * LIMIT_GROWTH}`,
      ]),
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}
