import assert from "node:assert/strict";

import { Effect } from "effect";

import { thisMachine } from "../../scripts/lib/platform/index.ts";
import { FAILED_EXIT_CODE, jsonLine, machineTest, NUDGE } from "./machine-commands.ts";

const LIMIT_GROWTH = 2;

const withNoWatchesLeft = (line: string) =>
  `unshare --user --map-root-user sh -c 'echo 0 > /proc/sys/user/max_inotify_watches && exec ${line}'`;

export const reachingTheWatchLimit = machineTest((machine) =>
  Effect.gen(function* () {
    yield* (yield* thisMachine).runWatchLimit(
      Effect.gen(function* () {
        const claudeId = yield* machine.start(
          "claude 'hello from nudge' --name 'Watch Limit Claude'",
        );
        yield* machine.waitUntilIdle(claudeId);
        const limit = Number(yield* machine.shell("cat /proc/sys/fs/inotify/max_user_watches"));
        const message = `nudge can't watch ~/.claude/sessions because your user reached the inotify watch limit, fs.inotify.max_user_watches = ${limit}`;
        const hint = `sudo sysctl fs.inotify.max_user_watches=${limit * LIMIT_GROWTH}`;
        assert.deepEqual(
          yield* machine.attempt(
            withNoWatchesLeft(`${NUDGE} rename ${claudeId} "Watch Limit One"`),
          ),
          {
            code: FAILED_EXIT_CODE,
            standardOutput: "",
            standardError: `error: ${message}\nhint: ${hint}`,
          },
        );
        assert.deepEqual(
          yield* machine.attempt(
            withNoWatchesLeft(`${NUDGE} rename --json ${claudeId} "Watch Limit Two"`),
          ),
          {
            code: FAILED_EXIT_CODE,
            standardOutput: "",
            standardError: yield* jsonLine({ error: "InotifyWatchLimitReached", message, hint }),
          },
        );
        yield* machine.nudge(`archive ${claudeId}`);
      }),
    );
  }),
);
