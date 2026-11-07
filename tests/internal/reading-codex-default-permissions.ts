import assert from "node:assert/strict";
import { createServer } from "node:net";
import type { Server } from "node:net";

import { Task } from "@sshkeda/task";
import { Deferred, Effect, FileSystem, Layer, Option, Result, Schema } from "effect";
import { TestClock } from "effect/testing";

import { APP_SERVER_WAIT } from "../../src/lib/codex/internal/errors.ts";
import { resolveDefaultPermissions } from "../../src/lib/codex/internal/read-default-permissions.ts";
import { resultOf } from "../shared/failure-as-value.ts";

const FAKE_APP_SERVER = `
const [scenarioFile] = process.argv.slice(2);
const scenario = await Bun.file(scenarioFile).json();
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const answer = (message) => {
  if (scenario.stopOn === message.method) {
    console.error("fake app-server stopped on " + message.method);
    process.exit(1);
  }
  if (scenario.silentOn === message.method) {
    Bun.connect({ unix: scenario.signal, socket: { data() {} } });
    return;
  }
  if (scenario.failOn === message.method) {
    write({ id: message.id, error: { code: -32603, message: scenario.failure } });
    return;
  }
  write({ method: "account/updated", params: { authMode: null } });
  if (message.method === "initialize") {
    write({ id: message.id, result: { userAgent: "fake", codexHome: "/nowhere" } });
  } else if (message.method === "config/read") {
    if (scenario.cwd !== message.params.cwd) {
      write({ id: message.id, error: { code: -1, message: "unexpected cwd " + message.params.cwd } });
      return;
    }
    write({ id: message.id, result: { config: scenario.config, origins: {}, layers: null } });
  } else if (message.method === "configRequirements/read") {
    write({ id: message.id, result: { requirements: scenario.requirements } });
  } else if (message.method === "permissionProfile/list") {
    const index = message.params.cursor === null ? 0 : Number(message.params.cursor);
    const nextCursor = index + 1 < scenario.pages.length ? String(index + 1) : null;
    write({ id: message.id, result: { data: scenario.pages[index], nextCursor } });
  }
};
let buffer = "";
const decoder = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk);
  for (let end = buffer.indexOf("\\n"); end >= 0; end = buffer.indexOf("\\n")) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (message.id !== undefined) {
      answer(message);
    }
  }
}
`;

const BUILT_IN_PROFILES = [
  { id: ":read-only", description: null, allowed: true },
  { id: ":workspace", description: null, allowed: true },
  { id: ":danger-full-access", description: null, allowed: true },
] as const;

const EMPTY_CONFIG = {
  model: null,
  approval_policy: null,
  approvals_reviewer: null,
  sandbox_mode: null,
  sandbox_workspace_write: null,
  default_permissions: null,
} as const;

const FULL_ACCESS_SELECTION = { kind: "agent-mode", agentMode: "full-access" } as const;

const MODEL = "gpt-6-luna";

const COULD_NOT_READ =
  "nudge didn't start the session, because it couldn't read your Codex default permissions.";

const PROJECT = "/projects/nudge";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

const listenForSignal = (socket: string) =>
  Effect.gen(function* () {
    const signalled = yield* Deferred.make<void>();
    yield* Effect.acquireRelease(
      Effect.callback<Server>((resume) => {
        const server = createServer((connection) => {
          connection.end();
          Deferred.doneUnsafe(signalled, Effect.void);
        });
        server.listen(socket, () => {
          resume(Effect.succeed(server));
        });
      }),
      (server) => Effect.sync(() => server.close()),
    );
    return signalled;
  });

