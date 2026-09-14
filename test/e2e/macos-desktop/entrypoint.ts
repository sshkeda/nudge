import { mkdir, readdir, realpath } from "node:fs/promises"
import { join } from "node:path"

const home = "/Users/admin"
const repo = join(home, "nudge")
const out = "/Volumes/My Shared Files/proof"
const resources = "/Applications/ChatGPT.app/Contents/Resources"
const executable = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"
const codexHome = join(home, ".codex")
const payload = `NUDGE-MAC-E2E-${crypto.randomUUID().replaceAll("-", "").toUpperCase()}`
const marker = `MOCK_ANSWERED_${payload}`
const port = 8891
const env = {
  ...Bun.env,
  HOME: home,
  PATH: `${home}/.bun/bin:${resources}/cua_node/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
  AIMOCK_API_KEY: "nudge-e2e-not-a-real-key",
  NUDGE_E2E_IMAGE: "1",
  NUDGE_E2E_MAC_VM: "1",
  E2E_REPO: repo,
  E2E_OUT: out,
  E2E_RESOURCES: resources,
  E2E_DESKTOP_EXECUTABLE: executable,
  E2E_WORKSPACE: join(home, "work/workspace"),
  E2E_STATE_DIR: join(home, ".local/state/nudge"),
  E2E_AIMOCK_PORT: String(port),
  E2E_PAYLOAD: payload,
  E2E_MARKER: marker
}
const run = async (args: string[], label: string, overrides = {}) => {
  const child = Bun.spawn(args, {
    cwd: repo,
    env: { ...env, ...overrides },
    stdout: "pipe",
    stderr: "pipe"
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ])
  await Bun.write(join(out, `${label}.log`), stdout + stderr)
  if (code !== 0) throw new Error(`${label} exited ${code}: ${stdout}\n${stderr}`)
  return stdout
}
const assert = (value: boolean, message: string) => {
  if (!value) throw new Error(message)
}
const exists = (path: string) => Bun.file(path).exists()
const wait = async (label: string, probe: () => Promise<boolean>, timeout = 120_000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await probe()) return
    await Bun.sleep(250)
  }
  throw new Error(`timed out: ${label}`)
}
const block = (readme: string, language: string) => {
  const value = readme.split("```" + language + "\n")[1]?.split("```")[0]
  if (!value) throw new Error(`missing README ${language}`)
  return value
}
let app: Bun.Subprocess | undefined
let mock: Bun.Subprocess | undefined
const stopApp = async () => {
  if (!app) return
  app.kill("SIGTERM")
  await app.exited
  app = undefined
  await Bun.sleep(1500)
}
const startApp = (phase: string) => {
  app = Bun.spawn([executable], {
    env,
    stdout: Bun.file(join(out, `${phase}-desktop.log`)),
    stderr: Bun.file(join(out, `${phase}-desktop-errors.log`))
  })
}
const screenshot = async (phase: string) => {
  await Bun.write(join(out, "capture-request"), phase)
  await wait(
    `VM display capture ${phase}`,
    () => Bun.file(join(out, `${phase}.png`)).exists(),
    60_000
  )
}

await mkdir(out, { recursive: true })
try {
  assert(
    process.platform === "darwin" && Bun.env["NUDGE_E2E_MAC_VM"] === "1",
    "only run in the disposable macOS VM"
  )
  assert(
    (await run(["/usr/sbin/sysctl", "-n", "kern.hv_vmm_present"], "virtualization")).trim() === "1",
    "not a virtual machine"
  )
  assert(
    (await run(["/usr/bin/stat", "-f", "%Su", "/dev/console"], "console-user")).trim() === "admin",
    "no admin GUI login"
  )
  assert(
    !Bun.env["CODEX_HOME"] && !Bun.env["CLAUDE_CONFIG_DIR"] && !Bun.env["NODE_OPTIONS"],
    "profile or helper override"
  )
  assert(
    (await run(["/usr/bin/csrutil", "status"], "sip-status")).includes("enabled"),
    "SIP must be enabled in the base VM"
  )
  assert(
    (await run(["/usr/sbin/spctl", "--status"], "gatekeeper-status")).includes("enabled"),
    "Gatekeeper must be enabled in the base VM"
  )
  const entries = await readdir(home)
  for (const name of [".codex", ".claude", ".claude.json"])
    assert(!entries.includes(name), `preexisting ${name}`)
  for (const name of ["dist", "node_modules"])
    assert(!(await readdir(repo)).includes(name), `preexisting ${name}`)
  assert(!(await exists(join(home, ".bun/bin/nudge"))), "preinstalled nudge")
  await run(
    ["/usr/bin/codesign", "--verify", "--deep", "--strict", "/Applications/ChatGPT.app"],
    "codesign-verify"
  )
  await run(
    ["/usr/bin/codesign", "-dvvv", "--entitlements", ":-", "/Applications/ChatGPT.app"],
    "codesign-details"
  )
  await run(
    [
      "/usr/sbin/spctl",
      "--assess",
      "--type",
      "execute",
      "--verbose=4",
      "/Applications/ChatGPT.app"
    ],
    "gatekeeper-assessment"
  )
  await run(
    ["/usr/bin/codesign", "-dvvv", "--entitlements", ":-", join(resources, "cua_node/bin/node")],
    "node-signature"
  )
  await run(["/usr/bin/xattr", "-l", "/Applications/ChatGPT.app"], "app-attributes")
  await run(["/usr/bin/sw_vers"], "macos-version")
  await run(["/usr/bin/sudo", "/sbin/ifconfig", "en0", "down"], "factory-network-off")
  startApp("factory")
  await wait("factory backend initialization", async () => {
    assert(app?.exitCode === null, "Desktop exited")
    return (await Bun.file(join(out, "factory-desktop.log")).text()).includes(
      "Codex CLI initialized"
    )
  })
  assert(
    !(await exists(join(home, ".local/state/nudge/codex/desktop-bridge.sock"))),
    "factory bridge exists"
  )
  await screenshot("factory")
  await stopApp()
  await Bun.write(
    join(out, "factory-default.json"),
    JSON.stringify({
      realDesktopStarted: true,
      configExistedBeforeLaunch: false,
      nudgeInstalled: false,
      bridgePresent: false,
      modelConfigWritten: false,
      codexHomeOverride: false
    })
  )
  console.log("PASS: clean macOS GUI Desktop startup without Nudge or profile")
  await run(["/usr/bin/sudo", "/sbin/ifconfig", "en0", "up"], "installation-network-on")
  await wait("installation network after enabling en0", async () => {
    try {
      return (
        await fetch("https://registry.npmjs.org/", {
          method: "HEAD",
          signal: AbortSignal.timeout(3000)
        })
      ).ok
    } catch {
      return false
    }
  })
  const readme = await Bun.file(join(repo, "README.md")).text()
  const install = block(readme.split("## Install")[1]!, "bash")
  await run(["/bin/bash", "-eu", "-c", install], "installation")
  const resolved = (await run(["/usr/bin/which", "nudge"], "installed-command")).trim()
  assert(resolved === join(home, ".bun/bin/nudge"), "unexpected installed command")
  assert((await realpath(resolved)) === join(repo, "dist/nudge"), "unexpected installation link")
  await run(["nudge", "--version"], "installed-version")
  await Bun.write(
    join(out, "installation.json"),
    JSON.stringify({ readmeCommands: install, resolved, linked: await realpath(resolved) })
  )
  await mkdir(env.E2E_WORKSPACE, { recursive: true })
  await mkdir(join(home, "fixtures"), { recursive: true })
  await Bun.write(
    join(home, "fixtures/e2e.json"),
    JSON.stringify({
      fixtures: [
        {
          match: { userMessage: `CLAUDE-${payload}` },
          response: { content: `MOCK_ANSWERED_CLAUDE-${payload}` }
        },
        { match: { toolResultContains: payload }, response: { content: marker } },
        { match: { userMessage: payload }, response: { content: marker } },
        { match: {}, response: { content: "MOCK_DEFAULT" } }
      ]
    })
  )
  const configPath = join(codexHome, "config.toml")
  const factoryConfig = (await exists(configPath)) ? await Bun.file(configPath).text() : ""
  await Bun.write(join(out, "factory-config.toml"), factoryConfig)
  await Bun.write(
    configPath,
    `model = "mock-model"\nmodel_provider = "aimock"\n${factoryConfig}\n[model_providers.aimock]\nname = "aimock"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nenv_key = "AIMOCK_API_KEY"\nrequires_openai_auth = false\n`
  )
  const statePath = join(codexHome, ".codex-global-state.json")
  const state = (await exists(statePath)) ? await Bun.file(statePath).json() : {}
  await Bun.write(join(out, "factory-global-state.json"), JSON.stringify(state))
  state["electron-persisted-atom-state"] = {
    ...state["electron-persisted-atom-state"],
    "electron:onboarding-projectless-completed": true
  }
  await Bun.write(statePath, JSON.stringify(state))
  assert(!(await exists(join(codexHome, "auth.json"))), "unexpected authentication")
  mock = Bun.spawn(
    [
      join(repo, "node_modules/.bin/llmock"),
      "-p",
      String(port),
      "-f",
      join(home, "fixtures"),
      "--log-level",
      "info"
    ],
    {
      env,
      stdout: Bun.file(join(out, "aimock.log")),
      stderr: Bun.file(join(out, "aimock-errors.log"))
    }
  )
  await wait("mock model", async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/__aimock/journal`)).ok
    } catch {
      return false
    }
  })
  const driver = join(repo, "test/e2e/linux-desktop/driver.ts")
  for (const mode of ["--bootstrap", "--bootstrap-target"])
    await run(["bun", driver, mode], mode.slice(2), { CODEX_HOME: codexHome })
  // Installation is complete; prevent model egress and automatic app updates.
  await run(["/usr/bin/sudo", "/sbin/ifconfig", "en0", "down"], "network-off")
  for (const phase of ["baseline", "installed"]) {
    if (phase === "installed") {
      const existing = await Bun.file(configPath).text()
      await Bun.write(join(out, "baseline-final-config.toml"), existing)
      await Bun.write(
        configPath,
        existing + "\n" + block(readme, "toml").replaceAll("/path/to/nudge", repo)
      )
    }
    await Bun.write(join(out, `${phase}-config.toml`), Bun.file(configPath))
    startApp(phase)
    await wait(`${phase} backend`, async () =>
      (await Bun.file(join(out, `${phase}-desktop.log`)).text()).includes("Codex CLI initialized")
    )
    console.log(
      await run(
        ["bun", driver, ...(phase === "baseline" ? ["--baseline"] : [])],
        `${phase}-driver`,
        { CODEX_HOME: codexHome }
      )
    )
    await screenshot(phase)
    await stopApp()
  }
  console.log(
    await run(["bun", join(repo, "test/e2e/linux-desktop/claude.ts")], "claude-driver", {
      E2E_PAYLOAD: `CLAUDE-${payload}`,
      E2E_MARKER: `MOCK_ANSWERED_CLAUDE-${payload}`,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      ANTHROPIC_AUTH_TOKEN: "nudge-e2e-not-a-real-token",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      TERM: "xterm-256color"
    })
  )
  await Bun.write(
    join(out, "aimock-journal.json"),
    await (await fetch(`http://127.0.0.1:${port}/__aimock/journal`)).text()
  )
  await Bun.write(
    join(out, "result.json"),
    JSON.stringify({
      outcome: "PASS",
      payload,
      limits:
        "Mock model; Codex projectless onboarding and Claude onboarding/trust pre-completed; no account sign-in or remote-control keychain proof. Signed app launched in real Aqua session."
    })
  )
  console.log("PASS: macOS clean installation and Codex/Claude delivery")
} catch (error) {
  await Bun.write(join(out, "failure.txt"), String(error))
  throw error
} finally {
  await stopApp()
  mock?.kill()
  await run(["/usr/bin/sudo", "/sbin/ifconfig", "en0", "up"], "network-restored")
  if ((await readdir(codexHome).catch((): string[] => [])).includes("sessions")) {
    for await (const path of new Bun.Glob("**/*.jsonl").scan({
      cwd: join(codexHome, "sessions"),
      absolute: true
    }))
      await Bun.write(join(out, path.split("/").at(-1)!), Bun.file(path))
  }
  await Bun.write(join(out, "finished"), "done")
}
