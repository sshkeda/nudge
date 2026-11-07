import assert from "node:assert/strict";

import { Task } from "@sshkeda/task";
import { Effect, Option, Schema } from "effect";

import { deliveryFinder } from "../../src/lib/codex/internal/codex-service.ts";
import { STEERED_A_TURN } from "../../src/lib/codex/internal/service-tier.ts";

const TOOL = "send_message_to_thread";

const PROMPT = "check <this> & that";

const DELIVERED_INPUT = "<input>check &lt;this&gt; &amp; that</input>";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

const toolOutputLine = (output: Schema.Json) =>
  encodeJson({
    type: "response_item",
    payload: { type: "function_call_output", name: TOOL, call_id: "call-1", output },
  });

export const readingCodexToolOutput = Task.make(
  "reading-codex-tool-output",
  Effect.gen(function* () {
    const find = deliveryFinder({
      tool: TOOL,
      callId: "reading-codex-tool-output",
      prompt: PROMPT,
    });
    assert.deepEqual(
      find(yield* toolOutputLine(`Delivered.\n${DELIVERED_INPUT}`)),
      Option.some(STEERED_A_TURN),
    );
    assert.deepEqual(
      find(
        yield* toolOutputLine([
          { type: "input_text", text: "Delivered.\n" },
          { type: "input_image", image_url: "data:image/png;base64,AAAA" },
          { type: "input_text", text: DELIVERED_INPUT },
        ]),
      ),
      Option.some(STEERED_A_TURN),
    );
    assert.deepEqual(
      find(yield* toolOutputLine([{ type: "input_text", text: "<input>another</input>" }])),
      Option.none(),
    );
  }),
);
