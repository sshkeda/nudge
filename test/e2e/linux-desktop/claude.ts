import { mkdir } from "node:fs/promises"
import { join } from "node:path"

import { BunHttpClient, BunRuntime, BunServices } from "@effect/platform-bun"
import { type Cause, Effect, Fiber, Queue, Schema, Stream } from "effect"
import { HttpClient } from "effect/unstable/http"

import { command, runCommand, waitUntil } from "./commands.ts"
import { spawnScoped } from "./process.ts"

const environment = (key: string) => {
  const value = Bun.env[key]
  if (!value) throw new Error(`missing ${key}`)
  return value
}
const home = environment("HOME")
const out = environment("E2E_OUT")
const payload = environment("E2E_PAYLOAD")
const marker = environment("E2E_MARKER")
const profile = join(home, ".claude")
const workspace = join(home, "work", "claude-workspace")
const TargetList = Schema.Struct({
  targets: Schema.Array(Schema.Struct({ provider: Schema.String, id: Schema.String }))
})
const Receipt = Schema.Struct({
  provider: Schema.Literal("claude"),
  status: Schema.Literals(["sent", "delivered"]),
  target: Schema.Struct({ id: Schema.String })
})
const TranscriptEvent = Schema.Struct({
  type: Schema.String,
  message: Schema.optional(Schema.Struct({ content: Schema.Unknown }))
})
const Journal = Schema.Array(
  Schema.Struct({
    path: Schema.String,
    headers: Schema.Record(Schema.String, Schema.String),
    response: Schema.optional(
      Schema.Struct({
        fixture: Schema.optional(
          Schema.Struct({
            match: Schema.optional(Schema.Struct({ userMessage: Schema.optional(Schema.String) }))
          })
        )
      })
    )
  })
)
const write = (path: string, body: string) => Effect.tryPromise(() => Bun.write(path, body))
const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message)
}

