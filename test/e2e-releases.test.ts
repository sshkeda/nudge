import { expect, test } from "bun:test"

import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"

import {
  assertCurrentReleases,
  assertCurrentMacReleases,
  claudeVersion,
  desktopVersion,
  linuxDesktopChecksum
} from "./e2e/releases.ts"

const record = (version = desktopVersion, checksum = linuxDesktopChecksum) =>
  `Package: chatgpt\nVersion: ${version}\nArchitecture: arm64\nSHA256: ${checksum}\n`

const check = (
  index: string,
  claude = claudeVersion,
  status = 200,
  platform: "linux" | "darwin" = "linux"
) =>
  Effect.runPromise(
    (platform === "linux" ? assertCurrentReleases() : assertCurrentMacReleases()).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(request.url.endsWith("/latest") ? claude : index, { status })
            )
          )
        )
      )
    )
  )

test("release gate accepts the current Codex ARM64 record among unrelated packages", async () => {
  const unrelated = record("99.0.0").replace("Package: chatgpt", "Package: unrelated")
  const otherArchitecture = record("98.0.0").replace("Architecture: arm64", "Architecture: amd64")
  const index = `${unrelated}\n${otherArchitecture}\n${record()}`.replaceAll("\n", "\r\n")
  expect((await check(index)).desktop).toBe(desktopVersion)
})

test("release gate cannot borrow a matching checksum from another package", async () => {
  const unrelated = record().replace("Package: chatgpt", "Package: unrelated")
  await expect(check(`${record(desktopVersion, "0".repeat(64))}\n${unrelated}`)).rejects.toThrow(
    "checksum differs"
  )
})

test("release gate finds the newest version independently of package ordering", async () => {
  expect((await check(`${record("26.908.9999")}\n${record()}`)).desktop).toBe(desktopVersion)
  await expect(check(`${record()}\n${record("26.908.99999")}`)).rejects.toThrow(
    "E2E builds are stale"
  )
  await expect(check(record(), "99.0.0")).rejects.toThrow("E2E builds are stale")
})

test("release gate rejects missing or malformed Codex ARM64 records", async () => {
  await expect(
    check(record().replace("Architecture: arm64", "Architecture: amd64"))
  ).rejects.toThrow("no Codex ARM64 package")
  await expect(check(record("invalid"))).rejects.toThrow("invalid Codex ARM64 package")
  await expect(check(record(desktopVersion, "invalid"))).rejects.toThrow(
    "invalid Codex ARM64 package"
  )
})

test("release gate rejects conflicting checksums for the same version", async () => {
  await expect(check(`${record()}\n${record(desktopVersion, "0".repeat(64))}`)).rejects.toThrow(
    "checksum differs"
  )
})

test("release gate rejects an HTTP failure even when its body contains valid releases", async () => {
  await expect(check(record(), claudeVersion, 503)).rejects.toThrow()
})

const item = (version: string, architecture = "arm64") =>
  `<item><sparkle:hardwareRequirements>${architecture}</sparkle:hardwareRequirements><sparkle:shortVersionString>${version}</sparkle:shortVersionString></item>`

test("macOS release gate selects the newest ARM64 appcast item", async () => {
  const appcast = item("99.0.0", "x86_64") + item("26.908.9999") + item(desktopVersion)
  expect((await check(appcast, claudeVersion, 200, "darwin")).desktop).toBe(desktopVersion)
  await expect(check(appcast + item("26.908.99999"), claudeVersion, 200, "darwin")).rejects.toThrow(
    "E2E builds are stale"
  )
  await expect(check(appcast, "99.0.0", 200, "darwin")).rejects.toThrow("E2E builds are stale")
})

test("macOS release gate rejects absent or malformed ARM64 appcast items", async () => {
  await expect(check(item(desktopVersion, "x86_64"), claudeVersion, 200, "darwin")).rejects.toThrow(
    "no Codex ARM64 release"
  )
  await expect(check(item("invalid"), claudeVersion, 200, "darwin")).rejects.toThrow(
    "invalid Codex ARM64 release"
  )
})
