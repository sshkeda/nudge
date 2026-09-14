import { Effect } from "effect"
import { HttpClient } from "effect/unstable/http"

export const desktopVersion = "26.908.70816"
export const linuxDesktopChecksum =
  "d3ec8f1d73b92f203715c26dbf2e0e64375192d00ddaf26f7fbade7777124de8"
export const claudeVersion = "2.1.270"
export const linuxClaudeChecksum =
  "7bf9f33acc124df9abccf6f2366397a82a740378d535fa12d426fa77fdbc9946"

export const macDesktopChecksum = "95e8867bffda4da9cc3a61886a57f0c90c69dd92eb91efeef86afc80e24d62a1"
export const macClaudeChecksum = "a506b6d970a4cf44f6abdb53a81ddcd5d3b0ce042a95c502fe9d1f946bdb8807"

const releaseText = Effect.fn("releaseText")(function* (url: string) {
  const client = HttpClient.filterStatusOk(HttpClient.withScope(yield* HttpClient.HttpClient))
  return yield* client.get(url).pipe(
    Effect.flatMap((response) => response.text),
    Effect.timeout("30 seconds")
  )
})

export const assertCurrentReleases = Effect.fn("assertCurrentReleases")(function* () {
  const [desktop, claude] = yield* Effect.all(
    [
      releaseText(
        "https://persistent.oaistatic.com/codex-app-prod/linux/deb/dists/stable/main/binary-arm64/Packages"
      ),
      releaseText("https://downloads.claude.ai/claude-code-releases/latest")
    ],
    { concurrency: "unbounded" }
  )
  const packages = desktop
    .replaceAll("\r\n", "\n")
    .split(/\n[ \t]*\n/)
    .filter((record) => /^Package: chatgpt$/m.test(record) && /^Architecture: arm64$/m.test(record))
  if (packages.length === 0)
    return yield* Effect.fail(new Error("Publisher index has no Codex ARM64 package"))
  const releases = []
  for (const record of packages) {
    const version = /^Version: (.+)$/m.exec(record)?.[1]?.trim()
    const checksum = /^SHA256: (.+)$/m.exec(record)?.[1]?.trim()
    if (
      version === undefined ||
      !/^\d+\.\d+\.\d+$/.test(version) ||
      checksum === undefined ||
      !/^[a-f0-9]{64}$/.test(checksum)
    )
      return yield* Effect.fail(new Error("Publisher index has an invalid Codex ARM64 package"))
    releases.push({ version, checksum })
  }
  releases.sort((a, b) => Bun.semver.order(b.version, a.version))
  const latest = releases[0]!
  if (latest.version !== desktopVersion || claude.trim() !== claudeVersion)
    return yield* Effect.fail(
      new Error(
        `E2E builds are stale: publisher has Desktop ${latest.version}, Claude ${claude.trim()}; update test/e2e/releases.ts and checksums before claiming current-version verification`
      )
    )
  if (
    releases.some(
      (release) => release.version === latest.version && release.checksum !== linuxDesktopChecksum
    )
  )
    return yield* Effect.fail(new Error("Linux Desktop checksum differs from the publisher index"))
  return {
    checkedAt: new Date().toISOString(),
    platform: "linux",
    desktop: desktopVersion,
    claude: claudeVersion
  }
}, Effect.scoped)

export const assertCurrentMacReleases = Effect.fn("assertCurrentMacReleases")(function* () {
  const [appcast, claude] = yield* Effect.all(
    [
      releaseText("https://persistent.oaistatic.com/codex-app-prod/appcast.xml"),
      releaseText("https://downloads.claude.ai/claude-code-releases/latest")
    ],
    { concurrency: "unbounded" }
  )
  const versions = []
  for (const [item] of appcast.matchAll(/<item>[\s\S]*?<\/item>/g)) {
    if (!item.includes("<sparkle:hardwareRequirements>arm64</sparkle:hardwareRequirements>"))
      continue
    const version = /<sparkle:shortVersionString>([^<]+)<\/sparkle:shortVersionString>/.exec(
      item
    )?.[1]
    if (version === undefined || !/^\d+\.\d+\.\d+$/.test(version))
      return yield* Effect.fail(new Error("Publisher appcast has an invalid Codex ARM64 release"))
    versions.push(version)
  }
  versions.sort((a, b) => Bun.semver.order(b, a))
  if (versions.length === 0)
    return yield* Effect.fail(new Error("Publisher appcast has no Codex ARM64 release"))
  if (versions[0] !== desktopVersion || claude.trim() !== claudeVersion)
    return yield* Effect.fail(
      new Error(
        `E2E builds are stale: publisher has macOS Desktop ${versions[0]}, Claude ${claude.trim()}; update test/e2e/releases.ts and checksums`
      )
    )
  return {
    checkedAt: new Date().toISOString(),
    platform: "darwin",
    desktop: desktopVersion,
    claude: claudeVersion
  }
}, Effect.scoped)
