import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"

import { BunHttpClient } from "@effect/platform-bun"
import { Effect } from "effect"

import {
  assertCurrentMacReleases,
  desktopVersion,
  claudeVersion,
  macDesktopChecksum,
  macClaudeChecksum
} from "../releases.ts"

const here = import.meta.dir
const repo = resolve(here, "../../..")
const base = Bun.env["NUDGE_MACOS_BASE_VM"]
const missing =
  process.platform !== "darwin"
    ? "requires macOS"
    : process.arch !== "arm64"
      ? "requires Apple Silicon"
      : !Bun.which("tart")
        ? "Tart is not installed"
        : !Bun.which("uvx")
          ? "uv is not installed (needed for VM screenshots)"
          : !Bun.which("sshpass")
            ? "sshpass is not installed"
            : !base
              ? "set NUDGE_MACOS_BASE_VM to a clean Tart macOS VM with admin/admin SSH and an admin GUI login"
              : null
if (missing) {
  console.error(`macOS E2E skipped—verification incomplete: ${missing}`)
  process.exit(0)
}
const available = Bun.spawnSync(["tart", "list", "--source", "local", "--quiet"])
if (available.exitCode !== 0 || !available.stdout.toString().split("\n").includes(base!)) {
  console.error(`macOS E2E skipped—verification incomplete: Tart base VM ${base} is unavailable`)
  process.exit(0)
}
const releases = await Effect.runPromise(
  assertCurrentMacReleases().pipe(Effect.provide(BunHttpClient.layer))
)
const name = `nudge-macos-e2e-${crypto.randomUUID()}`
const out = join(here, "out", name)
const cache = join(here, ".cache")
await mkdir(out, { recursive: true })
await mkdir(cache, { recursive: true })
await Bun.write(join(out, "releases.json"), JSON.stringify(releases, null, 2))
const run = async (args: string[], options: { cwd?: string } = {}) => {
  const child = Bun.spawn(args, {
    ...options,
    env: { ...Bun.env, TART_NO_AUTO_PRUNE: "1" },
    stdout: "pipe",
    stderr: "pipe"
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ])
  if (code !== 0) throw new Error(`${args[0]} exited ${code}: ${stderr}\n${stdout}`)
  return stdout.trim()
}
const sshOptions = [
  "-F",
  "/dev/null",
  "-o",
  "ForwardAgent=no",
  "-o",
  "PreferredAuthentications=password",
  "-o",
  "PubkeyAuthentication=no",
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "UserKnownHostsFile=/dev/null",
  "-o",
  "ConnectTimeout=5"
]
let ip = ""
const ssh = async (command: string) => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run(["sshpass", "-p", "admin", "ssh", ...sshOptions, `admin@${ip}`, command])
    } catch (error) {
      // Authentication rejection happens before the remote command can run.
      if (
        attempt >= 2 ||
        !String(error).includes("Permission denied (publickey,password,keyboard-interactive)")
      )
        throw error
      await Bun.write(join(out, `ssh-auth-retry-${Date.now()}.log`), String(error))
      await Bun.sleep(2000)
    }
  }
}
let vm: Bun.Subprocess | undefined
let cloned = false
try {
  console.log(`Artifacts: ${out}`)
  await run(["tart", "clone", base!, name])
  cloned = true
  await run([
    "tart",
    "set",
    name,
    "--memory",
    "6144",
    "--display",
    "2048x1536px",
    "--no-display-refit"
  ])
  await Bun.write(
    join(out, "host.json"),
    JSON.stringify({
      base,
      name,
      tart: await run(["tart", "--version"]),
      platform: process.platform,
      arch: process.arch,
      display: "2048x1536px",
      composerClick: { x: 750, y: 760 }
    })
  )
  vm = Bun.spawn(
    [
      "tart",
      "run",
      name,
      "--no-graphics",
      "--vnc-experimental",
      "--no-audio",
      "--no-clipboard",
      "--dir",
      `proof:${out}`,
      "--dir",
      `assets:${cache}:ro`
    ],
    {
      stdout: Bun.file(join(out, "tart.log")),
      stderr: Bun.file(join(out, "tart-errors.log"))
    }
  )
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      ip = await run(["tart", "ip", name])
      await ssh("true")
      break
    } catch {
      await Bun.sleep(1000)
    }
  }
  if (!ip) throw new Error("VM did not acquire an IP")
  const desktopArchive = join(cache, `Codex-${desktopVersion}.zip`)
  if (!(await Bun.file(desktopArchive).exists()))
    await run([
      "curl",
      "-fL",
      "--retry",
      "3",
      `https://persistent.oaistatic.com/codex-app-prod/ChatGPT-darwin-arm64-${desktopVersion}.zip`,
      "-o",
      desktopArchive
    ])
  const checksum = await run(["shasum", "-a", "256", desktopArchive])
  if (!checksum.startsWith(`${macDesktopChecksum} `))
    throw new Error(`Codex archive checksum mismatch (expected ${desktopVersion})`)
  await Bun.write(join(out, "downloads.txt"), checksum)
  await Promise.all(
    [
      [
        "bun.zip",
        "https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-darwin-aarch64.zip"
      ],
      [
        `claude-${claudeVersion}`,
        `https://downloads.claude.ai/claude-code-releases/${claudeVersion}/darwin-arm64/claude`
      ]
    ].map(async ([filename, url]) => {
      const path = join(cache, filename!)
      if (!(await Bun.file(path).exists()) || Bun.file(path).size === 0)
        await run(["curl", "-fL", "--retry", "3", "--max-time", "600", url!, "-o", path])
    })
  )
  const archive = join(out, "source.tar")
  await run(
    [
      "tar",
      "--exclude",
      ".cache",
      "--exclude",
      "out",
      "-cf",
      archive,
      "package.json",
      "bun.lock",
      "tsconfig.json",
      "README.md",
      "src",
      "test/e2e/linux-desktop",
      "test/e2e/macos-desktop/entrypoint.ts"
    ],
    { cwd: repo }
  )
  console.log("Installing real macOS app and pinned Bun/Claude builds in the fresh clone")
  await Bun.write(
    join(out, "provision.log"),
    await ssh(`set -eu
mkdir /Users/admin/nudge
cd /Users/admin/nudge
tar -xf "/Volumes/My Shared Files/proof/source.tar"
ditto -x -k "/Volumes/My Shared Files/assets/Codex-${desktopVersion}.zip" /tmp/nudge-desktop
sudo ditto /tmp/nudge-desktop/ChatGPT.app /Applications/ChatGPT.app
mkdir -p /Users/admin/.bun/bin
cp "/Volumes/My Shared Files/assets/bun.zip" /tmp/bun.zip
echo '90987a3a16d7db556d886ac3d551e7b6d3edf0a1cf43acaed622e8676be1d12f  /tmp/bun.zip' | shasum -a 256 -c -
unzip -qo /tmp/bun.zip -d /tmp
cp /tmp/bun-darwin-aarch64/bun /Users/admin/.bun/bin/bun
cp "/Volumes/My Shared Files/assets/claude-${claudeVersion}" /Users/admin/.bun/bin/claude
echo '${macClaudeChecksum}  /Users/admin/.bun/bin/claude' | shasum -a 256 -c -
chmod +x /Users/admin/.bun/bin/claude
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' /Applications/ChatGPT.app/Contents/Info.plist)" = "${desktopVersion}"
/Users/admin/.bun/bin/claude --version
`)
  )
  console.log(
    "Running clean GUI startup, README install, baseline rejection, and installed delivery"
  )
  await ssh(
    `nohup /bin/sh -c 'sleep 2; exec env NUDGE_E2E_MAC_VM=1 /Users/admin/.bun/bin/bun /Users/admin/nudge/test/e2e/macos-desktop/entrypoint.ts' > "/Volumes/My Shared Files/proof/proof-run.log" 2>&1 < /dev/null &`
  )
  let finished = false
  for (let attempt = 0; attempt < 600; attempt++) {
    await Bun.sleep(1000)
    const request = Bun.file(join(out, "capture-request"))
    if (await request.exists()) {
      const phase = (await request.text()).trim()
      if (
        !["factory", "baseline", "installed", "baseline-open-task", "installed-open-task"].includes(
          phase
        )
      )
        throw new Error("invalid capture request")
      if (!(await Bun.file(join(out, `${phase}.png`)).exists())) {
        const log = await Bun.file(join(out, "tart.log")).text()
        const address = /vnc:\/\/[^\s]+/.exec(log)?.[0]
        if (!address) throw new Error("Tart did not expose its VM display")
        const url = new URL(address)
        await run([
          "uvx",
          "--from",
          "vncdotool==1.2.0",
          "vncdo",
          "--timeout",
          "45",
          "--server",
          `${url.hostname}::${url.port}`,
          "--password",
          decodeURIComponent(url.password),
          ...(phase.endsWith("-open-task")
            ? [
                "pause",
                "5",
                "capture",
                join(out, `${phase}-before.png`),
                "key",
                "esc",
                "pause",
                "1",
                "key",
                "esc",
                "move",
                "750",
                "760",
                "click",
                "1",
                "type",
                `nudge-helper-startup-${phase.replace("-open-task", "")}`,
                "key",
                "enter"
              ]
            : []),
          "pause",
          "2",
          "capture",
          join(out, `${phase}.png`)
        ])
      }
    }
    if (await Bun.file(join(out, "finished")).exists()) {
      finished = true
      break
    }
    if (vm.exitCode !== null) throw new Error("VM exited before proof completed")
  }
  if (!finished) throw new Error("macOS guest proof timed out")
  const result = Bun.file(join(out, "result.json"))
  if (!(await result.exists()) || (await result.json()).outcome !== "PASS")
    throw new Error(`macOS installation/delivery failed; see ${out}`)
  console.log(`PASS: real macOS installation and delivery; evidence ${out}`)
} finally {
  if (cloned) await run(["tart", "stop", name])
  if (vm) await vm.exited
  if (cloned && !Bun.env["NUDGE_MACOS_KEEP_VM"]) await run(["tart", "delete", name])
}