const resolve = (scenario: {
  readonly config?: Readonly<Record<string, Schema.Json>>;
  readonly requirements?: Schema.Json;
  readonly pages?: Schema.Json;
  readonly saved?: Schema.Json;
  readonly workspaceKind?: "project" | "projectless";
  readonly failOn?: string;
  readonly failure?: string;
  readonly stopOn?: string;
  readonly silentOn?: string;
  readonly program?: string;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const home = yield* fileSystem.makeTempDirectoryScoped({ directory: "/tmp" });
      const workspaceKind = scenario.workspaceKind ?? "project";
      const directory = workspaceKind === "project" ? Option.some(PROJECT) : Option.none<string>();
      const signal = `${home}/signal.sock`;
      const signalled = yield* listenForSignal(signal);
      yield* fileSystem.writeFileString(`${home}/fake-app-server.js`, FAKE_APP_SERVER);
      yield* fileSystem.writeFileString(
        `${home}/scenario.json`,
        yield* encodeJson({
          config: { ...EMPTY_CONFIG, ...scenario.config },
          requirements: scenario.requirements ?? null,
          pages: scenario.pages ?? [BUILT_IN_PROFILES],
          cwd: Option.getOrNull(directory),
          failOn: scenario.failOn ?? null,
          failure: scenario.failure ?? null,
          stopOn: scenario.stopOn ?? null,
          silentOn: scenario.silentOn ?? null,
          signal,
        }),
      );
      if (scenario.saved !== undefined) {
        yield* fileSystem.writeFileString(
          `${home}/.codex-global-state.json`,
          yield* encodeJson({
            "electron-persisted-atom-state": {
              "permission-selection-by-host-id:local": scenario.saved,
            },
          }),
        );
      }
      const resolving = resultOf(
        resolveDefaultPermissions({
          root: home,
          directory,
          model: Option.some(MODEL),
          workspaceKind,
          appServer: [
            scenario.program ?? process.execPath,
            `${home}/fake-app-server.js`,
            `${home}/scenario.json`,
          ],
        }),
      );
      if (scenario.silentOn === undefined) {
        return yield* resolving;
      }
      const advancing = Effect.gen(function* () {
        yield* Deferred.await(signalled);
        yield* TestClock.adjust(APP_SERVER_WAIT);
      });
      const [resolved] = yield* Effect.all([resolving, advancing], {
        concurrency: "unbounded",
      });
      return resolved;
    }),
  ).pipe(Effect.provide(Layer.fresh(TestClock.layer())));

const expectSelection = ({
  scenario,
  selection,
  source,
  isFullAccess,
}: {
  readonly scenario: Parameters<typeof resolve>[0];
  readonly selection: Schema.Json;
  readonly source: string;
  readonly isFullAccess: boolean;
}) =>
  Effect.gen(function* () {
    const resolved = yield* resolve(scenario);
    assert.ok(
      Result.isSuccess(resolved),
      Result.isFailure(resolved) ? resolved.failure.message : "",
    );
    assert.deepEqual(resolved.success, { source, selection, isFullAccess });
  });

const expectFailure = ({
  scenario,
  message,
}: {
  readonly scenario: Parameters<typeof resolve>[0];
  readonly message: RegExp | string;
}) =>
  Effect.gen(function* () {
    const resolved = yield* resolve(scenario);
    assert.ok(Result.isFailure(resolved), "nudge resolved permissions it couldn't read");
    if (typeof message === "string") {
      assert.equal(resolved.failure.message, message);
    } else {
      assert.match(resolved.failure.message, message);
    }
  });

