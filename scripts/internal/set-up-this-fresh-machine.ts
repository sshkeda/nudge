import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Option, Path, Schema } from "effect";

import {
  CLAUDE_DOWNLOADS,
  CLAUDE_SHA256,
  download,
  installedVersion,
  CODEX_UPDATER_DEFAULTS,
  installCodexDesktop,
  thisMachine,
} from "../lib/platform/index.ts";
import { startMockModel } from "../shared/aimock.ts";
import {
  BUN,
  CLAUDE_VERSION,
  MOCK_MODEL_PROVIDER,
  MOCK_MODEL_URL,
  PROJECT,
  requireSetUpMachine,
} from "../shared/codex-and-claude.ts";
import { refuseUnsafeMachines } from "../shared/refuse-unsafe-machines.ts";
import { runShell } from "../shared/run-shell.ts";
import { SetUpRefused } from "../shared/set-up-refused.ts";

const README = `${PROJECT}README.md`;

const INSTALL_SECTION = "Get started";

const CLONE_COMMAND = "git clone ";

const PATH_PLACEHOLDER = "/path/to/nudge";

const LINUX_OVERRIDE_INTRODUCTION = "On Linux";

const TOML_TABLE_HEADER = /^\[/mu;

const TOML_KEY = /^(?<key>[\w-]+)\s*=/u;

const SEED_PROMPT = "seed";

const EXECUTABLE_MODE = 0o755;

class InstallGuideStepMissing extends Schema.TaggedError<InstallGuideStepMissing>()(
  "InstallGuideStepMissing",
  { step: Schema.String },
) {
  public override get message() {
    return `README.md's ${INSTALL_SECTION} section has no ${this.step}`;
  }
}

const readMarkdownEvents = (markdown: string) => {
  const events: { readonly kind: string; readonly text: string; readonly language: string }[] = [];
  Bun.markdown.render(markdown, {
    heading: (children, meta) => {
      events.push({ kind: `h${meta.level}`, text: children, language: "" });
      return children;
    },
    paragraph: (children) => {
      events.push({ kind: "paragraph", text: children, language: "" });
      return children;
    },
    code: (children, meta) => {
      events.push({ kind: "code", text: children, language: meta?.language ?? "" });
      return children;
    },
  });
  return events;
};

const readInstallGuide = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const events = readMarkdownEvents(yield* fileSystem.readFileString(README));
  const start = events.findIndex((event) => event.kind === "h2" && event.text === INSTALL_SECTION);
  const end = events.findIndex((event, index) => index > start && event.kind === "h2");
  const section = start === -1 ? [] : events.slice(start + 1, end === -1 ? undefined : end);
  const blocks = section.flatMap((event, index) =>
    event.kind === "code"
      ? [
          {
            ...event,
            introduction:
              section.findLast((earlier, at) => at < index && earlier.kind === "paragraph")?.text ??
              "",
          },
        ]
      : [],
  );
  const find = (step: string, matches: (block: (typeof blocks)[number]) => boolean) => {
    const found = blocks.find((block) => matches(block));
    return found === undefined
      ? Effect.fail(new InstallGuideStepMissing({ step }))
      : Effect.succeed(found.text);
  };
  return {
    commands: (yield* find("bash code block", (block) => block.language === "bash"))
      .split("\n")
      .filter((line) => !line.startsWith(CLONE_COMMAND))
      .join("\n"),
    codexConfig: yield* find(
      `TOML code block with a table and ${PATH_PLACEHOLDER}`,
      (block) =>
        block.language === "toml" &&
        TOML_TABLE_HEADER.test(block.text) &&
        block.text.includes(PATH_PLACEHOLDER),
    ),
    linuxCodexLines: blocks
      .filter(
        (block) =>
          block.language === "toml" &&
          !TOML_TABLE_HEADER.test(block.text) &&
          block.introduction.startsWith(LINUX_OVERRIDE_INTRODUCTION),
      )
      .flatMap((block) => block.text.split("\n").filter((line) => line.trim() !== "")),
    claudeConfig: yield* find("JSON code block", (block) => block.language === "json"),
  };
});

const keyOf = (line: string) => TOML_KEY.exec(line)?.groups?.["key"] ?? "";

const replaceKeyLines = ({
  toml,
  replacements,
}: {
  readonly toml: string;
  readonly replacements: readonly string[];
}) => {
  const replacementsByKey = new Map(replacements.map((line) => [keyOf(line), line]));
  return toml
    .split("\n")
    .map((line) => replacementsByKey.get(keyOf(line)) ?? line)
    .join("\n");
};

