import assert from "node:assert/strict";

import { Task } from "@sshkeda/task";
import { Effect, Option } from "effect";

import { replySpeedOf } from "../../src/lib/claude/internal/claude-transcript.ts";

const replyWithSpeed = (speed: string | null | undefined) => ({
  type: "assistant" as const,
  message: { content: [], usage: { speed } },
});

const JUDGED = [
  { speed: "fast", observed: Option.some("fast") },
  { speed: "standard", observed: Option.some("standard") },
  { speed: undefined, observed: Option.none() },
  { speed: null, observed: Option.none() },
  { speed: "turbo", observed: Option.none() },
] as const;

export const judgingClaudeReplySpeed = Task.make(
  "judging-claude-reply-speed",
  Effect.sync(() => {
    assert.deepEqual(
      JUDGED.map(({ speed }) => ({ speed, observed: replySpeedOf(replyWithSpeed(speed)) })),
      JUDGED,
    );
    assert.deepEqual(
      replySpeedOf({ type: "assistant", message: { content: [], usage: null } }),
      Option.none(),
    );
    assert.deepEqual(replySpeedOf({ type: "assistant", message: { content: [] } }), Option.none());
  }),
);
