import { Task } from "@sshkeda/task";

export const runShell = (command: string) => Task.exec("bash", ["-c", command]);
