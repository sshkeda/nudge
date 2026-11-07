import { Effect, Option, Schema, Stream } from "effect";
import { ChildProcess } from "effect/process";

import { toOneLine } from "./print-line.ts";
import { IN_CODEX_SANDBOX } from "./read-environment.ts";
import { messageOf, prose, Report, shellCommand } from "./report.ts";

export class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", {
  command: Schema.Array(Schema.String),
  exitCode: Schema.Int,
  standardError: Schema.String,
}) {
  public get report(): Report {
    const standardError = toOneLine(this.standardError);
    const cause = standardError === "" ? "" : `: ${standardError}`;
    return new Report({
      message: prose`${shellCommand(this.command)} exited with code ${this.exitCode}${cause}`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class CommandNotStarted extends Schema.TaggedError<CommandNotStarted>()(
  "CommandNotStarted",
  { command: Schema.String, reason: Schema.String, isBlockedByCodexSandbox: Schema.Boolean },
) {
  public get report(): Report {
    return new Report({
      message: this.isBlockedByCodexSandbox
        ? prose`Codex's sandbox blocks nudge from running ${shellCommand([this.command])}, so run this nudge command outside the sandbox`
        : prose`nudge couldn't start ${shellCommand([this.command])}: ${toOneLine(this.reason)}`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

const decodeLaunchFailure = Schema.decodeUnknownOption(
  Schema.Struct({ message: Schema.String, code: Schema.optional(Schema.Unknown) }),
);

export const runCommand = (
  name: string,
  commandArguments: readonly string[],
  commandOptions: {
    readonly workingDirectory?: string | undefined;
    readonly environment?: Readonly<Record<string, string>>;
    readonly shownArguments?: number;
    readonly input?: string;
  } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const child = yield* ChildProcess.make(name, commandArguments, {
        cwd: commandOptions.workingDirectory,
        env: commandOptions.environment,
        extendEnv: true,
        stdin:
          commandOptions.input === undefined
            ? "ignore"
            : Stream.make(new TextEncoder().encode(commandOptions.input)),
        stderr: "pipe",
      }).pipe(
        Effect.catchDefect((defect) =>
          Effect.flatMap(IN_CODEX_SANDBOX, (isInCodexSandbox) => {
            const launchFailure = decodeLaunchFailure(defect);
            const isForbidden = Option.exists(launchFailure, (failure) => failure.code === "EPERM");
            return Effect.fail(
              new CommandNotStarted({
                command: name,
                reason: Option.match(launchFailure, {
                  onNone: () => String(defect),
                  onSome: (failure) => failure.message,
                }),
                isBlockedByCodexSandbox: isInCodexSandbox && isForbidden,
              }),
            );
          }),
        ),
      );
      const [standardOutput, standardError, exitCode] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(child.stdout)),
          Stream.mkString(Stream.decodeText(child.stderr)),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (exitCode !== 0) {
        return yield* new CommandFailed({
          command: [
            name,
            ...commandArguments.slice(0, commandOptions.shownArguments ?? commandArguments.length),
          ],
          exitCode,
          standardError,
        });
      }
      return standardOutput;
    }),
  );
