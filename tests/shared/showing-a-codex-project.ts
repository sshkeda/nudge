import assert from "node:assert/strict";

import { Effect, Schema } from "effect";

import { BUN } from "../../scripts/shared/codex-and-claude.ts";
import { startCodexDesktop } from "../../scripts/shared/codex-desktop.ts";
import { machineTest, NUDGE, quoteForShell, rows } from "./machine-commands.ts";

const PROJECT_NAME = "Nudge Test Project";

const PROJECT_COLUMN = 5;

const ShownProject = Schema.fromJsonString(
  Schema.Struct({ target: Schema.Struct({ project: Schema.String }) }),
);

const ListedProjects = Schema.fromJsonString(
  Schema.Struct({
    targets: Schema.Array(Schema.Struct({ id: Schema.String, project: Schema.String })),
  }),
);

const assignToCodexProject = ({
  threadId,
  directory,
}: {
  readonly threadId: string;
  readonly directory: string;
}) => `${BUN} -e '
const file = process.env.HOME + "/.codex/.codex-global-state.json";
const state = await Bun.file(file).json();
const id = crypto.randomUUID();
const now = Date.now();
state["local-projects"] = { ...state["local-projects"], [id]: { id, name: "${PROJECT_NAME}", rootPaths: [process.argv[1]], createdAt: now, updatedAt: now } };
state["thread-project-assignments"] = { ...state["thread-project-assignments"], [process.argv[2]]: { projectKind: "local", projectId: id } };
state["projectless-thread-ids"] = (state["projectless-thread-ids"] ?? []).filter((threadId) => threadId !== process.argv[2]);
await Bun.write(file, JSON.stringify(state));' ${quoteForShell(directory)} ${quoteForShell(threadId)}`;

export const showingACodexProject = machineTest((machine) =>
  Effect.gen(function* () {
    yield* startCodexDesktop();
    const id = yield* machine.start("codex 'hello from nudge' --name 'Project Codex'");
    yield* machine.waitUntilIdle(id);
    const project = `${machine.scratch}/project`;
    yield* machine.shell(`mkdir -p ${project}`);
    yield* startCodexDesktop({
      beforeStart: assignToCodexProject({ threadId: id, directory: project }),
    });

    const [shownText = "", shownJson = "", listedText = "", listedJson = ""] =
      yield* machine.shells([
        `${NUDGE} show ${id}`,
        `${NUDGE} show --json ${id}`,
        `${NUDGE} list`,
        `${NUDGE} list --json`,
      ]);
    assert.match(shownText, new RegExp(`^Project: +${PROJECT_NAME}$`, "mu"));
    assert.equal(
      (yield* Schema.decodeEffect(ShownProject)(shownJson)).target.project,
      PROJECT_NAME,
    );
    assert.equal(rows(listedText).find((row) => row[1] === id)?.[PROJECT_COLUMN], PROJECT_NAME);
    assert.equal(
      (yield* Schema.decodeEffect(ListedProjects)(listedJson)).targets.find(
        (target) => target.id === id,
      )?.project,
      PROJECT_NAME,
    );

    yield* machine.nudge(`archive ${id}`);
  }),
);
