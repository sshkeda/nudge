import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"

import { BunHttpClient, BunRuntime, BunServices } from "@effect/platform-bun"
import { Cause, Effect, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"

import {
  assertCurrentReleases,
  desktopVersion,
  linuxDesktopChecksum,
  claudeVersion,
  linuxClaudeChecksum
} from "../releases.ts"
import { command, runCommand } from "./commands.ts"

const here = import.meta.dir
const repo = resolve(here, "../../..")
const checksum = linuxDesktopChecksum
const cache = join(here, ".cache", checksum)
const sandbox = `nudge-linux-e2e-${crypto.randomUUID()}`
const msb = (...args: string[]) =>
  command(["bunx", "microsandbox@0.6.18", ...args], {
    env: { ...Bun.env, MSB_BACKEND: "local" }
  })

const prerequisites = Effect.gen(function* () {
  if (process.platform !== "darwin" && process.platform !== "linux")
    return "requires macOS or Linux"
  if (process.arch !== "arm64") return "requires an ARM64 host"
  if (!Bun.which("docker")) return "Docker is not installed"
  const docker = yield* runCommand(
    command(["docker", "info", "--format", "{{.ServerVersion}}"])
  ).pipe(
    Effect.timeout("15 seconds"),
    Effect.match({ onFailure: (cause) => String(cause), onSuccess: () => null })
  )
  if (docker !== null) return `Docker is unavailable: ${docker}`
  const runtime = yield* runCommand(msb("doctor")).pipe(
    Effect.timeout("60 seconds"),
    Effect.match({ onFailure: (cause) => String(cause), onSuccess: () => null })
  )
  return runtime === null ? null : `Microsandbox is unavailable: ${runtime}`
})

BunRuntime.runMain(
  Effect.gen(function* () {
    const missing = yield* prerequisites
    if (missing !== null) {
      console.error(`SKIP  Installation and delivery E2E — ${missing}`)
      console.error("\nVerification incomplete: Codex and Claude E2E tests did not run.")
      return null
    }
    const releases = yield* assertCurrentReleases()
    console.log(`Current releases: Desktop ${releases.desktop}, Claude ${releases.claude}`)
    const started = performance.now()
    yield* Effect.tryPromise(() => mkdir(cache, { recursive: true }))
    const temporary = yield* Effect.acquireRelease(
      Effect.tryPromise(() => mkdtemp(join(here, ".cache", "run-"))),
      (path) => Effect.promise(() => rm(path, { recursive: true, force: true }))
    )
    const deb = join(cache, "chatgpt_arm64.deb")
    if (!(yield* Effect.tryPromise(() => Bun.file(deb).exists()))) {
      yield* runCommand(
        command([
          "curl",
          "--fail",
          "--location",
          "--retry",
          "3",
          "--connect-timeout",
          "20",
          "--max-time",
          "600",
          `https://persistent.oaistatic.com/codex-app-prod/linux/deb/pool/main/c/chatgpt/chatgpt_${desktopVersion}_arm64.deb`,
          "--output",
          join(temporary, "download")
        ])
      )
      const bytes = yield* Effect.tryPromise(() => Bun.file(join(temporary, "download")).bytes())
      if (new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== checksum)
        return yield* Effect.fail(new Error("Desktop download checksum mismatch"))
      yield* Effect.tryPromise(() => Bun.write(deb, bytes))
    }
    const bytes = yield* Effect.tryPromise(() => Bun.file(deb).bytes())
    if (new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== checksum)
      return yield* Effect.fail(new Error("cached Desktop checksum mismatch"))
    const imageId = join(temporary, "image-id")
    yield* runCommand(
      command(
        [
          "docker",
          "build",
          "--platform",
          "linux/arm64",
          "--file",
          join(here, "Dockerfile"),
          "--build-arg",
          `CHATGPT_DEB_SHA256=${checksum}`,
          "--build-arg",
          `CLAUDE_VERSION=${claudeVersion}`,
          "--build-arg",
          `CLAUDE_SHA256=${linuxClaudeChecksum}`,
          "--build-context",
          `deb=${cache}`,
          "--iidfile",
          imageId,
          repo
        ],
        { stdout: "inherit", stderr: "inherit" }
      )
    )
    const built = (yield* Effect.tryPromise(() => Bun.file(imageId).text())).trim()
    const image = `nudge-linux-desktop-e2e:${built.replace(/^sha256:/, "")}`
    const imported = yield* runCommand(msb("image", "inspect", image, "--format", "json")).pipe(
      Effect.flatMap((body) =>
        Effect.try(
          () =>
            Schema.decodeUnknownSync(
              Schema.Struct({ config: Schema.Struct({ digest: Schema.String }) })
            )(JSON.parse(body)).config.digest
        )
      ),
      Effect.catch(() => Effect.succeed(null))
    )
    if (built !== imported) {
      yield* runCommand(
        command(["docker", "image", "save", built]).pipe(
          ChildProcess.pipeTo(msb("image", "load", "--tag", image))
        )
      )
    }
    const output = join(here, "out", sandbox)
    yield* Effect.tryPromise(() => mkdir(output, { recursive: true }))
    yield* Effect.tryPromise(() =>
      Bun.write(join(output, "releases.json"), JSON.stringify(releases, null, 2))
    )
    console.log(`Artifacts: ${output}`)
    yield* Effect.addFinalizer(() =>
      runCommand(msb("remove", "--force", sandbox)).pipe(
        Effect.timeout("30 seconds"),
        Effect.catchCause((cause) =>
          Effect.sync(() =>
            console.error(`Sandbox cleanup failed for ${sandbox}: ${Cause.pretty(cause)}`)
          ).pipe(Effect.andThen(Effect.failCause(cause)))
        ),
        Effect.orDie
      )
    )
    yield* runCommand(
      command(
        [
          "bunx",
          "microsandbox@0.6.18",
          "run",
          "--name",
          sandbox,
          "--no-tty",
          "--net",
          "none",
          "--cpus",
          "4",
          "--memory",
          "4G",
          "--timeout",
          "8m",
          "--tmpfs",
          "/dev/shm:1G",
          "--mount-dir",
          `${output}:/out`,
          image,
          ...process.argv.slice(2)
        ],
        { env: { ...Bun.env, MSB_BACKEND: "local" }, stdout: "inherit", stderr: "inherit" }
      )
    )
    return started
  }).pipe(
    Effect.scoped,
    Effect.tap((started) =>
      Effect.sync(() => {
        if (started !== null)
          console.log(
            `PASS  Codex and Claude installation and delivery E2E (${((performance.now() - started) / 1000).toFixed(1)}s)`
          )
      })
    ),
    Effect.provide(BunServices.layer),
    Effect.provide(BunHttpClient.layer)
  )
)
