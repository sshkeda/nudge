import assert from "node:assert/strict";

import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Option } from "effect";

import { readClaudeModelChoice } from "../../src/lib/claude/internal/claude-model-choice.ts";
import { readLatestChoice, readLatestModel } from "../../src/lib/codex/internal/service-tier.ts";

const claudeRequest = ({
  effort,
  speed,
  id = "",
}: {
  readonly effort: string;
  readonly speed: string;
  readonly id?: string;
}) => `{"type":"api-request"${id},"params":{"model":"claude-opus-5-5"${speed}${effort}}}`;

const EFFORT_MEDIUM = ',"output_config":{"effort":"medium"}';

const EFFORT_HIGH = ',"output_config":{"effort":"high"}';

const ASKED_FAST = ',"speed":"fast"';

const claudeReply = ({
  model,
  speed,
  fields = "",
}: {
  readonly model: string;
  readonly speed: string;
  readonly fields?: string;
}) =>
  `{"type":"assistant"${fields},"message":{"model":"${model}","content":[{"text":"hi"}],"usage":{${speed}}}}`;

const EFFORT_LOW = ',"output_config":{"effort":"low"}';

const FIRST_REQUEST_ID = ',"id":"request-1"';

const SECOND_REQUEST_ID = ',"id":"request-2"';

const ANSWERS_FIRST_REQUEST = ',"requestRef":"request-1"';

const ANSWERS_MISSING_REQUEST = ',"requestRef":"request-9"';

const RAN_AT_MAX_EFFORT = ',"effort":"max"';

const RAN_STANDARD = '"speed":"standard"';

const RAN_FAST = '"speed":"fast"';

const SYNTHETIC_REPLY =
  '{"type":"assistant","isApiErrorMessage":false,"message":{"model":"<synthetic>","content":[{"text":"No response requested."}]}}';

const TOOL_RESULT_NAMING_A_REQUEST = String.raw`{"type":"user","message":{"content":"\"type\":\"api-request\" and \"type\":\"assistant\""}}`;

const choices = ({
  model,
  effort,
  speed,
}: {
  readonly model?: string;
  readonly effort?: string;
  readonly speed?: string;
}) => ({
  model: Option.fromNullishOr(model),
  effort: Option.fromNullishOr(effort),
  speed: Option.fromNullishOr(speed),
});

const FAILED_REPLY =
  '{"type":"assistant","isApiErrorMessage":true,"message":{"model":"<synthetic>","content":[{"text":"API Error"}]}}';

const CLAUDE_TRANSCRIPTS = [
  {
    lines: [
      claudeRequest({ effort: EFFORT_MEDIUM, speed: "" }),
      claudeReply({ model: "claude-opus-5-5", speed: RAN_STANDARD }),
    ],
    shown: choices({ model: "claude-opus-5-5", effort: "medium", speed: "Standard" }),
  },
  {
    lines: [
      claudeRequest({ effort: EFFORT_HIGH, speed: ASKED_FAST }),
      claudeReply({ model: "claude-opus-5-5", speed: "" }),
    ],
    shown: choices({ model: "claude-opus-5-5", effort: "high" }),
  },
  {
    lines: [
      claudeRequest({ effort: EFFORT_MEDIUM, speed: ASKED_FAST }),
      claudeReply({ model: "claude-opus-5-5", speed: RAN_FAST }),
      claudeRequest({ effort: EFFORT_HIGH, speed: "" }),
      claudeReply({ model: "claude-sonnet-5-5", speed: RAN_STANDARD }),
      SYNTHETIC_REPLY,
      TOOL_RESULT_NAMING_A_REQUEST,
    ],
    shown: choices({ model: "claude-sonnet-5-5", effort: "high", speed: "Standard" }),
  },
  {
    lines: [
      claudeRequest({ effort: EFFORT_MEDIUM, speed: "" }),
      claudeReply({ model: "claude-opus-5-5", speed: RAN_STANDARD }),
      claudeRequest({ effort: EFFORT_HIGH, speed: ASKED_FAST }),
      FAILED_REPLY,
    ],
    shown: choices({ model: "claude-opus-5-5", effort: "medium", speed: "Standard" }),
  },
  {
    lines: [
      claudeRequest({ effort: EFFORT_HIGH, speed: ASKED_FAST }),
      claudeReply({ model: "claude-opus-5-5", speed: "" }),
      claudeRequest({ effort: EFFORT_MEDIUM, speed: "" }),
    ],
    shown: choices({ model: "claude-opus-5-5", effort: "high" }),
  },
  {
    lines: [
      claudeRequest({ effort: "", speed: "" }),
      claudeReply({ model: "claude-opus-5-5", speed: "" }),
    ],
    shown: choices({ model: "claude-opus-5-5" }),
  },
  {
    lines: [
      claudeRequest({ effort: EFFORT_HIGH, speed: ASKED_FAST }),
      claudeReply({ model: "claude-opus-5-5", speed: RAN_STANDARD }),
    ],
    shown: choices({ model: "claude-opus-5-5", effort: "high", speed: "Standard" }),
  },
  {
    lines: [
      claudeRequest({ effort: EFFORT_HIGH, speed: ASKED_FAST, id: FIRST_REQUEST_ID }),
      claudeRequest({ effort: EFFORT_LOW, speed: "", id: SECOND_REQUEST_ID }),
      claudeReply({ model: "claude-opus-5-5", speed: RAN_FAST, fields: ANSWERS_FIRST_REQUEST }),
    ],
    shown: choices({ model: "claude-opus-5-5", effort: "high", speed: "Fast" }),
  },
  {
    lines: [
      claudeRequest({ effort: EFFORT_LOW, speed: "", id: FIRST_REQUEST_ID }),
      claudeReply({ model: "claude-opus-5-5", speed: "", fields: ANSWERS_MISSING_REQUEST }),
    ],
    shown: choices({ model: "claude-opus-5-5" }),
  },
  {
    lines: [
      claudeRequest({ effort: EFFORT_MEDIUM, speed: "" }),
      claudeReply({
        model: "claude-opus-5-5",
        speed: RAN_STANDARD,
        fields: `${ANSWERS_MISSING_REQUEST}${RAN_AT_MAX_EFFORT}`,
      }),
    ],
    shown: choices({ model: "claude-opus-5-5", effort: "max", speed: "Standard" }),
  },
  {
    lines: [claudeReply({ model: "claude-opus-5-5", speed: "" })],
    shown: choices({ model: "claude-opus-5-5" }),
  },
  {
    lines: [claudeReply({ model: "claude-opus-5-5", speed: RAN_FAST })],
    shown: choices({ model: "claude-opus-5-5", speed: "Fast" }),
  },
  { lines: [claudeRequest({ effort: EFFORT_MEDIUM, speed: "" })], shown: choices({}) },
  { lines: [], shown: choices({}) },
] as const;

