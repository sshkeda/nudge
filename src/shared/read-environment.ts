import { Config, Option } from "effect";

export const HOME = Config.String("HOME");

export const CLAUDE_CONFIG_DIRECTORY = Config.String("CLAUDE_CONFIG_DIR").pipe(
  Config.orElse(() => HOME.pipe(Config.map((home) => `${home}/.claude`))),
);

export const CODEX_HOME = Config.String("CODEX_HOME").pipe(
  Config.orElse(() => HOME.pipe(Config.map((home) => `${home}/.codex`))),
);

export const NUDGE_STATE_DIRECTORY = HOME.pipe(Config.map((home) => `${home}/.local/state/nudge`));

export const CODEX_BRIDGE_SOCKET = NUDGE_STATE_DIRECTORY.pipe(
  Config.map((directory) => `${directory}/codex/codex.sock`),
);

export const OTEL_EXPORTER_OTLP_ENDPOINT = Config.String("OTEL_EXPORTER_OTLP_ENDPOINT").pipe(
  Config.option,
  Config.map(Option.map((endpoint) => endpoint.trim())),
  Config.map(Option.filter((endpoint) => endpoint !== "")),
);

export const CODEX_THREAD_ID = Config.String("CODEX_THREAD_ID").pipe(
  Config.option,
  Config.map(Option.map((threadId) => threadId.trim())),
  Config.map(Option.filter((threadId) => threadId !== "")),
);

export const CLAUDE_CODE_SESSION_ID = Config.String("CLAUDE_CODE_SESSION_ID").pipe(
  Config.option,
  Config.map(Option.map((sessionId) => sessionId.trim())),
  Config.map(Option.filter((sessionId) => sessionId !== "")),
);

export const IN_CODEX_SANDBOX = Config.String("CODEX_SANDBOX").pipe(
  Config.option,
  Config.map(Option.isSome),
);

export const CODEX_SANDBOX_BLOCKS_NETWORK = Config.String("CODEX_SANDBOX_NETWORK_DISABLED").pipe(
  Config.option,
  Config.map(Option.exists((value) => value === "1")),
);

export const NUDGE_CLAUDE_DESKTOP_DIRECTORY = Config.String("NUDGE_CLAUDE_DESKTOP_DIR").pipe(
  Config.option,
);

export const PATH = Config.String("PATH").pipe(Config.withDefault(""));

export const BUN_BIN_DIRECTORY = Config.String("BUN_INSTALL").pipe(
  Config.orElse(() => HOME.pipe(Config.map((home) => `${home}/.bun`))),
  Config.map((directory) => `${directory}/bin`),
);