export const readingCodexDefaultPermissions = Task.make(
  "reading-codex-default-permissions",
  Effect.gen(function* () {
    yield* expectSelection({
      scenario: { saved: FULL_ACCESS_SELECTION },
      selection: FULL_ACCESS_SELECTION,
      source: "saved",
      isFullAccess: true,
    });
    yield* expectSelection({
      scenario: {
        saved: FULL_ACCESS_SELECTION,
        config: { sandbox_mode: "read-only", approval_policy: "on-request" },
      },
      selection: FULL_ACCESS_SELECTION,
      source: "saved",
      isFullAccess: true,
    });
    yield* expectSelection({
      scenario: { config: { default_permissions: ":danger-full-access" } },
      selection: FULL_ACCESS_SELECTION,
      source: "configured",
      isFullAccess: true,
    });
    yield* expectSelection({
      scenario: { config: { sandbox_mode: "danger-full-access", approval_policy: "never" } },
      selection: { kind: "agent-mode", agentMode: "guardian-approvals" },
      source: "fallback",
      isFullAccess: false,
    });
    yield* expectSelection({
      scenario: {},
      selection: { kind: "agent-mode", agentMode: "guardian-approvals" },
      source: "fallback",
      isFullAccess: false,
    });
    yield* expectSelection({
      scenario: { config: { features: { guardian_approval: false } } },
      selection: { kind: "agent-mode", agentMode: "auto" },
      source: "fallback",
      isFullAccess: false,
    });
    yield* expectSelection({
      scenario: { workspaceKind: "projectless", saved: { kind: "agent-mode", agentMode: "auto" } },
      selection: { kind: "agent-mode", agentMode: "granular" },
      source: "saved",
      isFullAccess: false,
    });
    yield* expectSelection({
      scenario: {
        saved: FULL_ACCESS_SELECTION,
        pages: [
          [
            { id: ":read-only", description: null, allowed: true },
            { id: ":workspace", description: null, allowed: false },
            { id: ":danger-full-access", description: null, allowed: false },
          ],
        ],
      },
      selection: { kind: "agent-mode", agentMode: "read-only" },
      source: "fallback",
      isFullAccess: false,
    });
    yield* expectSelection({
      scenario: {
        saved: FULL_ACCESS_SELECTION,
        config: { default_permissions: "reviewed" },
        pages: [BUILT_IN_PROFILES, [{ id: "reviewed", description: null, allowed: true }]],
      },
      selection: FULL_ACCESS_SELECTION,
      source: "saved",
      isFullAccess: true,
    });
    yield* expectSelection({
      scenario: {
        config: { default_permissions: "reviewed" },
        pages: [BUILT_IN_PROFILES, [{ id: "reviewed", description: null, allowed: true }]],
      },
      selection: { kind: "profile", profileId: "reviewed" },
      source: "configured",
      isFullAccess: false,
    });
    yield* expectSelection({
      scenario: {
        saved: FULL_ACCESS_SELECTION,
        requirements: { autoReview: { requiredOnModels: [MODEL] } },
      },
      selection: { kind: "agent-mode", agentMode: "guardian-approvals" },
      source: "required",
      isFullAccess: false,
    });
    yield* expectSelection({
      scenario: {
        saved: FULL_ACCESS_SELECTION,
        requirements: {
          allowedPermissionProfiles: { ":read-only": true, ":workspace": true },
          defaultPermissions: null,
        },
        pages: [
          [
            { id: ":read-only", description: null, allowed: true },
            { id: ":workspace", description: null, allowed: true },
            { id: ":danger-full-access", description: null, allowed: false },
          ],
        ],
      },
      selection: { kind: "agent-mode", agentMode: "auto" },
      source: "configured",
      isFullAccess: false,
    });
    yield* expectFailure({
      scenario: {
        failOn: "config/read",
        failure: "failed to read configuration layers: config.toml:1:18: invalid basic string",
      },
      message: `${COULD_NOT_READ} Codex's app-server returned an error, "failed to read configuration layers: config.toml:1:18: invalid basic string".`,
    });
    yield* expectFailure({
      scenario: { stopOn: "configRequirements/read" },
      message: `${COULD_NOT_READ} Codex's app-server stopped before answering.\nfake app-server stopped on configRequirements/read`,
    });
    yield* expectFailure({
      scenario: { config: { sandbox_mode: 5 } },
      message: `${COULD_NOT_READ} Codex's app-server answered in a way nudge doesn't understand.`,
    });
    yield* expectFailure({
      scenario: { pages: [[]] },
      message: `${COULD_NOT_READ} Codex's app-server listed no permission profiles.`,
    });
    yield* expectFailure({
      scenario: { silentOn: "config/read" },
      message: `${COULD_NOT_READ} Codex's app-server didn't answer within 15 seconds.`,
    });
    yield* expectFailure({
      scenario: { program: "/nonexistent/codex" },
      message:
        /^nudge didn't start the session, because it couldn't read your Codex default permissions\. Codex's app-server didn't start\.\n./u,
    });
  }),
);