const ClaudeConfig = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json));

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

const writeConfigFiles = Effect.fn("writeConfigFiles")(function* (
  machine: Effect.Success<typeof thisMachine>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { home } = machine;
  const guide = yield* readInstallGuide;
  const nudgeCodexConfig = replaceKeyLines({
    toml: guide.codexConfig,
    replacements: machine.codexConfigReplacements(guide.linuxCodexLines),
  }).replaceAll(PATH_PLACEHOLDER, PROJECT.replace(/\/$/u, ""));
  const claudeConfigFromGuide = yield* Schema.decodeEffect(ClaudeConfig)(guide.claudeConfig);
  const files = {
    [machine.codexConfig]: `model_provider = "${MOCK_MODEL_PROVIDER}"

[model_providers.${MOCK_MODEL_PROVIDER}]
name = "${MOCK_MODEL_PROVIDER}"
base_url = "${MOCK_MODEL_URL}/v1"
requires_openai_auth = true
wire_api = "responses"

[projects."${home}/work"]
trust_level = "trusted"

${nudgeCodexConfig}
`,
    [`${home}/.codex/auth.json`]: yield* encodeJson({ OPENAI_API_KEY: MOCK_MODEL_PROVIDER }),
    [`${home}/.codex/.codex-global-state.json`]: yield* encodeJson({
      "electron-persisted-atom-state": {
        "electron:onboarding-welcome-pending": false,
        "electron:onboarding-projectless-completed": true,
        "electron:onboarding-hide-first-new-thread-promos": true,
        last_completed_onboarding: 1_790_379_764,
        "electron:onboarding-welcome-v2-role-state": {
          completedConversationalOnboarding: true,
          completedConversationalOnboardingTaskId: null,
          completedConversationalOnboardingTaskSnapshot: null,
          conversationalOnboardingSkipped: true,
          onboardingCreditRewardWarningShown: false,
          roles: ["engineering"],
          personalizedSuggestionsEnabled: false,
          workMode: "coding",
        },
      },
    }),
    [`${home}/.codex/rules/nudge.rules`]: `prefix_rule(pattern=["${machine.nudge}"], decision="allow")
prefix_rule(pattern=["nudge"], decision="allow")
`,
    [machine.claudeConfig]: yield* encodeJson({
      env: {
        ANTHROPIC_BASE_URL: MOCK_MODEL_URL,
        ANTHROPIC_API_KEY: MOCK_MODEL_PROVIDER,
        DISABLE_AUTOUPDATER: "1",
      },
      ...claudeConfigFromGuide,
    }),
    [`${home}/.claude.json`]: yield* encodeJson({
      hasCompletedOnboarding: true,
      theme: "dark",
      customApiKeyResponses: { approved: [MOCK_MODEL_PROVIDER] },
      projects: {
        [`${home}/work`]: { hasTrustDialogAccepted: true },
        [`${home}/held`]: { hasTrustDialogAccepted: true },
        [`${home}/Documents/Codex`]: { hasTrustDialogAccepted: true },
      },
    }),
    [`${home}/held/.claude/settings.json`]: yield* encodeJson({ crossSessionInbound: "hold" }),
  };
  return {
    files: Object.keys(files),
    write: Effect.forEach(
      Object.entries(files),
      ([file, text]) =>
        Effect.gen(function* () {
          yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
          yield* fileSystem.writeFileString(file, text, { flag: "wx" });
        }),
      { discard: true },
    ),
  };
});

const isTaken = (file: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    if (yield* fileSystem.exists(file)) {
      return true;
    }
    return yield* fileSystem.readLink(file).pipe(
      Effect.as(true),
      Effect.catchTag("PlatformError", () => Effect.succeed(false)),
    );
  });

const refuseExistingFiles = (files: readonly string[]) =>
  Effect.gen(function* () {
    const existing = yield* Effect.filter(files, isTaken);
    const [first] = existing;
    if (first !== undefined) {
      return yield* new SetUpRefused({ file: first });
    }
  });

