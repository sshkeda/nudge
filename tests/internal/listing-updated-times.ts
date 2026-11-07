import assert from "node:assert/strict";

import { Task } from "@sshkeda/task";
import { Effect } from "effect";

import { updatedAgo } from "../../src/internal/updated-ago.ts";

const NOW = Date.parse("2026-10-24T12:00:00.000Z");

const CASES = [
  { elapsed: 0, expected: "0s ago" },
  { elapsed: 999, expected: "0s ago" },
  { elapsed: 1000, expected: "1s ago" },
  { elapsed: 12_000, expected: "12s ago" },
  { elapsed: 59_999, expected: "59s ago" },
  { elapsed: 60_000, expected: "1m ago" },
  { elapsed: 240_000, expected: "4m ago" },
  { elapsed: 3_599_999, expected: "59m ago" },
  { elapsed: 3_600_000, expected: "1h ago" },
  { elapsed: 7_200_000, expected: "2h ago" },
  { elapsed: 86_399_999, expected: "23h ago" },
  { elapsed: 86_400_000, expected: "1d ago" },
  { elapsed: 259_200_000, expected: "3d ago" },
  { elapsed: -1, expected: "in future" },
  { elapsed: "", expected: "unknown" },
  { elapsed: "invalid", expected: "unknown" },
] as const;

export const listingUpdatedTimes = Task.make(
  "listing-updated-times",
  Effect.sync(() => {
    for (const { elapsed, expected } of CASES) {
      const lastActiveAt =
        typeof elapsed === "number" ? new Date(NOW - elapsed).toISOString() : elapsed;
      assert.equal(updatedAgo(lastActiveAt, NOW), expected);
    }
  }),
);
