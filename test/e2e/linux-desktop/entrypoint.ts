import { chmod, lstat, mkdir, readdir, realpath } from "node:fs/promises"
import { basename, join } from "node:path"

import { BunHttpClient, BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect, Schema, Stream } from "effect"
import { HttpClient } from "effect/unstable/http"
import { ChildProcess } from "effect/unstable/process"

import { command, runCommand, spawnLogged, waitUntil } from "./commands.ts"

const out = "/out"
const repo = "/repo"
const resources = "/usr/lib/chatgpt/resources"
const home = "/home/tester"
const work = join(home, "work")
const codexHome = join(home, ".codex")
const workspace = join(work, "workspace")
const fixtures = join(work, "fixtures")
const port = 8891
const payload = `NUDGE-E2E-${crypto.randomUUID().replaceAll("-", "").toUpperCase()}`
const marker = `MOCK_ANSWERED_${payload}`
const claudePayload = `CLAUDE-${payload}`
const commonEnv = {
  HOME: home,
  USER: "tester",
  LANG: "C.UTF-8",
  PATH: `${home}/.bun/bin:/usr/local/bin:/usr/bin:/bin`,
  AIMOCK_API_KEY: "nudge-e2e-not-a-real-key",
  BUN_INSTALL: join(home, ".bun"),
  BUN_INSTALL_CACHE_DIR: "/opt/bun-cache",
  HTTP_PROXY: "http://127.0.0.1:9",
  HTTPS_PROXY: "http://127.0.0.1:9",
  ALL_PROXY: "http://127.0.0.1:9",
  NO_PROXY: "127.0.0.1,localhost",
  XDG_CONFIG_HOME: join(work, "xdg-config"),
  XDG_CACHE_HOME: join(work, "xdg-cache"),
  XDG_DATA_HOME: join(work, "xdg-data"),
  XDG_RUNTIME_DIR: join(work, "xdg-runtime")
}
const tester = (
  args: readonly [string, ...string[]],
  env: Readonly<Record<string, string>> = commonEnv
) =>
  command(
    [
      "runuser",
      "-u",
      "tester",
      "--",
      "env",
      ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
      ...args
    ],
    { cwd: repo }
  )
const write = (path: string, body: string | Bun.BunFile) =>
  Effect.tryPromise(() => Bun.write(path, body))
const present = (path: string) =>
  Effect.tryPromise({ try: () => lstat(path), catch: (cause) => cause }).pipe(
    Effect.map(() => true),
    Effect.catch((cause) =>
      cause instanceof Error && "code" in cause && cause.code === "ENOENT"
        ? Effect.succeed(false)
        : Effect.fail(cause)
    )
  )

const desktopPipe = Effect.tryPromise(async () => {
  const entries = await readdir("/tmp/codex-browser-use", { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isSocket() || !entry.name.endsWith(".sock")) continue
    const path = join("/tmp/codex-browser-use", entry.name)
    try {
      const socket = await Bun.connect({ unix: path, socket: { data() {} } })
      socket.end()
      return path
    } catch {}
  }
  return null
}).pipe(Effect.catch(() => Effect.succeed(null)))

function block(markdown: string, language: string) {
  const text = markdown.split("```" + language + "\n")[1]?.split("```")[0]
  if (!text?.trim()) throw new Error(`README is missing its ${language} block`)
  return text
}

const snapshot = Effect.fn("snapshot")(function* (label: string) {
  const xwd = join(out, `${label}.xwd`)
  yield* runCommand(
    tester(["xwd", "-root", "-silent", "-out", xwd], { ...commonEnv, DISPLAY: ":99" })
  )
  const convert = yield* command(["xwdtopnm", xwd], { stderr: "ignore" }).pipe(
    ChildProcess.pipeTo(command(["pnmtopng"], { stderr: "ignore" }))
  )
  const [code, chunks] = yield* Effect.all([convert.exitCode, Stream.runCollect(convert.stdout)], {
    concurrency: "unbounded"
  })
  if (code !== 0) return yield* Effect.fail(new Error("screenshot conversion failed"))
  yield* Effect.tryPromise(() => Bun.write(join(out, `${label}.png`), new Blob(chunks)))
  const windows = yield* runCommand(
    tester(["xwininfo", "-root", "-children"], { ...commonEnv, DISPLAY: ":99" })
  )
  yield* write(join(out, `${label}-windows.txt`), windows)
}, Effect.scoped)

