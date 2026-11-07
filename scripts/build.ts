import { Task } from "@sshkeda/task";

import { nudgeBuild } from "./shared/build-nudge.ts";

if (import.meta.main) {
  Task.main(nudgeBuild);
}
