import { Task } from "@sshkeda/task";

import { ci } from "../tests/index.ts";

if (import.meta.main) {
  Task.main(ci);
}
