import assert from "node:assert/strict";

import { Effect } from "effect";

import { BUN } from "../../scripts/shared/codex-and-claude.ts";
import { machineTest, quoteForShell } from "./machine-commands.ts";

const askTheHelper = ({ socket, request }: { readonly socket: string; readonly request: string }) =>
  `${BUN} -e '
const client = require("node:net").connect(process.argv[1]);
let reply = "";
client.on("connect", () => client.write(process.argv[2] + "\\n"));
client.on("data", (chunk) => { reply += chunk; });
client.on("end", () => console.log(reply.trim()));' ${socket} ${quoteForShell(request)}`;

const toolCall = ({ namespace, tool }: { readonly namespace: string; readonly tool: string }) =>
  `{"method":"tools/call","params":{"tool":"${tool}","namespace":"${namespace}","threadId":"00000000-0000-4000-8000-000000000000","turnId":"nudge-limit","callId":"nudge-limit","callerSource":"codex","arguments":{}}}`;

const FORWARDED =
  "list_projects, create_thread, send_message_to_thread, set_thread_title, set_thread_archived";

const refusal = (message: string) => `{"error":{"message":"${message}"}}`;

export const limitingTheCodexHelper = machineTest((machine) =>
  Effect.gen(function* () {
    const replies = yield* Effect.forEach(
      [
        `{"method":"thread/start","params":{}}`,
        toolCall({ namespace: "codex_app", tool: "nudge_no_such_tool" }),
        toolCall({ namespace: "nudge_no_such_namespace", tool: "create_thread" }),
      ],
      (request) => machine.shell(askTheHelper({ socket: machine.bridgeSocket, request })),
    );
    assert.deepEqual(replies, [
      refusal("the Codex helper forwards only tools/call requests, not thread/start"),
      refusal(
        `the Codex helper doesn't forward Codex's nudge_no_such_tool tool, only ${FORWARDED}`,
      ),
      refusal("the Codex helper forwards only codex_app tools, not nudge_no_such_namespace tools"),
    ]);
  }),
);