const codexApplied = (appliedFields: string) =>
  `{"type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{${appliedFields}}}}`;

const CODEX_ROLLOUTS = [
  {
    lines: [
      codexApplied('"model":"gpt-6-astra","service_tier":"default","reasoning_effort":"medium"'),
    ],
    shown: choices({ model: "gpt-6-astra", effort: "medium", speed: "Standard" }),
  },
  {
    lines: [
      codexApplied('"model":"gpt-6-astra","service_tier":"priority","reasoning_effort":"low"'),
      '{"type":"turn_context","payload":{"model":"gpt-5.5","effort":"xhigh"}}',
      codexApplied('"model":"gpt-6.1-sol","service_tier":null,"reasoning_effort":"high"'),
    ],
    shown: choices({ model: "gpt-6.1-sol", effort: "high", speed: "Standard" }),
  },
  {
    lines: [
      codexApplied('"model":"gpt-old","service_tier":"priority","reasoning_effort":"low"'),
      codexApplied('"model":"gpt-new"'),
    ],
    shown: choices({ model: "gpt-new", speed: "Standard" }),
  },
  {
    lines: [
      codexApplied('"model":"gpt-6-astra","service_tier":"priority","reasoning_effort":"low"'),
      codexApplied('"model":null,"service_tier":"priority","reasoning_effort":null'),
    ],
    shown: choices({ speed: "Fast" }),
  },
  { lines: [], shown: choices({}) },
] as const;

export const readingModelChoices = Task.make(
  "reading-model-choices",
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ directory: "/tmp" });
      const writeFixture = (name: string, lines: readonly string[]) =>
        Effect.as(
          fileSystem.writeFileString(
            `${directory}/${name}.jsonl`,
            lines.map((line) => `${line}\n`).join(""),
          ),
          `${directory}/${name}.jsonl`,
        );
      const claudeShown = yield* Effect.forEach(CLAUDE_TRANSCRIPTS, ({ lines }, index) =>
        Effect.flatMap(writeFixture(`claude-${String(index)}`, lines), (path) =>
          readClaudeModelChoice(Option.some(path)),
        ),
      );
      assert.deepEqual(
        claudeShown,
        CLAUDE_TRANSCRIPTS.map(({ shown }) => shown),
      );
      assert.deepEqual(yield* readClaudeModelChoice(Option.none()), choices({}));
      assert.deepEqual(
        yield* readClaudeModelChoice(Option.some(`${directory}/missing.jsonl`)),
        choices({}),
      );
      const codexShown = yield* Effect.forEach(CODEX_ROLLOUTS, ({ lines }, index) =>
        Effect.flatMap(writeFixture(`codex-${String(index)}`, lines), (path) =>
          readLatestChoice(path),
        ),
      );
      assert.deepEqual(
        codexShown,
        CODEX_ROLLOUTS.map(({ shown }) => shown),
      );
      const codexModels = yield* Effect.forEach(CODEX_ROLLOUTS, ({ lines }, index) =>
        Effect.flatMap(writeFixture(`codex-model-${String(index)}`, lines), (path) =>
          readLatestModel(path),
        ),
      );
      assert.deepEqual(
        codexModels,
        CODEX_ROLLOUTS.map(({ shown }) => shown.model),
      );
    }),
  ),
);
