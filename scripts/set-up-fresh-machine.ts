import { Task } from "@sshkeda/task";

import { setUpFreshMachine } from "./internal/set-up-this-fresh-machine.ts";

if (import.meta.main) {
  Task.main(setUpFreshMachine);
}
