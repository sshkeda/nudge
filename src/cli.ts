import { BunHttpClient, BunServices } from "@effect/platform-bun"
import { Console, Effect, Option, Result, Stream } from "effect"
import {
  Argument,
  CliConfig,
  CliError,
  CliOutput,
  Command,
  Flag,
  GlobalFlag
} from "effect/unstable/cli"

import packageJson from "../package.json" with { type: "json" }
import { UsageError } from "./errors.ts"
import { listTargets, sendToTarget } from "./operations.ts"

const jsonFlag = booleanFlag("json").pipe(Flag.withDescription("Output JSON."))
const list = Command.make(
  "list",
  {
    query: Argument.String("QUERY").pipe(
      Argument.withDefault(""),
      Argument.withDescription("Filter names, providers, or IDs (case-insensitive).")
    ),
    json: jsonFlag.pipe(
      Flag.withDescription(
        "Output JSON. Shows all matches unless --limit is supplied. Model and effort are last-known values."
      )
    ),
    archived: booleanFlag("archived").pipe(
      Flag.withDescription("List archived Codex tasks and Claude Desktop sessions.")
    ),
    all: booleanFlag("all").pipe(
      Flag.withDescription("Show all matches. Cannot be combined with --limit.")
    ),
    limit: Flag.Int("limit").pipe(
      Flag.withDescription("Maximum matches to show (default: 20 for text output)."),
      Flag.filter(
        (value) => Number.isSafeInteger(value) && value >= 1,
        () => "must be an integer of at least 1"
      ),
      Flag.atMost(1),
      Flag.map(Option.fromIterable)
    ),
    offset: Flag.Int("offset").pipe(
      Flag.withDescription("Skip this many matches (default: 0)."),
      Flag.filter(
        (value) => Number.isSafeInteger(value) && value >= 0,
        () => "must be an integer of at least 0"
      ),
      Flag.atMost(1),
      Flag.map((values) => values[0] ?? 0)
    )
  },
  (options) =>
    Effect.gen(function* () {
      if (options.all && Option.isSome(options.limit))
        return yield* Effect.fail(new UsageError("--all cannot be combined with --limit"))
      yield* listTargets({
        json: options.json,
        archived: options.archived,
        query: options.query,
        offset: options.offset,
        limit: Option.getOrElse(options.limit, () => (options.json || options.all ? null : 20))
      })
    })
).pipe(
  Command.withDescription(
    "List unarchived Codex tasks and running Claude sessions, most recent first."
  ),
  Command.withExamples([
    { command: "nudge list review" },
    { command: "nudge list --limit 20 --offset 20" }
  ])
)

const send = Command.make(
  "send",
  {
    target: Argument.String("TARGET").pipe(
      Argument.withDescription("Exact name or ID from nudge list. Duplicate names require an ID.")
    ),
    message: Argument.String("MESSAGE").pipe(
      Argument.optional,
      Argument.withDescription("Message text. Omit or use - to read stdin.")
    ),
    json: jsonFlag
  },
  (options) =>
    Effect.gen(function* () {
      const target = yield* nonempty(options.target.trim(), "target")
      const argument = Option.getOrUndefined(options.message)
      const message =
        argument === undefined || argument === "-" ? yield* readStdinMessage(argument) : argument
      const content = yield* nonempty(message, "message")
      yield* sendToTarget({ target, message: content, json: options.json })
    })
).pipe(
  Command.withDescription(
    "Send a message to a Codex task or Claude session.\n\nExit codes: 0 sent, 1 failed, 2 invalid usage, 3 held pending release.\nIf Claude holds a message, do not resend while delivery is pending."
  ),
  Command.withShortDescription("Send a message to a Codex task or Claude session."),
  Command.withExamples([
    { command: 'nudge send "Code review" "PR is ready for review"' },
    { command: 'nudge send "Code review" - < message.txt' }
  ])
)

const command = Command.make("nudge").pipe(
  Command.withDescription("Send messages to Codex tasks and Claude sessions."),
  Command.withSubcommands([list, send]),
  Command.withExamples([
    { command: "nudge list review" },
    { command: 'nudge send "Code review" "PR is ready for review"' }
  ])
)
const formatter: CliOutput.Formatter = {
  ...CliOutput.defaultFormatter({ colors: false }),
  formatVersion: (_name: string, version: string) => version
}

export const runCli = Effect.fn("runCli")(function* (argv: readonly string[]) {
  const args =
    argv[0] === "help" ? [...argv.slice(1), "--help"] : argv.length === 0 ? ["--help"] : argv
  const output: string[] = []
  const result = yield* Command.runWith(command, {
    version: packageJson.version,
    renderErrors: false
  })(args).pipe(
    Effect.provide(BunServices.layer),
    Effect.provide(BunHttpClient.layer),
    Effect.provide(CliConfig.layer({ builtIns: [GlobalFlag.Help, GlobalFlag.Version] })),
    Effect.provide(CliOutput.layer(formatter)),
    Effect.provideService(Console.Console, {
      ...console,
      log: (...values) => {
        output.push(values.map(String).join(" "))
      }
    }),
    Effect.result
  )
  if (Result.isFailure(result)) {
    const error = result.failure
    if (!CliError.isCliError(error)) return yield* Effect.fail(error)
    if (error._tag !== "ShowHelp") return yield* Effect.fail(new UsageError(usageMessage(error)))
    if (error.errors.length > 0)
      return yield* Effect.fail(new UsageError(error.errors.map(usageMessage).join("\n")))
  }
  for (const line of output) process.stdout.write(line + "\n")
})

const readStdinMessage = Effect.fn("readStdinMessage")(function* (argument: string | undefined) {
  if (argument === undefined && process.stdin.isTTY) {
    return yield* Effect.fail(
      new UsageError("message is required\nhint: Pass text or pipe it to stdin")
    )
  }
  return yield* Stream.fromReadableStream({
    evaluate: () => Bun.stdin.stream(),
    onError: (cause) => cause
  }).pipe(Stream.decodeText(), Stream.mkString)
})

function nonempty(value: string, description: string) {
  return value.trim()
    ? Effect.succeed(value)
    : Effect.fail(new UsageError(`${description} must not be empty`))
}

export function optionArguments(argv: readonly string[]): readonly string[] {
  const separator = argv.indexOf("--")
  return separator === -1 ? argv : argv.slice(0, separator)
}

function usageMessage(error: CliError.CliError): string {
  return error._tag === "UnknownSubcommand"
    ? `unknown command ${JSON.stringify(error.subcommand)}\nhint: Run "nudge --help"`
    : error.message
}

function booleanFlag(name: string) {
  return Flag.Boolean(name).pipe(
    Flag.atMost(1),
    Flag.map((values) => values[0] ?? false)
  )
}
