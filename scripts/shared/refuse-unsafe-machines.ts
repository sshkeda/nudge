import { Config, Effect, FileSystem, Option, Schema } from "effect";

import { thisMachine } from "../lib/platform/index.ts";

const SHORTEST_REAL_LOGIN = 20;

const APPS_OF_LOGIN_VARIABLES = {
  CLAUDE_CODE_OAUTH_TOKEN: "Claude",
  ANTHROPIC_API_KEY: "Claude",
  ANTHROPIC_AUTH_TOKEN: "Claude",
  OPENAI_API_KEY: "Codex",
  CODEX_API_KEY: "Codex",
  CODEX_ACCESS_TOKEN: "Codex",
} as const;

const LOGIN_VARIABLES = Object.entries(APPS_OF_LOGIN_VARIABLES).map(([name, app]) => ({
  name,
  app,
}));

const isPlaceholder = ({ name, value }: { readonly name: string; readonly value: string }) =>
  new RegExp(`^\\$[A-Z\\d_]*${name}$`, "u").test(value) || value.length < SHORTEST_REAL_LOGIN;

class MachineHasRealLogin extends Schema.TaggedError<MachineHasRealLogin>()("MachineHasRealLogin", {
  app: Schema.String,
  where: Schema.String,
}) {
  public override get message() {
    return `this machine has a real ${this.app} login in ${this.where}, so nudge won't set up or test here\nhint: Run this script only in a fresh machine made for nudge, which has no login of its own`;
  }
}

class MachineBypassesFilePermissions extends Schema.TaggedError<MachineBypassesFilePermissions>()(
  "MachineBypassesFilePermissions",
  { reason: Schema.String },
) {
  public override get message() {
    return `this process ${this.reason}, so nudge won't set up or test here\nhint: Run it as a user that isn't root, and drop CAP_DAC_OVERRIDE and CAP_DAC_READ_SEARCH, for example with setpriv --inh-caps=-all --ambient-caps=-all`;
  }
}

const OptionalString = Schema.optional(Schema.NullOr(Schema.String));

const CodexAuth = Schema.fromJsonString(
  Schema.Struct({
    OPENAI_API_KEY: OptionalString,
    tokens: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          access_token: OptionalString,
          refresh_token: OptionalString,
          id_token: OptionalString,
        }),
      ),
    ),
  }),
);

const ClaudeUserConfig = Schema.fromJsonString(
  Schema.Struct({ env: Schema.optional(Schema.Record(Schema.String, Schema.String)) }),
);

const ClaudeState = Schema.fromJsonString(
  Schema.Struct({ primaryApiKey: Schema.optional(Schema.String) }),
);

const isRealValue = ({ name, value }: { readonly name: string; readonly value: unknown }) =>
  typeof value === "string" && value !== "" && !isPlaceholder({ name, value });

const readIfPresent = <Decoded>(
  file: string,
  decode: (text: string) => Effect.Effect<Decoded, Schema.SchemaError>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    if (!(yield* fileSystem.exists(file))) {
      return Option.none<Decoded>();
    }
    return Option.some(yield* decode(yield* fileSystem.readFileString(file)));
  });

const refuseRealCodexLogin = Effect.gen(function* () {
  const home = yield* Config.String("HOME");
  const codexHome = yield* Config.String("CODEX_HOME").pipe(Config.withDefault(`${home}/.codex`));
  const file = `${codexHome}/auth.json`;
  const auth = yield* readIfPresent(file, Schema.decodeEffect(CodexAuth));
  if (Option.isNone(auth)) {
    return;
  }
  const { OPENAI_API_KEY, tokens } = auth.value;
  const hasRealToken =
    isRealValue({ name: "OPENAI_API_KEY", value: OPENAI_API_KEY }) ||
    isRealValue({ name: "CODEX_ACCESS_TOKEN", value: tokens?.access_token }) ||
    isRealValue({ name: "CODEX_REFRESH_TOKEN", value: tokens?.refresh_token }) ||
    isRealValue({ name: "CODEX_ID_TOKEN", value: tokens?.id_token });
  if (hasRealToken) {
    return yield* new MachineHasRealLogin({ app: "Codex", where: file });
  }
});

const refuseRealClaudeLogin = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const home = yield* Config.String("HOME");
  const claudeDirectory = yield* Config.String("CLAUDE_CONFIG_DIR").pipe(
    Config.withDefault(`${home}/.claude`),
  );
  const credentials = `${claudeDirectory}/.credentials.json`;
  if (yield* fileSystem.exists(credentials)) {
    return yield* new MachineHasRealLogin({ app: "Claude", where: credentials });
  }
  const userConfigFile = `${claudeDirectory}/settings.json`;
  const userConfig = yield* readIfPresent(userConfigFile, Schema.decodeEffect(ClaudeUserConfig));
  const configuredVariables = Option.match(userConfig, {
    onNone: () => ({}),
    onSome: (found) => found.env ?? {},
  });
  const realConfiguredVariable = LOGIN_VARIABLES.find(({ name }) =>
    isRealValue({
      name,
      value: Object.entries(configuredVariables).find(([configured]) => configured === name)?.[1],
    }),
  );
  if (realConfiguredVariable !== undefined) {
    return yield* new MachineHasRealLogin({
      app: realConfiguredVariable.app,
      where: `${userConfigFile}'s env.${realConfiguredVariable.name}`,
    });
  }
  const stateFile = `${home}/.claude.json`;
  const state = yield* readIfPresent(stateFile, Schema.decodeEffect(ClaudeState));
  const hasRealApiKey = Option.exists(state, (found) =>
    isRealValue({ name: "ANTHROPIC_API_KEY", value: found.primaryApiKey }),
  );
  if (hasRealApiKey) {
    return yield* new MachineHasRealLogin({ app: "Claude", where: `${stateFile}'s primaryApiKey` });
  }
  const keychain = yield* (yield* thisMachine).claudeKeychainLogin;
  if (Option.isSome(keychain)) {
    return yield* new MachineHasRealLogin({ app: "Claude", where: keychain.value });
  }
});

const refuseRealLoginVariables = Effect.gen(function* () {
  const values = yield* Effect.forEach(LOGIN_VARIABLES, ({ name, app }) =>
    Effect.map(Config.option(Config.String(name)), (value) => ({ name, app, value })),
  );
  const real = values.find(({ name, value }) =>
    Option.exists(value, (found) => isRealValue({ name, value: found })),
  );
  if (real !== undefined) {
    return yield* new MachineHasRealLogin({
      app: real.app,
      where: `the environment variable ${real.name}`,
    });
  }
});

const refuseBypassingFilePermissions = Effect.gen(function* () {
  if (process.getuid?.() === 0) {
    return yield* new MachineBypassesFilePermissions({ reason: "runs as root" });
  }
  if (yield* (yield* thisMachine).bypassesFilePermissions) {
    return yield* new MachineBypassesFilePermissions({
      reason: "has CAP_DAC_OVERRIDE or CAP_DAC_READ_SEARCH, which let it read and write any file",
    });
  }
});

export const refuseUnsafeMachines = Effect.gen(function* () {
  yield* refuseBypassingFilePermissions;
  yield* refuseRealLoginVariables;
  yield* refuseRealCodexLogin;
  yield* refuseRealClaudeLogin;
});
