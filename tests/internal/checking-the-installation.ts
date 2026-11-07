import assert from "node:assert/strict";

import * as BunSocketServer from "@effect/platform-bun/BunSocketServer";
import { Task } from "@sshkeda/task";
import { ConfigProvider, Effect, FileSystem, Path, PlatformError, Result, Schema } from "effect";

import { nudgeBuild } from "../../scripts/shared/build-nudge.ts";
import { runShell } from "../../scripts/shared/run-shell.ts";
import { checkInstallation } from "../../src/internal/check-installation.ts";
import { Platform, platformLayer } from "../../src/lib/platform/index.ts";
import { quoteForShell } from "../../src/shared/report.ts";
import { resultOf } from "../shared/failure-as-value.ts";

const EXECUTABLE_MODE = 0o755;

const HELPER_REFUSAL =
  '{"error":{"message":"the Codex helper forwards only tools/call requests, not nudge/doctor"}}\n';

const MACOS_CODEX_NODE = "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node";

const FAKE_PS = `#!/bin/sh
if [ -f "$HOME/desktop-running" ]; then
  echo /Applications/ChatGPT.app/Contents/MacOS/ChatGPT
  echo /usr/lib/chatgpt/ChatGPT --type=zygote
fi
`;

const Report = Schema.fromJsonString(
  Schema.Struct({
    action: Schema.Literal("doctor"),
    nudgeVersion: Schema.String,
    status: Schema.String,
    checks: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        status: Schema.String,
        summary: Schema.String,
        hint: Schema.NullOr(Schema.String),
      }),
    ),
  }),
);

