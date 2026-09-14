/* eslint-disable anti-slop/no-shape-in-symbol-names -- response_shape is Claude's API field. */
import { expect } from "bun:test"
import { chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { BunHttpClient, BunServices } from "@effect/platform-bun"
import { Effect, Deferred, Fiber } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

import { readClaudeTitles as loadTitles, readStoredAccessToken } from "../src/claude/titles.ts"
import { serveScoped, temporaryDirectory, testEffect } from "./support.ts"

const readTitlesEffect = (
  ids: readonly string[],
  dependencies: {
    readAccessToken: () => Effect.Effect<string, Error>
    request: (url: URL, init: RequestInit) => Effect.Effect<Response, unknown>
  }
) =>
  loadTitles(ids, { readAccessToken: dependencies.readAccessToken }).pipe(
    Effect.provide(BunHttpClient.layer),
    Effect.provide(BunServices.layer),
    Effect.provideService(
      FetchHttpClient.Fetch,
      Object.assign(
        (input: string | URL | Request, init?: RequestInit) =>
          Effect.runPromise(dependencies.request(new URL(String(input)), init ?? {}), {
            signal: init?.signal ?? undefined
          }),
        { preconnect: fetch.preconnect }
      )
    )
  )

const readClaudeTitles = (...args: Parameters<typeof readTitlesEffect>) => readTitlesEffect(...args)

testEffect(
  "remote titles use exact session lookups, deduplicate IDs, and refresh each call",
  Effect.gen(function* () {
    const calls: string[] = []
    let title = "Code review"
    const dependencies = {
      readAccessToken: () => Effect.succeed("test-token"),
      request: (url: URL, init: RequestInit) =>
        Effect.sync(() => {
          calls.push(url.href)
          expect(init.headers).toMatchObject({ authorization: "Bearer test-token" })
          expect(init.redirect).toBe("error")
          expect(init.signal).toBeInstanceOf(AbortSignal)
          const id = url.pathname.split("/").at(-1)!
          return Response.json({ response_shape: { id, title } })
        })
    }
    const result = yield* readClaudeTitles(["session_abc", "session_abc", "cse_def"], dependencies)
    expect([...result]).toEqual([
      ["session_abc", "Code review"],
      ["cse_def", "Code review"]
    ])
    expect(calls).toEqual([
      "https://api.anthropic.com/v1/code/sessions/cse_abc",
      "https://api.anthropic.com/v1/code/sessions/cse_def"
    ])
    title = "Renamed review"
    expect((yield* readClaudeTitles(["session_abc"], dependencies)).get("session_abc")).toBe(title)
  })
)

testEffect(
  "local sessions need neither credentials nor a title request",
  Effect.gen(function* () {
    const unexpected = () => Effect.fail(new Error("unexpected lookup"))
    expect(
      (yield* readClaudeTitles([], {
        readAccessToken: () => Effect.fail(new Error("unexpected lookup")),
        request: unexpected
      })).size
    ).toBe(0)
  })
)

testEffect(
  "title failures are explicit and do not expose server bodies or credentials",
  Effect.gen(function* () {
    for (const [status, detail] of [
      [401, "Claude rejected the access token (HTTP 401)"],
      [403, "access denied"],
      [404, "server returned HTTP 404"],
      [429, "server returned HTTP 429"],
      [500, "server returned HTTP 500"]
    ] as const) {
      yield* Effect.map(
        Effect.flip(
          readClaudeTitles(["session_abc"], {
            readAccessToken: () => Effect.succeed("secret-token"),
            request: () => Effect.sync(() => new Response("private response body", { status }))
          })
        ),
        (error) =>
          expect(() => {
            throw error
          }).toThrow(`cannot load Claude session titles: ${detail}`)
      )
    }
    yield* Effect.map(
      Effect.flip(
        readClaudeTitles(["session_abc"], {
          readAccessToken: () => Effect.succeed("secret-token"),
          request: () =>
            Effect.sync(() => {
              throw new Error("private transport details")
            })
        })
      ),
      (error) =>
        expect(() => {
          throw error
        }).toThrow("cannot load Claude session titles: connection failed")
    )
  })
)

testEffect(
  "missing, mismatched, and malformed titles fail instead of substituting a name",
  Effect.gen(function* () {
    for (const body of [
      { response_shape: { id: "cse_abc", title: null } },
      { response_shape: { id: "cse_abc", title: " " } },
      { response_shape: { id: "cse_wrong", title: "Wrong destination" } },
      { unrelated: [] }
    ]) {
      yield* Effect.map(
        Effect.flip(
          readClaudeTitles(["session_abc"], {
            readAccessToken: () => Effect.succeed("test-token"),
            request: () => Effect.sync(() => Response.json(body))
          })
        ),
        (error) =>
          expect(() => {
            throw error
          }).toThrow("cannot load Claude session titles:")
      )
    }
  })
)

testEffect(
  "invalid remote IDs are rejected before reading credentials",
  Effect.gen(function* () {
    yield* Effect.map(
      Effect.flip(
        readClaudeTitles(["session_../other"], {
          readAccessToken: () => Effect.fail(new Error("unexpected credential read")),
          request: () =>
            Effect.sync(() => {
              throw new Error("unexpected request")
            })
        })
      ),
      (error) =>
        expect(() => {
          throw error
        }).toThrow("cannot load Claude session titles: invalid remote session ID")
    )
  })
)

testEffect(
  "interrupting title lookup releases the credential scope",
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    let released = false
    const lookup = yield* Effect.forkScoped(
      readTitlesEffect(["session_abc"], {
        readAccessToken: () =>
          Effect.scoped(
            Effect.gen(function* () {
              yield* Effect.acquireRelease(
                Effect.sync(() => Deferred.doneUnsafe(started, Effect.void)),
                () =>
                  Effect.sync(() => {
                    released = true
                  })
              )
              return yield* Effect.never
            })
          ),
        request: () =>
          Effect.sync(() => {
            throw new Error("unexpected request")
          })
      })
    )
    yield* Deferred.await(started)
    yield* Fiber.interrupt(lookup)
    expect((yield* Fiber.await(lookup))._tag).toBe("Failure")
    expect(released).toBe(true)
  })
)