const installClaudeCode = Effect.fn("installClaudeCode")(function* (
  machine: Effect.Success<typeof thisMachine>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const versions = `${machine.home}/.local/share/claude/versions`;
  const binary = `${versions}/${CLAUDE_VERSION}`;
  yield* refuseExistingFiles([binary]);
  yield* fileSystem.makeDirectory(versions, { recursive: true });
  yield* fileSystem.makeDirectory(path.dirname(machine.claude), { recursive: true });
  yield* download({
    url: `${CLAUDE_DOWNLOADS}/${CLAUDE_VERSION}/${machine.platform}/claude`,
    sha256: CLAUDE_SHA256[machine.platform],
    to: binary,
  });
  yield* fileSystem.chmod(binary, EXECUTABLE_MODE);
  yield* fileSystem.symlink(binary, machine.claude);
});

const CLAUDE_PATH_LINE = 'export PATH="$HOME/.local/bin:$PATH"';

const addClaudeToPath = Effect.fn("addClaudeToPath")(function* (
  machine: Effect.Success<typeof thisMachine>,
) {
  yield* Effect.log(
    `Adding ~/.local/bin to PATH in ${machine.claudeShellConfig}, as Claude Code's installer tells users to, so Codex Desktop's tasks find claude.`,
  );
  yield* (yield* FileSystem.FileSystem).writeFileString(
    machine.claudeShellConfig,
    `${CLAUDE_PATH_LINE}\n`,
    { flag: "a" },
  );
});

const linkNodeToBun = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hasNode = yield* installedVersion(
    `export PATH="${path.dirname(BUN)}:$PATH"; command -v node`,
  );
  if (Option.isSome(hasNode)) {
    return;
  }
  const link = path.join(path.dirname(BUN), "node");
  yield* Effect.log(`Linking ${link} to ${BUN}, because effect-tsgo runs node.`);
  yield* fileSystem.symlink(BUN, link);
});

const installNudge = Effect.gen(function* () {
  const path = yield* Path.Path;
  const guide = yield* readInstallGuide;
  yield* Effect.log(`Running README.md's ${INSTALL_SECTION} commands in ${PROJECT}.`);
  yield* runShell(
    `set -eu\nexport PATH="${path.dirname(BUN)}:$HOME/.bun/bin:$PATH"\ncd '${PROJECT}'\n${guide.commands}`,
  );
});

const seedCodex = Effect.fn("seedCodex")(function* (machine: Effect.Success<typeof thisMachine>) {
  yield* startMockModel;
  yield* runShell(
    `mkdir -p ~/work && cd ~/work && '${machine.codexCli}' exec --skip-git-repo-check ${SEED_PROMPT} < /dev/null`,
  );
}, Effect.scoped);

class AlreadyInstalled extends Schema.TaggedError<AlreadyInstalled>()("AlreadyInstalled", {
  app: Schema.String,
  path: Schema.String,
}) {
  public override get message() {
    return `${this.app} is already installed at ${this.path}, and set-up-fresh-machine.ts runs only on a fresh machine`;
  }
}

const refuseHalfSetUpMachines = Effect.fn("refuseHalfSetUpMachines")(function* (
  machine: Effect.Success<typeof thisMachine>,
  configFiles: readonly string[],
) {
  if (yield* isTaken(machine.app)) {
    return yield* new AlreadyInstalled({ app: "Codex Desktop", path: machine.app });
  }
  const claudeOnPath = yield* installedVersion("command -v claude");
  if (Option.isSome(claudeOnPath)) {
    return yield* new AlreadyInstalled({ app: "Claude Code", path: claudeOnPath.value });
  }
  if (yield* isTaken(machine.claude)) {
    return yield* new AlreadyInstalled({ app: "Claude Code", path: machine.claude });
  }
  yield* refuseExistingFiles([
    ...configFiles,
    `${machine.home}/.local/share/claude`,
    ...(machine.platform.startsWith("linux") ? [CODEX_UPDATER_DEFAULTS] : []),
  ]);
});

export const setUpFreshMachine = Task.make(
  "set-up-fresh-machine",
  Effect.gen(function* () {
    yield* refuseUnsafeMachines;
    const machine = yield* thisMachine;
    const config = yield* writeConfigFiles(machine);
    yield* refuseHalfSetUpMachines(machine, config.files);
    yield* machine.installPrerequisites;
    yield* linkNodeToBun;
    yield* installCodexDesktop(machine, refuseExistingFiles);
    yield* installClaudeCode(machine);
    yield* addClaudeToPath(machine);
    yield* installNudge;
    yield* config.write;
    yield* seedCodex(machine);
    yield* requireSetUpMachine;
    yield* Effect.log(
      `This ${machine.platform} machine is set up for nudge's tests. Snapshot it now, before it gets any login.`,
    );
  }),
  { timeout: "30 minutes", cleanup: "1 minute" },
);
