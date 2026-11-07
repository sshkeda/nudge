import { Config, Effect, Schema } from "effect";

import { runShell } from "../../../shared/run-shell.ts";
import { policies } from "./platform-policies.ts";

const SUPPORTED_PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"] as const;

class MachineUnsupported extends Schema.TaggedError<MachineUnsupported>()("MachineUnsupported", {
  platform: Schema.String,
}) {
  public override get message() {
    return `nudge's tests don't run on ${this.platform}\nhint: Use macOS or Linux on arm64 or x64`;
  }
}

const MACOS_RESOURCES = "/Applications/ChatGPT.app/Contents/Resources";

const LINUX_RESOURCES = "/usr/lib/chatgpt/resources";

const LINUX_APP_PROCESSES = "^(chatgpt|/usr/lib/chatgpt/)";

const CODEX_ENVIRONMENT = { CODEX_SPARKLE_ENABLED: "false" } as const;

export const XVFB_DISPLAY = ":99";

const exportCodexEnvironment = ({
  shell,
  environment,
}: {
  readonly shell: string;
  readonly environment: Readonly<Record<string, string>>;
}) =>
  `export USER="$(id -un)" LOGNAME="$(id -un)" ${Object.entries({
    SHELL: shell,
    ...CODEX_ENVIRONMENT,
    ...environment,
  })
    .map(([name, value]) => `${name}='${value}'`)
    .join(" ")}`;

const waitForExitOnMacos = (pids: string) => `for pid in ${pids}; do caffeinate -w "$pid"; done`;

const waitForExitOnLinux = (pids: string) => `waitpid --exited ${pids}`;

export const stopProcesses = ({
  pattern,
  waitForExit,
}: {
  readonly pattern: string;
  readonly waitForExit: (pids: string) => string;
}) => `while pids=$(pgrep -f '${pattern}'); do
  kill -9 $pids 2> /dev/null
  ${waitForExit("$pids")}
done`;

const macosCodex = ({ home, shell }: { readonly home: string; readonly shell: string }) =>
  ({
    os: "macos",
    app: "/Applications/ChatGPT.app",
    codexCli: `${MACOS_RESOURCES}/codex-cli/bin/codex`,
    codexNode: `${MACOS_RESOURCES}/cua_node/bin/node`,
    codexLogs: `${home}/Library/Logs/com.openai.codex`,
    mcpLogs: `${home}/Library/Logs/com.openai.codex`,
    mainProcess: "^/Applications/ChatGPT.app/Contents/MacOS/",
    startCodex: (environment: Readonly<Record<string, string>>) =>
      `${exportCodexEnvironment({ shell, environment })}
mkdir -p ~/.local/state/nudge-tests
exec /Applications/ChatGPT.app/Contents/MacOS/ChatGPT >> ~/.local/state/nudge-tests/chatgpt.log 2>&1`,
    waitForExit: waitForExitOnMacos,
    quitCodex: stopProcesses({
      pattern: "^/Applications/ChatGPT.app/",
      waitForExit: waitForExitOnMacos,
    }),
  }) as const;

const linuxCodex = ({ home, shell }: { readonly home: string; readonly shell: string }) =>
  ({
    os: "linux",
    app: LINUX_RESOURCES,
    codexCli: `${LINUX_RESOURCES}/codex`,
    codexNode: `${LINUX_RESOURCES}/cua_node/bin/node`,
    codexLogs: `${home}/.local/state/nudge-tests/chatgpt.log`,
    mcpLogs: `${home}/.local/state/codex/logs`,
    mainProcess: LINUX_APP_PROCESSES,
    startCodex: (environment: Readonly<Record<string, string>>) =>
      `${exportCodexEnvironment({ shell, environment: { DISPLAY: XVFB_DISPLAY, ...environment } })}
export XDG_RUNTIME_DIR=/tmp/xdg-$(id -u)
mkdir -p -m 700 "$XDG_RUNTIME_DIR" ~/.local/state/nudge-tests
exec dbus-run-session -- chatgpt --disable-gpu >> ~/.local/state/nudge-tests/chatgpt.log 2>&1`,
    waitForExit: waitForExitOnLinux,
    quitCodex: stopProcesses({ pattern: LINUX_APP_PROCESSES, waitForExit: waitForExitOnLinux }),
  }) as const;

const MACOS_LOGIN_SHELL = `dscl . -read "/Users/$(id -un)" UserShell | sed 's/^UserShell: //'`;
const LINUX_LOGIN_SHELL = `getent passwd "$(id -un)" | cut -d: -f7`;

const claudeShellConfigFor = (shell: string) => {
  if (shell.includes("zsh")) {
    return ".zshrc";
  }
  return shell.includes("bash") ? ".bashrc" : ".profile";
};

const definitions = {
  linux: { platform: "linux", loginShell: LINUX_LOGIN_SHELL, codex: linuxCodex },
  macos: { platform: "darwin", loginShell: MACOS_LOGIN_SHELL, codex: macosCodex },
} as const;

const NATIVE_NAMES = new Map<string, keyof typeof definitions>([
  ["linux", "linux"],
  ["darwin", "macos"],
]);

export const thisMachine = Effect.gen(function* () {
  const nativeName = NATIVE_NAMES.get(process.platform);
  if (nativeName === undefined) {
    return yield* new MachineUnsupported({ platform: `${process.platform}-${process.arch}` });
  }
  const definition = definitions[nativeName];
  const platform = `${definition.platform}-${process.arch}`;
  const supported = SUPPORTED_PLATFORMS.find((candidate) => candidate === platform);
  if (supported === undefined) {
    return yield* new MachineUnsupported({ platform });
  }
  const home = yield* Config.String("HOME");
  const shell = (yield* runShell(definition.loginShell)).trim();
  return {
    platform: supported,
    home,
    nudge: `${home}/.bun/bin/nudge`,
    claude: `${home}/.local/bin/claude`,
    codexConfig: `${home}/.codex/config.toml`,
    claudeConfig: `${home}/.claude/settings.json`,
    claudeShellConfig: `${home}/${claudeShellConfigFor(shell)}`,
    bridgeSocket: `${home}/.local/state/nudge/codex/codex.sock`,
    ...definition.codex({ home, shell }),
    ...policies[nativeName],
  };
});