export const checkingTheInstallation = Task.make(
  "checking-the-installation",
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { codexDesktop } = yield* Platform;
      const build = yield* nudgeBuild;
      const temporary = yield* fileSystem.realPath(
        yield* fileSystem.makeTempDirectoryScoped({ directory: "/tmp" }),
      );
      const home = `${temporary}/home with spaces`;
      const root = `${home}/nudge`;
      const dist = `${root}/dist`;
      const config = `${home}/.codex/config.toml`;
      const claudeConfig = `${home}/.claude/settings.json`;
      const socket = `${home}/.local/state/nudge/codex/codex.sock`;
      for (const directory of [dist, `${home}/commands`, `${home}/.codex`, `${home}/.claude`]) {
        yield* fileSystem.makeDirectory(directory, { recursive: true });
      }
      yield* fileSystem.makeDirectory(`${home}/.local/state/nudge/codex`, { recursive: true });
      yield* fileSystem.copyFile(build.binary, `${dist}/nudge`);
      yield* fileSystem.chmod(`${dist}/nudge`, EXECUTABLE_MODE);
      yield* fileSystem.copyFile(build.helper, `${dist}/nudge-codex-desktop-helper.mjs`);
      yield* fileSystem.writeFileString(`${home}/commands/ps`, FAKE_PS);
      yield* fileSystem.chmod(`${home}/commands/ps`, EXECUTABLE_MODE);
      const snippet = [
        "[mcp_servers.nudge]",
        `command = "${codexDesktop.node}"`,
        `args = ["${dist}/nudge-codex-desktop-helper.mjs"]`,
        'env_vars = ["CODEX_APP_TOOLS_PIPE_PATH"]',
      ];
      const readme = yield* fileSystem.readFileString("README.md");
      const readmeBlock =
        /```toml\n(?<block>\[mcp_servers\.nudge\]\n[^`]*?)\n```/u.exec(readme)?.groups?.["block"] ??
        "";
      assert.deepEqual(
        readmeBlock
          .replaceAll("/path/to/nudge", root)
          .replace(MACOS_CODEX_NODE, codexDesktop.node)
          .split("\n"),
        snippet,
      );
      const reset = Effect.gen(function* () {
        yield* fileSystem.writeFileString(config, `model = "kept"\n\n${snippet.join("\n")}\n`);
        yield* fileSystem.writeFileString(
          claudeConfig,
          '{"keep":{"value":1},"crossSessionInbound":"accept"}\n',
        );
        yield* fileSystem.writeFileString(`${home}/desktop-running`, "");
      });
      const doctor = ({
        flags = "",
        onPath = true,
      }: { readonly flags?: string; readonly onPath?: boolean } = {}) =>
        runShell(
          `env -i HOME=${quoteForShell(home)} BUN_INSTALL=${quoteForShell(`${home}/.bun`)} PATH=${quoteForShell(`${home}/commands:${onPath ? `${dist}:` : ""}/usr/bin:/bin`)} ${quoteForShell(`${dist}/nudge`)} doctor ${flags} 2>&1; printf 'exit %s\\n' "$?"`,
        );
      const answering = <Value, Failure, Requirements>(
        effect: Effect.Effect<Value, Failure, Requirements>,
      ) =>
        Effect.scoped(
          Effect.gen(function* () {
            const server = yield* BunSocketServer.make({ path: socket });
            const serving = server.run((client) =>
              Effect.scoped(
                Effect.gen(function* () {
                  const reader = yield* client.reader;
                  const writer = yield* client.writer;
                  yield* reader.pull;
                  yield* writer.write(HELPER_REFUSAL);
                }),
              ).pipe(Effect.catchTags({ SocketError: () => Effect.void })),
            );
            return yield* effect.pipe(Effect.raceFirst(serving));
          }),
        );
      const rows = {
        path: "ok: nudge is on PATH at ~/nudge/dist/nudge",
        entry: "ok: ~/.codex/config.toml registers this nudge's MCP server",
        legacy: "ok: ~/.codex/config.toml has no [mcp_servers.codex_app] entry from an older nudge",
        files: "ok: nudge's Codex helper is in ~/nudge/dist",
        desktop: "ok: Codex Desktop is running",
        helper: "ok: nudge's Codex helper answers at ~/.local/state/nudge/codex/codex.sock",
        claude: "ok: Claude Code accepts messages from other sessions",
      };
      const expect = (changed: Partial<Record<keyof typeof rows, string | null>>, code: number) =>
        `${Object.entries({ ...rows, ...changed })
          .flatMap(([, line]) => (line === null ? [] : [line]))
          .join("\n")}\nexit ${code}\n`;

      yield* reset;
      assert.equal(yield* answering(doctor()), expect({}, 0));
      assert.equal(yield* fileSystem.exists(`${home}/.local/state/nudge/traces`), false);

      yield* fileSystem.symlink(root, `${home}/linked-nudge`);
      yield* fileSystem.writeFileString(
        config,
        `${snippet.join("\n").replaceAll(`${dist}/`, `${home}/linked-nudge/dist/`)}\n`,
      );
      assert.equal(yield* answering(doctor()), expect({}, 0));
      yield* reset;

      const json = yield* Schema.decodeEffect(Report)(
        (yield* answering(doctor({ flags: "--json" }))).replace(/exit 0\n$/u, ""),
      );
      assert.equal(json.status, "ok");
      assert.deepEqual(
        json.checks.map((checked) => checked.id),
        [
          "path",
          "codex.entry",
          "codex.legacy",
          "codex.files",
          "codex.desktop",
          "codex.helper",
          "claude.inbound",
        ],
      );

      assert.equal(
        yield* answering(doctor({ onPath: false })),
        expect(
          {
            path: `error: nudge isn't on PATH\nhint: cd ${quoteForShell(root)} && bun link`,
          },
          1,
        ),
      );
      yield* fileSystem.makeDirectory(`${home}/.bun/bin`, { recursive: true });
      yield* fileSystem.symlink(`${dist}/nudge`, `${home}/.bun/bin/nudge`);
      assert.equal(
        yield* answering(doctor({ onPath: false })),
        expect(
          { path: 'error: nudge isn\'t on PATH\nhint: export PATH="$HOME"/.bun/bin:"$PATH"' },
          1,
        ),
      );

      yield* fileSystem.remove(config);
      const missingEntry = yield* answering(doctor({ flags: "--json" }));
      const missing = yield* Schema.decodeEffect(Report)(missingEntry.replace(/exit 1\n$/u, ""));
      assert.equal(missing.status, "error");
      assert.deepEqual(
        missing.checks.find((checked) => checked.id === "codex.entry"),
        {
          id: "codex.entry",
          status: "error",
          summary: "~/.codex/config.toml has no [mcp_servers.nudge] entry",
          hint: [`Add this to ${config}, then restart Codex Desktop:`, ...snippet].join("\n"),
        },
      );
      assert.equal(
        yield* answering(doctor()),
        expect(
          {
            entry: [
              "error: ~/.codex/config.toml has no [mcp_servers.nudge] entry",
              `hint: Add this to ${config}, then restart Codex Desktop:`,
              ...snippet,
            ].join("\n"),
          },
          1,
        ),
      );

      yield* fileSystem.writeFileString(
        config,
        `${snippet.join("\n").replace(`${dist}/nudge-codex-desktop-helper.mjs`, "/elsewhere/nudge-codex-desktop-helper.mjs")}\n\n[mcp_servers.codex_app]\ncommand = "old"\n`,
      );
      assert.equal(
        yield* answering(doctor()),
        expect(
          {
            entry: [
              "error: ~/.codex/config.toml's [mcp_servers.nudge] entry doesn't point at this nudge",
              `hint: Replace the [mcp_servers.nudge] entry in ${config} with this, then restart Codex Desktop:`,
              ...snippet,
            ].join("\n"),
            legacy: `error: ~/.codex/config.toml still has the [mcp_servers.codex_app] entry from an older nudge\nhint: Remove the [mcp_servers.codex_app] entry from ${config}, then restart Codex Desktop.`,
          },
          1,
        ),
      );

      yield* fileSystem.writeFileString(config, "broken = [");
      const broken = yield* answering(doctor());
      assert.match(
        broken,
        new RegExp(
          `^error: can't read ~/.codex/config.toml: .+\nhint: Fix the TOML syntax in ${RegExp.escape(config)}, then run nudge doctor again.$`,
          "mu",
        ),
      );
      assert.doesNotMatch(broken, /codex_app/u);

      yield* reset;
      yield* fileSystem.remove(`${dist}/nudge-codex-desktop-helper.mjs`);
      assert.equal(
        yield* answering(doctor()),
        expect(
          {
            files: `error: nudge's Codex helper is missing: ~/nudge/dist/nudge-codex-desktop-helper.mjs\nhint: cd ${quoteForShell(root)} && bun scripts/build.ts`,
          },
          1,
        ),
      );
      yield* fileSystem.copyFile(build.helper, `${dist}/nudge-codex-desktop-helper.mjs`);

      assert.equal(
        yield* doctor(),
        expect(
          {
            helper:
              "error: nudge's Codex helper doesn't answer at ~/.local/state/nudge/codex/codex.sock\nhint: Quit and reopen Codex Desktop so it loads nudge's MCP server.",
          },
          1,
        ),
      );
      yield* fileSystem.remove(`${home}/desktop-running`);
      assert.equal(
        yield* doctor(),
        expect(
          {
            desktop: `error: Codex Desktop isn't running\nhint: ${codexDesktop.open}`,
            helper: `error: nudge's Codex helper doesn't answer at ~/.local/state/nudge/codex/codex.sock\nhint: ${codexDesktop.open}`,
          },
          1,
        ),
      );

      yield* reset;
      yield* fileSystem.remove(claudeConfig);
      assert.equal(
        yield* answering(doctor()),
        expect(
          {
            claude: [
              "error: Claude Code doesn't accept messages from other sessions because ~/.claude/settings.json doesn't exist",
              `hint: Create ${claudeConfig} with this, then restart Claude Code:`,
              '{ "crossSessionInbound": "accept" }',
            ].join("\n"),
          },
          1,
        ),
      );
      for (const [contents, current] of [
        ['{"keep":1}', "isn't set"],
        ['{"crossSessionInbound":"hold"}', 'is "hold"'],
      ] as const) {
        yield* fileSystem.writeFileString(claudeConfig, contents);
        assert.equal(
          yield* answering(doctor()),
          expect(
            {
              claude: [
                `error: Claude Code doesn't accept messages from other sessions because crossSessionInbound ${current} in ~/.claude/settings.json`,
                `hint: Set this in the top-level object of ${claudeConfig}, then restart Claude Code:`,
                '"crossSessionInbound": "accept"',
              ].join("\n"),
            },
            1,
          ),
        );
      }
      yield* fileSystem.writeFileString(claudeConfig, '{"keep":');
      assert.equal(
        yield* answering(doctor()),
        expect(
          {
            claude: `error: can't read ~/.claude/settings.json because it isn't a JSON object\nhint: Fix the JSON syntax in ${claudeConfig}, then run nudge doctor again.`,
          },
          1,
        ),
      );
      assert.equal(yield* fileSystem.readFileString(claudeConfig), '{"keep":');

      yield* reset;
      const executableDirectory = (yield* Path.Path).dirname(
        yield* fileSystem.realPath(process.execPath),
      );
      for (const denied of [
        `${home}/.bun/bin/nudge`,
        `${executableDirectory}/nudge-codex-desktop-helper.mjs`,
      ]) {
        const permissionDenied = PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: "exists",
          pathOrDescriptor: denied,
        });
        const outcome = yield* resultOf(
          checkInstallation.pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fileSystem,
              exists: (file) =>
                file === denied ? Effect.fail(permissionDenied) : fileSystem.exists(file),
            }),
            Effect.provide(
              ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: home, PATH: "" })),
            ),
          ),
        );
        assert.ok(Result.isFailure(outcome));
        assert.equal(outcome.failure._tag, "InstallationFileUncheckable");
        assert.match(outcome.failure.message, /^nudge doctor can't tell whether /u);
        assert.ok(outcome.failure.message.includes(denied));
        assert.ok(outcome.failure.message.endsWith(permissionDenied.message));
      }
    }).pipe(Effect.provide(platformLayer)),
  ),
  { timeout: "3 minutes", cleanup: "1 minute" },
);
