import { check } from "@sshkeda/check/tasks";
import { Task } from "@sshkeda/task";

if (import.meta.main) {
  Task.main(check);
}