const main = Effect.gen(function* () {
  assert(
    Bun.env["NUDGE_E2E_IMAGE"] === "1" &&
      (home === "/home/tester" ||
        (process.platform === "darwin" &&
          home === "/Users/admin" &&
          Bun.env["NUDGE_E2E_MAC_VM"] === "1")),
    "run only inside the E2E image"
  )
  assert(!Bun.env["CLAUDE_CONFIG_DIR"], "Claude must use its default profile location")
  yield* Effect.tryPromise(() => mkdir(profile, { mode: 0o700 }))
  yield* Effect.tryPromise(() => mkdir(workspace))
  const readme = yield* Effect.tryPromise(() =>
    Bun.file(join(Bun.env["E2E_REPO"] ?? "/repo", "README.md")).text()
  )
  const settings = readme.split("## Install")[1]?.split("```json\n")[1]?.split("```")[0] ?? ""
  Schema.decodeUnknownSync(Schema.Struct({ crossSessionInbound: Schema.Literal("accept") }))(
    JSON.parse(settings)
  )
  yield* write(join(profile, "settings.json"), settings)
  yield* write(
    join(home, ".claude.json"),
    JSON.stringify({
      hasCompletedOnboarding: true,
      theme: "dark",
      projects: {
        [workspace]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true }
      }
    })
  )
  const version = (yield* runCommand(command(["claude", "--version"]))).trim()
  const writer = yield* Effect.acquireRelease(
    Effect.sync(() => Bun.file(join(out, "claude-terminal.log")).writer()),
    (sink) => Effect.promise(async () => sink.end())
  )
  const chunks = yield* Effect.acquireRelease(
    Queue.unbounded<Uint8Array, Cause.Done>(),
    Queue.shutdown
  )
  const writes = yield* Stream.fromQueue(chunks).pipe(
    Stream.runForEach((data) => Effect.tryPromise(async () => writer.write(data))),
    Effect.forkScoped
  )
  yield* Effect.addFinalizer(() =>
    Queue.end(chunks).pipe(Effect.andThen(Fiber.join(writes)), Effect.orDie)
  )
  const session = yield* spawnScoped(() =>
    Bun.spawn(["claude", "--model", "claude-sonnet-4-5"], {
      cwd: workspace,
      env: Bun.env,
      terminal: {
        cols: 120,
        rows: 40,
        data: (_terminal, data) => {
          Queue.offerUnsafe(chunks, data)
        }
      }
    })
  )
  yield* Effect.addFinalizer(() => Effect.sync(() => session.terminal?.close()))
  yield* Effect.gen(function* () {
    const target = yield* waitUntil(
      "Claude inbox discovery",
      runCommand(command(["nudge", "list", "--json"])).pipe(
        Effect.map((body) => {
          const targets = Schema.decodeUnknownSync(TargetList)(JSON.parse(body)).targets.filter(
            (row) => row.provider === "claude"
          )
          assert(targets.length <= 1, "found an unexpected Claude session")
          return targets[0] ?? null
        })
      ),
      60_000
    )
    const source = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(
      JSON.parse(yield* Effect.tryPromise(() => Bun.file(join(out, "source.json")).text()))
    )
    const sent = yield* runCommand(
      command(["nudge", "send", target.id, payload, "--json"], {
        env: { ...Bun.env, CODEX_THREAD_ID: source.id }
      })
    )
    const receipt = Schema.decodeUnknownSync(Receipt)(JSON.parse(sent))
    assert(receipt.target.id === target.id, "send confirmed the wrong Claude session")
    yield* write(join(out, "claude-send.json"), sent)
    const transcript = yield* waitUntil(
      "Claude transcript and response",
      Stream.fromAsyncIterable(
        new Bun.Glob(`*/${target.id}.jsonl`).scan({
          cwd: join(profile, "projects"),
          absolute: true
        }),
        (cause) => cause
      ).pipe(
        Stream.runCollect,
        Effect.flatMap((paths) =>
          Effect.forEach(paths, (path) => Effect.tryPromise(() => Bun.file(path).text()))
        ),
        Effect.map(
          (bodies) => bodies.find((body) => body.includes(payload) && body.includes(marker)) ?? null
        )
      ),
      60_000
    )
    yield* write(join(out, "claude-transcript.jsonl"), transcript)
    const events = transcript
      .trim()
      .split("\n")
      .map((line) => Schema.decodeUnknownSync(TranscriptEvent)(JSON.parse(line)))
    const carries = (type: string, text: string) =>
      events.filter(
        (event) => event.type === type && JSON.stringify(event.message?.content).includes(text)
      )
    assert(
      carries("user", payload).length === 1,
      "expected exactly one received Claude user message"
    )
    const received = JSON.stringify(carries("user", payload)[0]?.message?.content)
    assert(
      received.includes("<cross-session-message>"),
      "expected an attribute-free Claude wrapper"
    )
    assert(
      !received.includes("from-session=") && !received.includes("from-name="),
      "Codex sender was presented as a Claude peer"
    )
    assert(
      received.includes("Message from Codex task") &&
        received.includes(`(${source.id}) via nudge CLI:`),
      "missing Codex reply identity and CLI channel"
    )
    yield* write(join(out, "claude-envelope.json"), received)
    assert(
      carries("assistant", marker).length === 1,
      "expected exactly one Claude response to the message"
    )
    const client = HttpClient.withScope(yield* HttpClient.HttpClient)
    const journal = yield* client
      .get(`http://127.0.0.1:${environment("E2E_AIMOCK_PORT")}/__aimock/journal`)
      .pipe(
        Effect.flatMap((response) => response.json),
        Effect.map(Schema.decodeUnknownSync(Journal))
      )
    const matching = journal.filter(
      (entry) => entry.response?.fixture?.match?.userMessage === payload
    )
    assert(
      matching.some((entry) => entry.path.startsWith("/v1/messages")),
      "payload did not reach the Anthropic Messages API"
    )
    assert(
      journal.every(
        (entry) => entry.headers["host"] === `127.0.0.1:${environment("E2E_AIMOCK_PORT")}`
      ),
      "model request used an unexpected host"
    )
    console.log(
      `Claude E2E passed: ${version}; README settings -> nudge list -> nudge send -> real inbox -> transcript and local model response`
    )
  }).pipe(
    Effect.raceFirst(Fiber.join(writes)),
    Effect.raceFirst(
      Effect.promise(() => session.exited).pipe(
        Effect.flatMap((code) =>
          Effect.fail(
            new Error(`Claude exited before delivery completed: ${code}; see claude-terminal.log`)
          )
        )
      )
    )
  )
})

BunRuntime.runMain(
  main.pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.provide(BunHttpClient.layer))
)
