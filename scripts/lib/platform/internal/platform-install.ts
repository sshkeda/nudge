import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Option, Schema } from "effect";
import type { PlatformError } from "effect";

import { runShell } from "../../../shared/run-shell.ts";
import type { SetUpRefused } from "../../../shared/set-up-refused.ts";
import type { thisMachine } from "./test-platform.ts";

const CODEX_DOWNLOADS = {
  "darwin-arm64": {
    version: "26.1027.51404",
    url: "https://persistent.oaistatic.com/codex-app-prod/ChatGPT-darwin-arm64-26.1027.51404.zip",
    sha256: "93993beed5ee52a61147ca973290e2052bb0fa3da117634d571267071720bb5d",
  },
  "darwin-x64": {
    version: "26.1027.51404",
    url: "https://persistent.oaistatic.com/codex-app-prod/ChatGPT-darwin-x64-26.1027.51404.zip",
    sha256: "8e9a393b00bc8705c1344993ad918989384ef019c04a18011b0b6fc96d761e86",
  },
  "linux-arm64": {
    version: "26.1027.51404",
    url: "https://persistent.oaistatic.com/codex-app-prod/linux/deb/pool/main/c/chatgpt/chatgpt_26.1027.51404_arm64.deb",
    sha256: "2c2ba5cd2f5c13de5f5d93a5e1623fbb61ea4b3556571e5f7431a570f17f8fea",
  },
  "linux-x64": {
    version: "26.1027.51404",
    url: "https://persistent.oaistatic.com/codex-app-prod/linux/deb/pool/main/c/chatgpt/chatgpt_26.1027.51404_amd64.deb",
    sha256: "46f1e22d028698fe9edaefd5847aece07c4509a30d3709e104220719d8c12822",
  },
} as const;

const CLAUDE_SHA256 = {
  "darwin-arm64": "b9ac5374839f14abf3f1f45610637c332b5daee5ce0d1634726cef87aab78e6a",
  "darwin-x64": "f2ae409b46b1bdc1dec7afa12c6a094ff64e7d4ca272ca09f69dd0080c846703",
  "linux-arm64": "c487117526509ab6d2ee6013e14f181faf68d6d6afe6bb0d4b2b4a9feca5ecb3",
  "linux-x64": "ea0f135784631619a7a409d07322ecec964f9cc4fd377508ed1ba3f141f27912",
} as const;

const CLAUDE_DOWNLOADS = "https://downloads.claude.ai/claude-code-releases";

const LINUX_PACKAGES = [
  "curl",
  "ca-certificates",
  "unzip",
  "git",
  "procps",
  "bubblewrap",
  "xvfb",
  "xauth",
  "dbus-daemon",
  "util-linux-extra",
] as const;

export const CODEX_UPDATER_DEFAULTS = "/etc/default/chatgpt";

const CODEX_APT_SOURCES = "/etc/apt/sources.list.d/chatgpt.sources";

class DownloadChecksumMismatch extends Schema.TaggedError<DownloadChecksumMismatch>()(
  "DownloadChecksumMismatch",
  { url: Schema.String, expected: Schema.String, actual: Schema.String },
) {
  public override get message() {
    return `${this.url} has SHA-256 ${this.actual} instead of the pinned ${this.expected}`;
  }
}

class CodexAddedAnUpdateSource extends Schema.TaggedError<CodexAddedAnUpdateSource>()(
  "CodexAddedAnUpdateSource",
  {},
) {
  public override get message() {
    return `installing Codex Desktop added ${CODEX_APT_SOURCES}, so apt would update it`;
  }
}

export const download = Effect.fn("download")(function* ({
  url,
  sha256,
  to,
}: {
  readonly url: string;
  readonly sha256: string;
  readonly to: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* Effect.log(`Downloading ${url}.`);
  yield* Task.exec("curl", ["-fsSL", "-o", to, url]);
  const actual = new Bun.CryptoHasher("sha256")
    .update(yield* fileSystem.readFile(to))
    .digest("hex");
  if (actual !== sha256) {
    return yield* new DownloadChecksumMismatch({ url, expected: sha256, actual });
  }
});

export const installedVersion = (command: string) =>
  runShell(command).pipe(
    Effect.map((output) => Option.some(output.trim())),
    Effect.catchTag("CommandFailed", () => Effect.succeedNone),
  );

const installLinuxPackages = Effect.gen(function* () {
  const missing = yield* Effect.filter(LINUX_PACKAGES, (name) =>
    installedVersion(`dpkg-query -W -f='\${Status}' ${name} | grep -q 'install ok installed'`).pipe(
      Effect.map(Option.isNone),
    ),
  );
  if (missing.length === 0) {
    return;
  }
  yield* Effect.log(`Installing ${missing.join(", ")}.`);
  yield* runShell(
    `sudo -n apt-get update -qq && sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${missing.join(" ")} > /dev/null`,
  );
});

const COMMAND_LINE_TOOLS_ON_DEMAND =
  "/tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress";

const installCommandLineTools = Effect.gen(function* () {
  const installed = yield* installedVersion("xcode-select -p");
  if (Option.isSome(installed)) {
    return;
  }
  yield* Effect.log("Installing Apple's Command Line Tools, which have git.");
  yield* runShell(`set -eu
touch ${COMMAND_LINE_TOOLS_ON_DEMAND}
label="$(softwareupdate -l 2>/dev/null | grep -o 'Label: Command Line Tools.*' | tail -1 | sed 's/^Label: //')"
sudo -n softwareupdate -i "$label" > /dev/null
rm -f ${COMMAND_LINE_TOOLS_ON_DEMAND}`);
});

export const installCodexDesktop = Effect.fn("installCodexDesktop")(function* (
  machine: Effect.Success<typeof thisMachine>,
  refuseExistingFiles: (
    files: readonly string[],
  ) => Effect.Effect<void, PlatformError.PlatformError | SetUpRefused, FileSystem.FileSystem>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const pinned = CODEX_DOWNLOADS[machine.platform];
  const directory = yield* fileSystem.makeTempDirectoryScoped();
  const archive = `${directory}/${pinned.url.split("/").at(-1) ?? "codex"}`;
  yield* download({ url: pinned.url, sha256: pinned.sha256, to: archive });
  yield* machine.installCodexArchive({ archive, directory, refuseExistingFiles });
}, Effect.scoped);

export { CLAUDE_DOWNLOADS, CLAUDE_SHA256, installCommandLineTools, installLinuxPackages };

export const installMacosCodexArchive = ({
  archive,
}: {
  readonly archive: string;
  readonly directory: string;
  readonly refuseExistingFiles: (
    files: readonly string[],
  ) => Effect.Effect<void, PlatformError.PlatformError | SetUpRefused, FileSystem.FileSystem>;
}) => Task.exec("ditto", ["-x", "-k", archive, "/Applications"]);

export const installLinuxCodexArchive = ({
  archive,
  directory,
  refuseExistingFiles,
}: {
  readonly archive: string;
  readonly directory: string;
  readonly refuseExistingFiles: (
    files: readonly string[],
  ) => Effect.Effect<void, PlatformError.PlatformError | SetUpRefused, FileSystem.FileSystem>;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* refuseExistingFiles([CODEX_UPDATER_DEFAULTS]);
    yield* runShell(
      `echo 'repo_add_once="false"' | sudo -n tee ${CODEX_UPDATER_DEFAULTS} > /dev/null && chmod 755 ${directory} && sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${archive} > /dev/null`,
    );
    if (yield* fileSystem.exists(CODEX_APT_SOURCES)) {
      return yield* new CodexAddedAnUpdateSource();
    }
  });