testEffect(
  "interrupting title lookup aborts its HTTP request",
  Effect.gen(function* () {
    const started = yield* Deferred.make<AbortSignal>()
    const server = yield* serveScoped(() =>
      Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: (request) => Effect.runPromise(Effect.never, { signal: request.signal })
      })
    )
    const lookup = yield* Effect.forkScoped(
      readTitlesEffect(["session_abc"], {
        readAccessToken: () => Effect.succeed("fixture-token"),
        request: (_url, init) => {
          const signal = init.signal!
          Deferred.doneUnsafe(started, Effect.succeed(signal))
          return Effect.tryPromise(() => fetch(server.url, init))
        }
      })
    )
    const signal = yield* Deferred.await(started)
    expect(signal.aborted).toBe(false)
    yield* Fiber.interrupt(lookup)
    expect((yield* Fiber.await(lookup))._tag).toBe("Failure")
    expect(signal.aborted).toBe(true)
  })
)

testEffect(
  "title requests never follow redirects with credentials",
  Effect.gen(function* () {
    let redirected = 0
    const destination = yield* serveScoped(() =>
      Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: () => {
          redirected += 1
          return new Response("unexpected")
        }
      })
    )
    const origin = yield* serveScoped(() =>
      Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: () => Response.redirect(destination.url.href)
      })
    )
    yield* Effect.map(
      Effect.flip(
        readClaudeTitles(["session_abc"], {
          readAccessToken: () => Effect.succeed("fixture-token"),
          request: (_url, init) => Effect.tryPromise(() => fetch(origin.url, init))
        })
      ),
      (error) =>
        expect(() => {
          throw error
        }).toThrow("cannot load Claude session titles: connection failed")
    )
    expect(redirected).toBe(0)
  })
)