const collect = Effect.gen(function* () {
  for (const name of ["config.toml", "session_index.jsonl"]) {
    yield* write(join(out, name), Bun.file(join(codexHome, name))).pipe(Effect.ignore)
  }
  yield* runCommand(command(["ps", "-ef"])).pipe(
    Effect.flatMap((body) => write(join(out, "processes.txt"), body)),
    Effect.ignore
  )
  const rollouts = yield* Stream.fromAsyncIterable(
    new Bun.Glob("**/*.jsonl").scan({ cwd: join(codexHome, "sessions"), absolute: true }),
    (cause) => cause
  ).pipe(
    Stream.runCollect,
    Effect.catch(() => Effect.succeed([]))
  )
  yield* Effect.forEach(rollouts, (path) =>
    write(join(out, basename(path)), Bun.file(path)).pipe(Effect.ignore)
  )
  yield* runCommand(command(["chmod", "-R", "a+r", out])).pipe(Effect.ignore)
})

const main = Effect.gen(function* () {
  if (Bun.env["NUDGE_E2E_IMAGE"] !== "1" || process.getuid?.() !== 0)
    return yield* Effect.fail(new Error("run this entrypoint only inside the E2E image"))
  yield* Effect.tryPromise(() => chmod("/dev/shm", 0o1777))
  const interfaces = yield* Effect.tryPromise(() => readdir("/sys/class/net"))
  for (const name of interfaces.filter((entry) => entry !== "lo")) {
    yield* runCommand(command(["ip", "link", "set", "dev", name, "down"]))
    const flags = yield* Effect.tryPromise(() => Bun.file(`/sys/class/net/${name}/flags`).text())
    if ((Number(flags.trim()) & 1) !== 0)
      return yield* Effect.fail(new Error(`network interface ${name} is still active`))
  }
  yield* Effect.tryPromise(() => mkdir(out, { recursive: true }))
  yield* Effect.tryPromise(() => chmod(out, 0o777))
  yield* Effect.addFinalizer(() => collect)
  for (const path of [
    join(repo, "node_modules"),
    join(repo, "dist"),
    join(home, ".bun/bin/nudge"),
    codexHome
  ]) {
    if (yield* present(path))
      return yield* Effect.fail(
        new Error(`installation did not start clean: ${path} already exists`)
      )
  }
  yield* runCommand(tester(["which", "nudge"])).pipe(
    Effect.matchEffect({
      onFailure: () => Effect.void,
      onSuccess: () => Effect.fail(new Error("nudge is already on PATH"))
    })
  )
  for (const path of [
    work,
    commonEnv.XDG_CONFIG_HOME,
    commonEnv.XDG_CACHE_HOME,
    commonEnv.XDG_DATA_HOME,
    commonEnv.XDG_RUNTIME_DIR
  ]) {
    yield* Effect.tryPromise(() => mkdir(path, { recursive: true }))
  }
  yield* Effect.tryPromise(() => chmod(commonEnv.XDG_RUNTIME_DIR, 0o700))
  yield* runCommand(command(["chown", "-R", "tester:tester", home]))
  const userns = yield* runCommand(tester(["unshare", "--user", "--map-root-user", "true"])).pipe(
    Effect.match({ onFailure: () => false, onSuccess: () => true })
  )
  yield* write(
    join(out, "sandbox-mode.txt"),
    userns ? "chromium namespace sandbox\n" : "VM isolation; Chromium --no-sandbox\n"
  )
  // Start the real Desktop before installing Nudge or writing any Codex config.
  yield* Effect.scoped(
    Effect.gen(function* () {
      const factory = yield* spawnLogged(
        tester([
          "xvfb-run",
          "-a",
          "-n",
          "99",
          "-s",
          "-screen 0 1280x1024x24 -nolisten tcp -ac",
          "/usr/bin/chatgpt",
          ...(userns ? [] : ["--no-sandbox"]),
          "--password-store=basic",
          "--disable-gpu"
        ]),
        join(out, "factory-chatgpt.log")
      )
      yield* waitUntil("factory-default Desktop app-tools pipe", desktopPipe, 120_000).pipe(
        Effect.raceFirst(
          factory.completed.pipe(
            Effect.andThen(Effect.fail(new Error("factory Desktop exited early")))
          )
        )
      )
      yield* waitUntil(
        "factory Desktop backend initialization",
        Effect.tryPromise(() => Bun.file(join(out, "factory-chatgpt.log")).text()).pipe(
          Effect.map((body) => (body.includes("Codex CLI initialized") ? true : null))
        ),
        60_000
      )
      if (yield* present(join(home, ".local/state/nudge/codex/desktop-bridge.sock"))) {
        return yield* Effect.fail(new Error("factory Desktop unexpectedly started a Nudge bridge"))
      }
      yield* snapshot("factory-default-desktop").pipe(Effect.ignore)
      yield* write(
        join(out, "factory-default.json"),
        JSON.stringify(
          {
            realDesktopStarted: true,
            configExistedBeforeLaunch: false,
            nudgeInstalled: false,
            bridgePresent: false,
            modelConfigWritten: false,
            codexHomeOverride: false
          },
          null,
          2
        )
      )
      console.log(
        "PASS: real Desktop starts with no existing Codex profile, no config, and no Nudge installation"
      )
    })
  )
  const readme = yield* Effect.tryPromise(() => Bun.file(join(repo, "README.md")).text())
  const installation = block(readme.split("## Install")[1] ?? "", "bash")
  const install = yield* spawnLogged(
    tester([
      "bash",
      "-eu",
      "-c",
      `${installation}\ncommand -v nudge > /out/installed-command\nprintf '%s' "$PATH" > /out/installed-path\n`
    ]),
    join(out, "install.log")
  )
  yield* install.completed.pipe(Effect.timeout("120 seconds"))
  const installedEnv = {
    ...commonEnv,
    PATH: yield* Effect.tryPromise(() => Bun.file(join(out, "installed-path")).text())
  }
  const resolved = (yield* runCommand(tester(["which", "nudge"], installedEnv))).trim()
  if (resolved !== join(home, ".bun/bin/nudge"))
    return yield* Effect.fail(new Error(`unexpected installed command: ${resolved}`))
  const linked = yield* Effect.tryPromise(() => realpath(resolved))
  if (linked !== join(repo, "dist/nudge"))
    return yield* Effect.fail(new Error(`unexpected installation symlink: ${linked}`))
  const version = (yield* runCommand(tester(["nudge", "--version"], installedEnv))).trim()
  yield* write(
    join(out, "installation.json"),
    JSON.stringify(
      { clean: true, readmeCommands: installation, resolved, linked, version },
      null,
      2
    )
  )
  console.log(`Installed nudge ${version} using the README: ${resolved}`)

  for (const path of [
    codexHome,
    workspace,
    fixtures,
    commonEnv.XDG_CONFIG_HOME,
    commonEnv.XDG_CACHE_HOME,
    commonEnv.XDG_DATA_HOME,
    commonEnv.XDG_RUNTIME_DIR
  ])
    yield* Effect.tryPromise(() => mkdir(path, { recursive: true }))
  yield* Effect.tryPromise(() => chmod(commonEnv.XDG_RUNTIME_DIR, 0o700))
  yield* write(
    join(fixtures, "e2e.json"),
    JSON.stringify({
      fixtures: [
        {
          match: { userMessage: claudePayload },
          response: { content: `MOCK_ANSWERED_${claudePayload}` }
        },
        { match: { toolResultContains: payload }, response: { content: marker } },
        { match: { userMessage: payload }, response: { content: marker } },
        { match: {}, response: { content: "MOCK_DEFAULT" } }
      ]
    })
  )
  const config = block(readme, "toml")
    .replaceAll("/path/to/nudge", repo)
    .replaceAll("/Applications/ChatGPT.app/Contents/Resources", resources)
  const configPath = join(codexHome, "config.toml")
  const factoryConfig = (yield* present(configPath))
    ? yield* Effect.tryPromise(() => Bun.file(configPath).text())
    : ""
  yield* write(join(out, "factory-config.toml"), factoryConfig)
  const modelConfig = `model = "mock-model"
model_provider = "aimock"

${factoryConfig}
[model_providers.aimock]
name = "aimock"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
env_key = "AIMOCK_API_KEY"
requires_openai_auth = false
`
  yield* write(join(codexHome, "config.toml"), modelConfig)
  const statePath = join(codexHome, ".codex-global-state.json")
  const factoryState = (yield* present(statePath))
    ? yield* Effect.tryPromise(() => Bun.file(statePath).text())
    : "{}"
  yield* write(join(out, "factory-global-state.json"), factoryState)
  const record = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))
  const state = record(JSON.parse(factoryState))
  yield* write(
    statePath,
    JSON.stringify({
      ...state,
      "electron-persisted-atom-state": {
        ...record(state["electron-persisted-atom-state"] ?? {}),
        "electron:onboarding-projectless-completed": true
      }
    })
  )
  if (yield* present(join(codexHome, "auth.json")))
    return yield* Effect.fail(new Error("unexpected auth.json"))
  yield* runCommand(command(["chown", "-R", "tester:tester", home]))
  const mock = yield* spawnLogged(
    tester(
      [
        join(repo, "node_modules/.bin/llmock"),
        "-p",
        String(port),
        "-f",
        fixtures,
        "--log-level",
        "info"
      ],
      installedEnv
    ),
    join(out, "aimock.log")
  )
  const client = HttpClient.withScope(yield* HttpClient.HttpClient)
  yield* waitUntil(
    "local model server",
    client.get(`http://127.0.0.1:${port}/__aimock/journal`).pipe(
      Effect.map((response) => (response.status === 200 ? true : null)),
      Effect.scoped,
      Effect.catch(() => Effect.succeed(null))
    ),
    20_000
  ).pipe(
    Effect.raceFirst(
      Effect.raceFirst(mock.completed, mock.child.exitCode).pipe(
        Effect.flatMap((code) =>
          Effect.fail(
            new Error(
              `local model server exited early with code ${code ?? 0}; see ${out}/aimock.log`
            )
          )
        )
      )
    )
  )
  const driverEnv = {
    ...installedEnv,
    CODEX_HOME: codexHome,
    E2E_PAYLOAD: payload,
    E2E_MARKER: marker,
    E2E_AIMOCK_PORT: String(port),
    E2E_WORKSPACE: workspace,
    E2E_RESOURCES: resources,
    E2E_STATE_DIR: join(home, ".local/state/nudge"),
    E2E_OUT: out
  }
  const bootstrap = yield* spawnLogged(
    tester(["bun", join(repo, "test/e2e/linux-desktop/driver.ts"), "--bootstrap"], driverEnv),
    join(out, "bootstrap.log")
  )
  yield* bootstrap.completed.pipe(Effect.timeout("180 seconds"))
  for (const phase of ["baseline", "installed"] as const) {
    if (phase === "installed") {
      const existing = yield* Effect.tryPromise(() =>
        Bun.file(join(codexHome, "config.toml")).text()
      )
      yield* write(join(out, "baseline-final-config.toml"), existing)
      yield* write(join(codexHome, "config.toml"), `${existing}\n${config}`)
      console.log("Applied only the README Codex helper block; restarting the same Desktop profile")
    }
    yield* write(join(out, `${phase}-config.toml`), Bun.file(join(codexHome, "config.toml")))
    yield* Effect.scoped(
      Effect.gen(function* () {
        const app = yield* spawnLogged(
          tester(
            [
              "xvfb-run",
              "-a",
              "-n",
              "99",
              "-s",
              "-screen 0 1280x1024x24 -nolisten tcp -ac",
              "/usr/bin/chatgpt",
              ...(userns ? [] : ["--no-sandbox"]),
              "--password-store=basic",
              "--disable-gpu"
            ],
            {
              ...installedEnv,
              ELECTRON_ENABLE_LOGGING: "1"
            }
          ),
          join(out, `${phase}-chatgpt.log`)
        )
        yield* Effect.gen(function* () {
          const pipe = yield* waitUntil("Desktop app-tools pipe", desktopPipe, 120_000)
          yield* snapshot(`${phase}-screen-before-send`).pipe(Effect.ignore)
          const driver = yield* spawnLogged(
            tester(
              [
                "bun",
                join(repo, "test/e2e/linux-desktop/driver.ts"),
                ...(phase === "baseline" ? ["--baseline"] : [])
              ],
              {
                ...driverEnv,
                E2E_PIPE_PATH: pipe
              }
            ),
            join(out, `${phase}-driver.log`)
          )
          yield* driver.completed.pipe(Effect.timeout("300 seconds"))
          console.log(
            yield* Effect.tryPromise(() => Bun.file(join(out, `${phase}-driver.log`)).text())
          )
          yield* snapshot(`${phase}-screen-after-send`).pipe(Effect.ignore)
        }).pipe(
          Effect.raceFirst(
            Effect.raceFirst(
              Effect.raceFirst(app.completed, mock.completed),
              Effect.raceFirst(app.child.exitCode, mock.child.exitCode)
            ).pipe(
              Effect.flatMap((code) =>
                Effect.fail(
                  new Error(
                    `Desktop or local model server exited early with code ${code ?? 0}; see ${out}`
                  )
                )
              )
            )
          )
        )
      })
    )
  }
  const claude = yield* spawnLogged(
    tester(["bun", join(repo, "test/e2e/linux-desktop/claude.ts")], {
      ...driverEnv,
      E2E_PAYLOAD: claudePayload,
      E2E_MARKER: `MOCK_ANSWERED_${claudePayload}`,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      ANTHROPIC_AUTH_TOKEN: "nudge-e2e-not-a-real-token",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      TERM: "xterm-256color"
    }),
    join(out, "claude-driver.log")
  )
  yield* claude.completed.pipe(
    Effect.timeout("180 seconds"),
    Effect.raceFirst(
      Effect.raceFirst(mock.completed, mock.child.exitCode).pipe(
        Effect.flatMap((code) =>
          Effect.fail(
            new Error(
              `local model server exited early with code ${code ?? 0}; see ${out}/aimock.log`
            )
          )
        )
      )
    )
  )
  console.log(yield* Effect.tryPromise(() => Bun.file(join(out, "claude-driver.log")).text()))
  yield* client.get(`http://127.0.0.1:${port}/__aimock/journal`).pipe(
    Effect.flatMap((response) => response.text),
    Effect.flatMap((body) => write(join(out, "aimock-journal.json"), body))
  )
})

BunRuntime.runMain(
  main.pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.provide(BunHttpClient.layer))
)
