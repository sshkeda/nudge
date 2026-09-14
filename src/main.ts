#!/usr/bin/env bun

import { BunRuntime } from "@effect/platform-bun"
import { Effect, Runtime } from "effect"

import { optionArguments, runCli } from "./cli.ts"
import { UsageError } from "./errors.ts"

const json = optionArguments(process.argv.slice(2)).some((arg) =>
  /^(?:--json|--json=(?:true|1|y|yes|on))$/u.test(arg)
)

function report(cause: unknown) {
  return Effect.sync(() => {
    const usage = cause instanceof UsageError
    const message = cause instanceof Error ? cause.message : String(cause)
    const error = { code: usage ? "invalid_usage" : "operation_failed", message }
    if (json) process.stderr.write(`${JSON.stringify({ status: "error", error })}\n`)
    else process.stderr.write(`error: ${error.message}\n`)
    process.exitCode = usage ? 2 : 1
  })
}

BunRuntime.runMain(
  runCli(process.argv.slice(2)).pipe(Effect.catch(report), Effect.catchDefect(report)),
  {
    disableErrorReporting: true,
    teardown: (exit, done) =>
      Runtime.defaultTeardown(exit, (code) => {
        const exitCode = code === 0 ? Number(process.exitCode ?? 0) : code
        process.exitCode = exitCode
        done(exitCode)
      })
  }
)
