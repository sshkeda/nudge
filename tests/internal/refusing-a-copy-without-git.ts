import assert from "node:assert/strict";

import { Task } from "@sshkeda/task";
import { Effect, FileSystem } from "effect";

import { BUN, PROJECT } from "../../scripts/shared/codex-and-claude.ts";
import { runShell } from "../../scripts/shared/run-shell.ts";

const PROBE_FILE = "probe-the-checkout.ts";

const PROBE = `import { Task } from "@sshkeda/task";
import { Effect } from "effect";
import { requireGitCheckout } from "./scripts/shared/codex-and-claude.ts";
const probe = Task.make("probe", requireGitCheckout.pipe(
  Effect.match({ onFailure: (error) => error.message, onSuccess: () => "passed" }),
  Effect.flatMap((line) => Effect.sync(() => console.log(line))),
));
if (import.meta.main) { Task.main(probe); }
`;

export const refusingACopyWithoutGit = Task.make(
  "refusing-a-copy-without-git",
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const copy = yield* fileSystem.makeTempDirectoryScoped({ directory: "/tmp" });
      yield* fileSystem.writeFileString(`${copy}/${PROBE_FILE}`, PROBE);
      const output =
        yield* runShell(`cd '${PROJECT}' && git ls-files -z -c -o --exclude-standard | xargs -0 tar -cf - | tar -xf - -C '${copy}'
ln -s '${PROJECT}node_modules' '${copy}/node_modules'
cd '${copy}' && '${BUN}' ${PROBE_FILE}`);
      const directory = (yield* runShell(`cd '${copy}' && pwd -P`)).trim();
      assert.equal(
        output.trim(),
        `${directory}/ isn't a git checkout, so nudge's checks can't list its files\nhint: Send the repo to this machine with its .git folder`,
      );
    }),
  ),
  { timeout: "1 minute", cleanup: "1 minute" },
);
