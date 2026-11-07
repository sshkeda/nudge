import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Option } from "effect";

const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

const BYPASS_FILE_PERMISSION_CAPABILITIES = 0b110n;

const NO_CAPABILITIES = 0n;

const CAPABILITIES_LINE = /^CapEff:\s+(?<capabilities>[\da-f]+)$/mu;

export const claudeKeychainLogin = Effect.gen(function* () {
  const hasKeychainItem = yield* Task.exec("security", [
    "find-generic-password",
    "-s",
    CLAUDE_KEYCHAIN_SERVICE,
  ]).pipe(
    Effect.as(true),
    Effect.catchTag("CommandFailed", () => Effect.succeed(false)),
  );
  return hasKeychainItem
    ? Option.some(`the login keychain's "${CLAUDE_KEYCHAIN_SERVICE}" item`)
    : Option.none<string>();
});

export const bypassesFilePermissions = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const status = yield* fileSystem.readFileString("/proc/self/status");
  const capabilities = BigInt(
    `0x${CAPABILITIES_LINE.exec(status)?.groups?.["capabilities"] ?? "0"}`,
  );
  return (capabilities & BYPASS_FILE_PERMISSION_CAPABILITIES) !== NO_CAPABILITIES;
});
