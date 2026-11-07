import assert from "node:assert/strict";

import { Effect } from "effect";

import { BUN, MOCK_MODEL_URL, PROJECT } from "../../scripts/shared/codex-and-claude.ts";
import { startCodexDesktop } from "../../scripts/shared/codex-desktop.ts";
import {
  CODEX_MODEL_AND_EFFORT,
  FAILED_EXIT_CODE,
  machineTest,
  NUDGE,
  rows,
} from "./machine-commands.ts";
import { recordingCallerDecisions } from "./recording-traces.ts";

export const GLOBAL_STATE = "~/.codex/.codex-global-state.json";

export const CHOOSE_FULL_ACCESS = `${BUN} -e '
const file = process.env.HOME + "/.codex/.codex-global-state.json";
const state = await Bun.file(file).json();
const atoms = (state["electron-persisted-atom-state"] ??= {});
atoms["permission-selection-by-host-id:local"] = { kind: "agent-mode", agentMode: "full-access" };
atoms["agent-mode-by-host-id"] = { ...atoms["agent-mode-by-host-id"], local: "full-access" };
await Bun.write(file, JSON.stringify(state));'`;

const FIRST_TURN_CONTEXT =
  /"approval_policy":"(?<approval>[^"]+)".*"sandbox_policy":\{"type":"(?<sandbox>[^"]+)"/u;

export const matchingTheDefaultPermissions = machineTest((machine) =>
  Effect.gen(function* () {
    const modelsUrl = `${MOCK_MODEL_URL}/v1/models`;
    const probe = (tag: string) =>
      `if curl -sSf -o /dev/null ${modelsUrl}; then touch ${machine.scratch}/network-${tag}; fi; touch ${machine.scratch}/outside-${tag}`;
    const startFromTerminal = (tag: string) =>
      machine.start(`codex --name 'Default ${tag}' 'RUN_COMMAND: ${probe(tag)}'`);
    const startFromClaude = (tag: string) =>
      Effect.gen(function* () {
        const claudeRun = yield* machine.attempt(
          `claude -p 'RUN_COMMAND: ${NUDGE} new codex ${CODEX_MODEL_AND_EFFORT} --name "Default ${tag}" "RUN_COMMAND: ${probe(tag)}"' --allowedTools Bash`,
        );
        assert.equal(claudeRun.code, 0, claudeRun.standardError);
        return (yield* machine.showJson(`Default ${tag}`)).target.id;
      });
    const permissionsOf = (id: string) =>
      Effect.gen(function* () {
        yield* machine.waitUntilIdle(id);
        const { transcript } = (yield* machine.showJson(id)).target;
        const turnContext = yield* machine.shell(
          `grep -m1 '"type":"turn_context"' '${transcript}'`,
        );
        const approvalRequests = yield* machine.shell(
          `grep -cE '"type":"[a-z_]*(approval|permissions)_request' '${transcript}' || true`,
        );
        const groups = FIRST_TURN_CONTEXT.exec(turnContext)?.groups;
        return {
          approval: groups?.["approval"],
          sandbox: groups?.["sandbox"],
          approvalRequests: Number(approvalRequests),
        };
      });
    const filesOf = (tag: string) =>
      machine.shell(
        `ls ${machine.scratch} | grep -E -- '-${tag}$' | sort | paste -sd ' ' - || true`,
      );

    const expectPermissions = ({
      id,
      tag,
      isFullAccess,
      archive = true,
    }: {
      readonly id: string;
      readonly tag: string;
      readonly isFullAccess: boolean;
      readonly archive?: boolean;
    }) =>
      Effect.gen(function* () {
        assert.deepEqual(
          yield* permissionsOf(id),
          isFullAccess
            ? { approval: "never", sandbox: "danger-full-access", approvalRequests: 0 }
            : { approval: "on-request", sandbox: "workspace-write", approvalRequests: 0 },
        );
        const { transcript } = (yield* machine.showJson(id)).target;
        assert.equal(
          yield* filesOf(tag),
          isFullAccess ? `network-${tag} outside-${tag}` : "",
          yield* machine.shell(
            `grep -E 'function_call|exec_command' '${transcript}' | cut -c1-700`,
          ),
        );
        if (archive) {
          yield* machine.nudge(`archive ${id}`);
        }
      });

    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* startCodexDesktop();
        yield* expectPermissions({
          id: yield* startFromTerminal("limited-terminal"),
          tag: "limited-terminal",
          isFullAccess: false,
        });
        yield* expectPermissions({
          id: yield* startFromClaude("limited-claude"),
          tag: "limited-claude",
          isFullAccess: false,
        });
        yield* machine.shell(machine.quitCodex);
      }),
    );

    const startWithoutCodex = machine.attempt(
      `${NUDGE} new codex ${CODEX_MODEL_AND_EFFORT} 'hello without Codex'`,
    );
    const helperNotRunning = (reason: string) => ({
      code: FAILED_EXIT_CODE,
      standardOutput: "",
      standardError: `error: nothing answers at ~/.local/state/nudge/codex/codex.sock, where nudge's Codex helper listens while Codex Desktop is open and ~/.codex/config.toml has the [mcp_servers.nudge] entry from nudge's README: connect ${reason} ${machine.bridgeSocket}\nhint: nudge doctor`,
    });
    const afterQuit = yield* startWithoutCodex;
    const reason = /connect (?<code>ECONNREFUSED|ENOENT) /u.exec(afterQuit.standardError)?.groups?.[
      "code"
    ];
    assert.deepEqual(afterQuit, helperNotRunning(reason ?? "ECONNREFUSED or ENOENT"));
    yield* machine.shell(`rm -f ${machine.bridgeSocket}`);
    assert.deepEqual(yield* startWithoutCodex, helperNotRunning("ENOENT"));

    const savedConfig = `${machine.scratch}/config.toml`;
    yield* machine.shell(
      `cp ~/.codex/config.toml ${savedConfig} && printf '%s\\n' 'model = "unclosed' >> ~/.codex/config.toml`,
    );
    const withTypo = yield* machine.attempt(
      `${NUDGE} new codex ${CODEX_MODEL_AND_EFFORT} 'hello with a typo in config.toml'`,
    );
    yield* machine.shell(`cp ${savedConfig} ~/.codex/config.toml`);
    assert.equal(withTypo.code, FAILED_EXIT_CODE, withTypo.standardError);
    assert.equal(withTypo.standardOutput, "");
    assert.match(
      withTypo.standardError,
      /^error: nudge can't list Codex's models, because .*codex debug models failed: .*config\.toml/u,
    );

    const savedState = `${machine.scratch}/codex-global-state.json`;
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* startCodexDesktop({
          beforeStart: `cp ${GLOBAL_STATE} ${savedState}\n${CHOOSE_FULL_ACCESS}`,
        });
        const legacyCaller = yield* startFromTerminal("legacy-caller");
        yield* machine.waitUntilIdle(legacyCaller);
        assert.equal(
          yield* machine.shell(`cd '${PROJECT}' && ${BUN} -e '
    import { BunServices } from "@effect/platform-bun";
    import * as BunCrypto from "@effect/platform-bun/BunCrypto";
    import { Effect, Layer } from "effect";
    import { askCodexDesktop, requireSuccess } from "./src/lib/codex/internal/codex-desktop-ipc.ts";
    const method = "thread-follower-update-thread-settings";
    const update = askCodexDesktop({
      socket: process.env.HOME + "/.codex/ipc/ipc.sock",
      method, version: 2,
      parameters: { conversationId: "${legacyCaller}", threadSettings: {
        permissions: null, sandboxPolicy: { type: "dangerFullAccess" },
        approvalPolicy: "never", approvalsReviewer: "user"
      } }
    });
    const applied = update.pipe(Effect.flatMap((answer) => requireSuccess({ method, answer })));
    console.log(JSON.stringify(await Effect.runPromise(applied.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(BunServices.layer, BunCrypto.layerSecureRandom))))));'`),
          '{"applied":true}',
        );
        yield* machine.nudge(`send ${legacyCaller} 'hello with legacy Full access'`);
        yield* machine.waitUntilIdle(legacyCaller);
        const legacyTranscript = (yield* machine.showJson(legacyCaller)).target.transcript;
        const legacyContext = yield* machine.shell(
          `grep '"type":"turn_context"' '${legacyTranscript}' | tail -n1`,
        );
        assert.match(legacyContext, /"approval_policy":"never"/u);
        assert.match(legacyContext, /"sandbox_policy":\{"type":"danger-full-access"\}/u);
        assert.doesNotMatch(legacyContext, /"active_permission_profile"/u);

        const fullTerminal = yield* startFromTerminal("full-terminal");
        yield* expectPermissions({
          id: fullTerminal,
          tag: "full-terminal",
          isFullAccess: true,
          archive: false,
        });
        const helpers = Effect.map(
          machine.nudge("list --archived 'Nudge permissions helper'"),
          (listing) =>
            rows(listing)
              .map((row) => row[1] ?? "")
              .toSorted((left, right) => left.localeCompare(right)),
        );
        const helpersBeforeReuse = yield* helpers;
        assert.ok(helpersBeforeReuse.length > 0);
        yield* expectPermissions({
          id: yield* startFromClaude("full-claude"),
          tag: "full-claude",
          isFullAccess: true,
        });
        assert.deepEqual(yield* helpers, helpersBeforeReuse);
        yield* machine.nudge(`archive ${legacyCaller}`);
        yield* machine.nudge(`archive ${fullTerminal}`);
      }),
    );
    yield* machine.shell(`cp ${savedState} ${GLOBAL_STATE}`);
    yield* recordingCallerDecisions(machine);
  }),
);