testEffect(
  "interrupting Keychain lookup terminates its subprocess",
  Effect.gen(function* () {
    const directory = yield* temporaryDirectory(join(tmpdir(), "nudge-keychain-interrupt-"))
    const started = yield* Deferred.make<number>()
    const lookup = yield* Effect.forkScoped(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const fixture = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (!ChildProcess.isStandardCommand(command) || command.command !== "security")
              return yield* Effect.die(new Error("unexpected command"))
            const child = yield* spawner.spawn(
              ChildProcess.make(
                process.execPath,
                [join(import.meta.dir, "fixtures/process/idle.ts")],
                command.options
              )
            )
            Deferred.doneUnsafe(started, Effect.succeed(child.pid))
            return child
          })
        )
        return yield* readStoredAccessToken({ platform: "darwin", directory }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fixture)
        )
      }).pipe(Effect.provide(BunServices.layer), Effect.provide(BunHttpClient.layer))
    )
    const pid = yield* Effect.raceAll([
      Deferred.await(started),
      Fiber.await(lookup).pipe(
        Effect.andThen(Effect.fail(new Error("lookup exited before spawning")))
      )
    ])
    yield* Fiber.interrupt(lookup)
    expect((yield* Fiber.await(lookup))._tag).toBe("Failure")
    expect(() => process.kill(pid, 0)).toThrow()
  })
)

testEffect(
  "file credentials support Linux and Windows without a Keychain process",
  Effect.gen(function* () {
    const directory = yield* temporaryDirectory(join(tmpdir(), "nudge-credentials-"))
    const path = join(directory, ".credentials.json")
    const noProcesses = ChildProcessSpawner.make(() => Effect.die(new Error("unexpected process")))
    for (const platform of ["linux", "win32"] as const) {
      yield* Effect.tryPromise(() =>
        Bun.write(path, JSON.stringify({ claudeAiOauth: { accessToken: "fixture-login" } }))
      )
      const token = readStoredAccessToken({ platform, directory }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noProcesses)
      )
      const titles = yield* readClaudeTitles(["session_abc"], {
        readAccessToken: () => token,
        request: (_url, init) =>
          Effect.sync(() => {
            expect(init.headers).toMatchObject({ authorization: "Bearer fixture-login" })
            return Response.json({ session: { id: "cse_abc", title: "Review" } })
          })
      })
      expect(titles.get("session_abc")).toBe("Review")
      for (const body of [
        "private malformed credentials",
        "{}",
        '{"claudeAiOauth":{"accessToken":""}}'
      ]) {
        yield* Effect.tryPromise(() => Bun.write(path, body))
        const error = yield* Effect.flip(token)
        expect(error.message).toBe(
          `cannot read a Claude access token from credentials file ${path}`
        )
        expect(error.message).not.toContain(body)
      }
      yield* Effect.tryPromise(() => Bun.write(path, "{}"))
      yield* Effect.tryPromise(() => chmod(path, 0o000))
      const unreadable = (yield* Effect.flip(token)).message
      expect(unreadable).toStartWith(`cannot read Claude credentials file at ${path}: `)
      expect(unreadable).not.toContain("no Claude credentials file")
      yield* Effect.tryPromise(() => chmod(path, 0o600))
      yield* Effect.tryPromise(() => Bun.file(path).delete())
      expect((yield* Effect.flip(token)).message).toBe(`no Claude credentials file at ${path}`)
    }
  })
)

testEffect(
  "macOS prefers Keychain and falls back to the existing credentials file",
  Effect.gen(function* () {
    const directory = yield* temporaryDirectory(join(tmpdir(), "nudge-keychain-fallback-"))
    const path = join(directory, ".credentials.json")
    yield* Effect.tryPromise(() =>
      Bun.write(path, JSON.stringify({ claudeAiOauth: { accessToken: "file-login" } }))
    )
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    for (const [body, exitCode, expected] of [
      [JSON.stringify({ claudeAiOauth: { accessToken: "keychain-login" } }), 0, "keychain-login"],
      ["", 1, "file-login"],
      ["invalid credentials", 0, "file-login"]
    ] as const) {
      const fixture = ChildProcessSpawner.make((command) => {
        if (!ChildProcess.isStandardCommand(command) || command.command !== "security")
          return Effect.die(new Error("unexpected command"))
        return spawner.spawn(
          ChildProcess.make(
            process.execPath,
            [join(import.meta.dir, "fixtures/process/credentials.ts")],
            {
              ...command.options,
              env: { FIXTURE_CREDENTIALS: body, FIXTURE_EXIT_CODE: String(exitCode) }
            }
          )
        )
      })
      expect(
        yield* readStoredAccessToken({ platform: "darwin", directory }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fixture)
        )
      ).toBe(expected)
    }
  }).pipe(Effect.provide(BunServices.layer))
)
