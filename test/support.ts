import { Database } from "bun:sqlite"
import { onTestFinished, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { type Scope, Effect } from "effect"

import { spawnScoped } from "./e2e/linux-desktop/process.ts"

export { spawnScoped } from "./e2e/linux-desktop/process.ts"

export const mainPath = join(import.meta.dir, "../src/main.ts")

const profileDirectory = join(tmpdir(), `nudge-unused-profile-${crypto.randomUUID()}`)
const excludedEnvironment = new Set([
  "CODEX_HOME",
  "CODEX_THREAD_ID",
  "CODEX_SESSION_ID",
  "CODEX_APP_TOOLS_PIPE_PATH",
  "CODEX_ELECTRON_RESOURCES_PATH",
  "CODEX_NUDGE_BRIDGE_CHILD",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  "NODE_OPTIONS",
  "BUN_OPTIONS"
])

export const environment = {
  ...Object.fromEntries(
    Object.entries(Bun.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !excludedEnvironment.has(entry[0]) &&
        (!entry[0].startsWith("NUDGE_") || entry[0].startsWith("NUDGE_TEST_"))
    )
  ),
  CODEX_HOME: join(profileDirectory, "codex"),
  CLAUDE_CONFIG_DIR: join(profileDirectory, "claude"),
  NUDGE_CLAUDE_DESKTOP_DIR: join(profileDirectory, "claude-desktop"),
  NUDGE_STATE_DIR: join(profileDirectory, "state")
}

export function testEffect<A, E>(
  name: string,
  effect: Effect.Effect<A, E, Scope.Scope>,
  timeout = 5000
) {
  test.serial(
    name,
    () => {
      const controller = new AbortController()
      const running = Effect.runPromise(Effect.scoped(effect), {
        signal: controller.signal
      }).catch((error) => {
        if (!controller.signal.aborted) throw error
      })
      onTestFinished(() => {
        controller.abort()
        return running.then(
          () => undefined,
          () => undefined
        )
      })
      return running
    },
    timeout
  )
}

export const temporaryDirectory = (prefix: string) =>
  Effect.acquireRelease(
    Effect.tryPromise(() => mkdtemp(prefix)),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true }))
  )

export const openDatabase = (...args: ConstructorParameters<typeof Database>) =>
  Effect.acquireRelease(
    Effect.sync(() => new Database(...args)),
    (database) => Effect.sync(() => database.close())
  )

export const runCli = Effect.fn("runCli")(function* (
  arguments_: readonly string[],
  overrides: Readonly<Record<string, string | undefined>>,
  input?: string
) {
  const index = overrides["NUDGE_CODEX_SESSION_INDEX"]
  if (
    index &&
    !overrides["NUDGE_CODEX_STATE_DB"] &&
    (yield* Effect.tryPromise(() => Bun.file(index).exists()))
  ) {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const database = yield* openDatabase(join(dirname(index), "state_5.sqlite"))
        database.run(
          "CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, archived INTEGER, recency_at INTEGER, updated_at INTEGER, model TEXT, reasoning_effort TEXT, cwd TEXT)"
        )
        database.run("DELETE FROM threads")
        for (const line of (yield* Effect.tryPromise(() => Bun.file(index).text())).split("\n")) {
          if (!line.trim()) continue
          const row = JSON.parse(line)
          database.run(
            "INSERT OR REPLACE INTO threads VALUES (?, 0, 1, 1, NULL, NULL, '/fixture')",
            [row.id]
          )
        }
      })
    )
  }
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawnScoped(() =>
        Bun.spawn([process.execPath, mainPath, ...arguments_], {
          env: { ...environment, ...overrides },
          stdin: input === undefined ? "ignore" : new Blob([input]),
          stdout: "pipe",
          stderr: "pipe"
        })
      )
      const [exitCode, stdout, stderr] = yield* Effect.all(
        [
          Effect.promise(() => child.exited),
          Effect.tryPromise(() => Bun.readableStreamToText(child.stdout)),
          Effect.tryPromise(() => Bun.readableStreamToText(child.stderr))
        ],
        { concurrency: "unbounded" }
      )
      return { exitCode, stdout, stderr }
    })
  )
})

export type BridgeRequestFixture = {
  readonly id: string
  readonly targetThreadId: string
  readonly sourceThreadId?: string
  readonly prompt: string
  readonly version: number
}

export const serveScoped = <
  T extends {
    stop(closeActiveConnections: boolean): Promise<void> | void
  }
>(
  open: () => T
) =>
  Effect.acquireRelease(Effect.sync(open), (server) =>
    Effect.promise(() => Promise.resolve(server.stop(true)))
  )

export const listen = (server: Server, socketPath: string) =>
  Effect.gen(function* () {
    const sockets = new Set<Socket>()
    const track = (socket: Socket) => {
      sockets.add(socket)
      socket.once("close", () => sockets.delete(socket))
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => server.on("connection", track)),
      () => {
        for (const socket of sockets) socket.destroy()
        server.off("connection", track)
        return close(server).pipe(Effect.orDie)
      }
    )
    yield* Effect.callback<void, Error>((resume) => {
      const failed = (error: Error) => resume(Effect.fail(error))
      server.once("error", failed)
      server.listen(socketPath, () => {
        server.off("error", failed)
        resume(Effect.void)
      })
      return Effect.sync(() => server.off("error", failed))
    })
  })

export const close = (server: Server) =>
  Effect.callback<void, Error>((resume) => {
    if (!server.listening) return resume(Effect.void)
    server.close((cause) => resume(cause === undefined ? Effect.void : Effect.fail(cause)))
  })
