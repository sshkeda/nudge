import assert from "node:assert/strict";

import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Option } from "effect";

import { readLatestModel, readLatestTier } from "../../src/lib/codex/internal/service-tier.ts";

const CHUNK_BYTES = 262_144;

const EURO_COUNT = 100;

const BYTES_INTO_THE_EURO = 1;

const NEWLINES_IN_SPANNING_FILE = 2;

const SHORT_FILLER = 10;

const LONGER_FILLER = 20;

const SPLIT_MODEL = `gpt-${"€".repeat(EURO_COUNT)}`;

const appliedRecord = ({ model, tier }: { readonly model: string; readonly tier: string }) =>
  `{"type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{"model":"${model}","service_tier":"${tier}"}}}`;

const fillerRecord = (length: number) =>
  `{"type":"event_msg","payload":{"type":"filler","text":"${"x".repeat(length)}"}}`;

const FILLER_FRAME_BYTES = fillerRecord(0).length;

const SPLIT_RECORD = appliedRecord({ model: SPLIT_MODEL, tier: "priority" });

const FIRST_EURO_BYTE = Buffer.byteLength(SPLIT_RECORD.slice(0, SPLIT_RECORD.indexOf("€")));

const SPLIT_RECORD_BYTES = Buffer.byteLength(SPLIT_RECORD);

const SPLIT_FILLER = fillerRecord(
  CHUNK_BYTES +
    FIRST_EURO_BYTE +
    BYTES_INTO_THE_EURO -
    SPLIT_RECORD_BYTES -
    NEWLINES_IN_SPANNING_FILE -
    FILLER_FRAME_BYTES,
);

const SPANNING_FILE = `${SPLIT_RECORD}\n${SPLIT_FILLER}\n`;

const STANDARD_RECORD = appliedRecord({ model: "gpt-standard", tier: "default" });

const FAST_RECORD = appliedRecord({ model: "gpt-fast", tier: "priority" });

const latestOf = (rollout: string) =>
  Effect.all({ tier: readLatestTier(rollout), model: readLatestModel(rollout) });

export const readingTheLatestCodexSpeed = Task.make(
  "reading-the-latest-codex-speed",
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      const rollout = `${directory}/rollout.jsonl`;

      const chunkStart = Buffer.byteLength(SPANNING_FILE) - CHUNK_BYTES;
      assert.equal(chunkStart, FIRST_EURO_BYTE + BYTES_INTO_THE_EURO);
      yield* fileSystem.writeFileString(rollout, SPANNING_FILE);
      assert.deepEqual(yield* latestOf(rollout), {
        tier: Option.some("priority"),
        model: Option.some(SPLIT_MODEL),
      });

      yield* fileSystem.writeFileString(rollout, `${STANDARD_RECORD}\n${FAST_RECORD}`);
      assert.deepEqual(yield* latestOf(rollout), {
        tier: Option.some("default"),
        model: Option.some("gpt-standard"),
      });
      yield* fileSystem.writeFileString(rollout, "\n", { flag: "a" });
      assert.deepEqual(yield* latestOf(rollout), {
        tier: Option.some("priority"),
        model: Option.some("gpt-fast"),
      });

      yield* fileSystem.writeFileString(
        rollout,
        `${fillerRecord(SHORT_FILLER)}\n${fillerRecord(LONGER_FILLER)}\n`,
      );
      assert.deepEqual(yield* latestOf(rollout), { tier: Option.none(), model: Option.none() });

      assert.deepEqual(yield* latestOf(`${directory}/missing.jsonl`), {
        tier: Option.none(),
        model: Option.none(),
      });
    }),
  ),
);
