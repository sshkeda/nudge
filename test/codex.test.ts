import { expect } from "bun:test"
import { chmod } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"

import {
  temporaryDirectory,
  testEffect,
  runCli,
  listen,
  type BridgeRequestFixture
} from "./support.ts"

testEffect(
  "the CLI sends the resolved Codex destination and payload through the bridge",
  Effect.gen(function* () {
    const directory = yield* temporaryDirectory(join(tmpdir(), "nudge-codex-native-"))
    const index = join(directory, "session-index.jsonl")
    const bridgePath = join(directory, "bridge.sock")
    const threadId = "01a00000-0000-7000-8000-000000000099"
    yield* Effect.tryPromise(() =>
      Bun.write(index, `${JSON.stringify({ id: threadId, thread_name: "Code review" })}\n`)
    )
    let bridgeRequest: BridgeRequestFixture | undefined
    const bridge = createServer((socket) => {
      socket.setEncoding("utf8")
      socket.once("data", (body) => {
        // SAFETY: this fixture owns the only writer and asserts every field below.
        bridgeRequest = JSON.parse(String(body).trim()) as BridgeRequestFixture
        socket.end(
          `${JSON.stringify({
            version: 1,
            id: bridgeRequest.id,
            status: "delivered",
            targetThreadId: bridgeRequest.targetThreadId
          })}\n`
        )
      })
    })
    yield* listen(bridge, bridgePath)
    yield* Effect.tryPromise(() => chmod(bridgePath, 0o600))
    for (const messageArgs of [["native cold delivery"], ["-"], []]) {
      const result = yield* runCli(
        ["send", "Code review", ...messageArgs, "--json"],
        {
          NUDGE_CLAUDE_SESSIONS_DIR: join(directory, "no-claude-sessions"),
          NUDGE_CODEX_SESSION_INDEX: index,
          NUDGE_CODEX_BRIDGE_SOCKET: bridgePath,
          CODEX_THREAD_ID: "",
          CODEX_SESSION_ID: ""
        },
        "native cold delivery"
      )
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe("")
      expect(JSON.parse(result.stdout)).toEqual({
        action: "send",
        provider: "codex",
        status: "delivered",
        delivery: "native",
        target: { id: threadId, name: "Code review" }
      })
      expect(bridgeRequest).toMatchObject({
        version: 1,
        targetThreadId: threadId,
        prompt: "Message via nudge CLI:\n\nnative cold delivery"
      })
    }
  })
)
