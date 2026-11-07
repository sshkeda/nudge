import assert from "node:assert/strict";

import { Effect, Schema } from "effect";

import { BUN } from "../../scripts/shared/codex-and-claude.ts";
import { startCodexDesktop } from "../../scripts/shared/codex-desktop.ts";
import { CODEX_MODEL_AND_EFFORT, machineTest, NUDGE, quoteForShell } from "./machine-commands.ts";

const StartedInDirectory = Schema.fromJsonString(
  Schema.Struct({
    action: Schema.Literal("new"),
    provider: Schema.Literal("codex"),
    target: Schema.Struct({ id: Schema.String, name: Schema.String, cwd: Schema.String }),
  }),
);

const PROJECT_NAME = "Nudge Test Project";

const addCodexProject = (directory: string) => `${BUN} -e '
const file = process.env.HOME + "/.codex/.codex-global-state.json";
const state = await Bun.file(file).json();
const id = crypto.randomUUID();
const now = Date.now();
state["local-projects"] = { ...state["local-projects"], [id]: { id, name: "${PROJECT_NAME}", rootPaths: [process.argv[1]], createdAt: now, updatedAt: now } };
await Bun.write(file, JSON.stringify(state));' ${quoteForShell(directory)}`;

export const startingCodexInItsProject = machineTest((machine) =>
  Effect.gen(function* () {
    yield* startCodexDesktop();
    const outside = yield* machine.attempt(
      `${NUDGE} new codex ${CODEX_MODEL_AND_EFFORT} --name 'Projectless Codex' 'hello from nudge'`,
    );
    const projectlessId = /\((?<id>[\da-f-]{36})\)/u.exec(outside.standardOutput)?.groups?.["id"];
    assert.ok(projectlessId !== undefined, outside.standardOutput);
    const projectless = (yield* machine.showJson(projectlessId)).target;
    assert.ok(projectless.cwd.startsWith(`${machine.home}/Documents/Codex/`));
    assert.deepEqual(outside, {
      code: 0,
      standardError: "",
      standardOutput: `Started Codex session "Projectless Codex" (${projectlessId}) in ~/${projectless.cwd.slice(machine.home.length + 1)}, because ~/work isn't a Codex Desktop project.`,
    });

    const project = `${machine.scratch}/project`;
    yield* machine.shell(`mkdir -p ${project}/inside`);
    yield* machine.shell(machine.quitCodex);
    yield* machine.shell(addCodexProject(project));
    yield* startCodexDesktop();

    const inProject = yield* Effect.flatMap(
      machine.shell(
        `cd ${project} && ${NUDGE} new codex --json ${CODEX_MODEL_AND_EFFORT} --name 'Project Codex' 'hello'`,
      ),
      Schema.decodeEffect(StartedInDirectory),
    );
    assert.equal(inProject.target.cwd, project);
    const shownInProject = (yield* machine.showJson(inProject.target.id)).target;
    assert.equal(shownInProject.cwd, project);

    const inside = yield* Effect.flatMap(
      machine.shell(
        `cd ${project}/inside && ${NUDGE} new codex --json ${CODEX_MODEL_AND_EFFORT} --name 'Inside Codex' 'hello'`,
      ),
      Schema.decodeEffect(StartedInDirectory),
    );
    assert.ok(inside.target.cwd.startsWith(`${machine.home}/Documents/Codex/`));

    const started = [projectlessId, inProject.target.id, inside.target.id];
    yield* machine.waitUntilIdle(...started);
    for (const id of started) {
      yield* machine.nudge(`archive ${id}`);
    }
  }),
);
