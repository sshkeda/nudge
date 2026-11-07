import { Runtime, Schema } from "effect";

import { columns } from "../shared/columns.ts";
import { USAGE_EXIT_CODE } from "../shared/model-choice.ts";
import {
  isEchoable,
  messageOf,
  prose,
  quoted,
  Report,
  shellCommand,
  showOnTerminal,
  trusted,
} from "../shared/report.ts";
import { describeProvider, NamedSession } from "../shared/session.ts";

export const PROGRAM = "nudge";

const hintOf = (hint: string | null) => (hint === null ? undefined : trusted(hint));

export const listCommand = ({
  archived,
  query,
}: {
  readonly archived: boolean;
  readonly query?: string | undefined;
}) => {
  const words = [PROGRAM, "list", ...(archived ? ["--archived"] : [])];
  const hasNoQuery = query === undefined || query === "";
  if (hasNoQuery) {
    return words;
  }
  return query.startsWith("-") ? [...words, "--", query] : [...words, query];
};

const describeArchived = (archived: boolean) => (archived ? "archived " : "");

export class SessionNotFound extends Schema.TaggedError<SessionNotFound>()("SessionNotFound", {
  target: Schema.String,
  archived: Schema.Boolean,
}) {
  public get report(): Report {
    return new Report({
      message: prose`no ${describeArchived(this.archived)}session matches ${quoted(this.target)}`,
      hint: shellCommand(listCommand({ archived: this.archived })),
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class SessionNameAmbiguous extends Schema.TaggedError<SessionNameAmbiguous>()(
  "SessionNameAmbiguous",
  {
    target: Schema.String,
    archived: Schema.Boolean,
    candidates: Schema.Array(NamedSession),
  },
) {
  public get report(): Report {
    return new Report({
      message: prose`${this.candidates.length} ${describeArchived(this.archived)}sessions are named ${quoted(this.target)}`,
      details: {
        show: () =>
          columns([
            ["NAME", "PROVIDER", "ID"],
            ...this.candidates.map((candidate) => [
              showOnTerminal(candidate.name),
              candidate.provider,
              showOnTerminal(candidate.id),
            ]),
          ]),
      },
      data: {
        candidates: this.candidates.map(({ provider, id, name }) => ({
          provider: describeProvider(provider),
          id,
          name,
        })),
      },
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class SessionArchived extends Schema.TaggedError<SessionArchived>()("SessionArchived", {
  target: Schema.String,
  ids: Schema.Array(Schema.String),
}) {
  public get report(): Report {
    const [id] = this.ids;
    const hasOneId = id !== undefined && this.ids.length === 1;
    const query = isEchoable(this.target) ? this.target : undefined;
    return new Report({
      message: prose`${quoted(this.target)} is archived`,
      hint: shellCommand(
        hasOneId ? [PROGRAM, "unarchive", id] : listCommand({ archived: true, query }),
      ),
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class SessionArgumentMissing extends Schema.TaggedError<SessionArgumentMissing>()(
  "SessionArgumentMissing",
  { command: Schema.String, archived: Schema.Boolean },
) {
  public override readonly [Runtime.errorExitCode] = USAGE_EXIT_CODE;

  public get report(): Report {
    return new Report({
      message: prose`${this.command} needs a session ID or name`,
      hint: shellCommand(listCommand({ archived: this.archived })),
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class ArgumentMissing extends Schema.TaggedError<ArgumentMissing>()("ArgumentMissing", {
  command: Schema.String,
  argument: Schema.String,
}) {
  public override readonly [Runtime.errorExitCode] = USAGE_EXIT_CODE;

  public get report(): Report {
    return new Report({
      message: prose`${this.command} needs ${this.argument}`,
      hint: prose`${this.command} --help`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class CommandMissing extends Schema.TaggedError<CommandMissing>()("CommandMissing", {
  command: Schema.String,
}) {
  public override readonly [Runtime.errorExitCode] = USAGE_EXIT_CODE;

  public get report(): Report {
    return new Report({
      message: prose`${this.command} needs a command`,
      hint: prose`${this.command} --help`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class UnknownFlag extends Schema.TaggedError<UnknownFlag>()("UnknownFlag", {
  command: Schema.String,
  flag: Schema.String,
  argument: Schema.String,
  hint: Schema.NullOr(Schema.String),
}) {
  public override readonly [Runtime.errorExitCode] = USAGE_EXIT_CODE;

  public get report(): Report {
    const isCluster = this.argument !== this.flag;
    return new Report({
      message: isCluster
        ? prose`${quoted(this.argument)} looks like a flag, but ${this.command} has no flag ${quoted(this.flag)}`
        : prose`${quoted(this.argument)} looks like a flag, but ${this.command} has no such flag`,
      hint: hintOf(this.hint),
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class UnknownCommand extends Schema.TaggedError<UnknownCommand>()("UnknownCommand", {
  command: Schema.String,
  subcommand: Schema.String,
  hint: Schema.String,
}) {
  public override readonly [Runtime.errorExitCode] = USAGE_EXIT_CODE;

  public get report(): Report {
    return new Report({
      message: prose`${this.command} has no command ${quoted(this.subcommand)}`,
      hint: trusted(this.hint),
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class ExtraArguments extends Schema.TaggedError<ExtraArguments>()("ExtraArguments", {
  command: Schema.String,
  arguments: Schema.Array(Schema.String),
}) {
  public override readonly [Runtime.errorExitCode] = USAGE_EXIT_CODE;

  public get report(): Report {
    const [first] = this.arguments;
    const noun = this.arguments.length === 1 ? "argument" : "arguments";
    const rest = this.arguments.length > 1 ? ` and ${this.arguments.length - 1} more` : "";
    return new Report({
      message: prose`${this.command} got the extra ${noun} ${quoted(first ?? "")}${rest}`,
      hint: prose`${this.command} --help`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class FlagValueMissing extends Schema.TaggedError<FlagValueMissing>()("FlagValueMissing", {
  command: Schema.String,
  flag: Schema.String,
}) {
  public override readonly [Runtime.errorExitCode] = USAGE_EXIT_CODE;

  public get report(): Report {
    return new Report({
      message: prose`${this.flag} needs a value`,
      hint: prose`${this.command} --help`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class FlagRepeated extends Schema.TaggedError<FlagRepeated>()("FlagRepeated", {
  command: Schema.String,
  flag: Schema.String,
}) {
  public override readonly [Runtime.errorExitCode] = USAGE_EXIT_CODE;

  public get report(): Report {
    return new Report({
      message: prose`${this.flag} can only be given once`,
      hint: prose`${this.command} --help`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class FlagValueInvalid extends Schema.TaggedError<FlagValueInvalid>()("FlagValueInvalid", {
  command: Schema.String,
  flag: Schema.String,
  value: Schema.String,
  expected: Schema.optional(Schema.String),
}) {
  public override readonly [Runtime.errorExitCode] = USAGE_EXIT_CODE;

  public get report(): Report {
    return new Report({
      message:
        this.expected === undefined
          ? prose`${this.flag} can't be ${quoted(this.value)}`
          : prose`${this.flag} must be ${this.expected}, not ${quoted(this.value)}`,
      hint: prose`${this.command} --help`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class FlagValueTooSmall extends Schema.TaggedError<FlagValueTooSmall>()(
  "FlagValueTooSmall",
  { command: Schema.String, flag: Schema.String, value: Schema.Int, least: Schema.Int },
) {
  public override readonly [Runtime.errorExitCode] = USAGE_EXIT_CODE;

  public get report(): Report {
    return new Report({
      message: prose`${this.flag} must be ${this.least} or more, not ${this.value}`,
      hint: prose`${this.command} --help`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class ArgumentValueInvalid extends Schema.TaggedError<ArgumentValueInvalid>()(
  "ArgumentValueInvalid",
  {
    command: Schema.String,
    argument: Schema.String,
    value: Schema.String,
    expected: Schema.optional(Schema.String),
  },
) {
  public override readonly [Runtime.errorExitCode] = USAGE_EXIT_CODE;

  public get report(): Report {
    return new Report({
      message:
        this.expected === undefined
          ? prose`${this.argument} can't be ${quoted(this.value)}`
          : prose`${this.argument} must be ${this.expected}, not ${quoted(this.value)}`,
      hint: prose`${this.command} --help`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class FlagMissing extends Schema.TaggedError<FlagMissing>()("FlagMissing", {
  command: Schema.String,
  flag: Schema.String,
}) {
  public override readonly [Runtime.errorExitCode] = USAGE_EXIT_CODE;

  public get report(): Report {
    return new Report({
      message: prose`${this.command} needs ${this.flag}`,
      hint: prose`${this.command} --help`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class FlagsConflict extends Schema.TaggedError<FlagsConflict>()("FlagsConflict", {
  flag: Schema.String,
  other: Schema.String,
  hint: Schema.NullOr(Schema.String),
}) {
  public override readonly [Runtime.errorExitCode] = USAGE_EXIT_CODE;

  public get report(): Report {
    return new Report({
      message: prose`you can't use ${this.flag} with ${this.other}`,
      hint: hintOf(this.hint),
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class MessageEmpty extends Schema.TaggedError<MessageEmpty>()("MessageEmpty", {}) {
  public override readonly [Runtime.errorExitCode] = USAGE_EXIT_CODE;

  public readonly report = new Report({ message: prose`the message is empty` });

  public override get message() {
    return messageOf(this.report);
  }
}

export class MessageMissing extends Schema.TaggedError<MessageMissing>()("MessageMissing", {}) {
  public override readonly [Runtime.errorExitCode] = USAGE_EXIT_CODE;

  public readonly report = new Report({
    message: prose`nudge send needs a message as an argument or on stdin, and stdin is a terminal`,
  });

  public override get message() {
    return messageOf(this.report);
  }
}

export class NameHasControlCharacters extends Schema.TaggedError<NameHasControlCharacters>()(
  "NameHasControlCharacters",
  { value: Schema.String },
) {
  public override readonly [Runtime.errorExitCode] = USAGE_EXIT_CODE;

  public get report(): Report {
    return new Report({
      message: prose`the name ${shellCommand([this.value])} has control characters, such as a newline, tab or escape, and a name can't have them`,
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class NameEmpty extends Schema.TaggedError<NameEmpty>()("NameEmpty", {}) {
  public override readonly [Runtime.errorExitCode] = USAGE_EXIT_CODE;

  public readonly report = new Report({ message: prose`the name is empty` });

  public override get message() {
    return messageOf(this.report);
  }
}

export class NameHasOuterSpaces extends Schema.TaggedError<NameHasOuterSpaces>()(
  "NameHasOuterSpaces",
  { value: Schema.String, hint: Schema.NullOr(Schema.String) },
) {
  public override readonly [Runtime.errorExitCode] = USAGE_EXIT_CODE;

  public get report(): Report {
    return new Report({
      message: prose`the name ${quoted(this.value)} starts or ends with a space`,
      hint: hintOf(this.hint),
    });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class PromptEmpty extends Schema.TaggedError<PromptEmpty>()("PromptEmpty", {}) {
  public override readonly [Runtime.errorExitCode] = USAGE_EXIT_CODE;

  public readonly report = new Report({ message: prose`the prompt is empty` });

  public override get message() {
    return messageOf(this.report);
  }
}

export class PromptMissing extends Schema.TaggedError<PromptMissing>()("PromptMissing", {}) {
  public override readonly [Runtime.errorExitCode] = USAGE_EXIT_CODE;

  public readonly report = new Report({
    message: prose`nudge new needs a prompt as an argument or on stdin, and stdin is a terminal`,
  });

  public override get message() {
    return messageOf(this.report);
  }
}

export class CommandLineInvalid extends Schema.TaggedError<CommandLineInvalid>()(
  "CommandLineInvalid",
  { command: Schema.String, reason: Schema.String },
) {
  public override readonly [Runtime.errorExitCode] = USAGE_EXIT_CODE;

  public get report(): Report {
    return new Report({ message: prose`${this.reason}`, hint: prose`${this.command} --help` });
  }

  public override get message() {
    return messageOf(this.report);
  }
}

export class FailureReported extends Schema.TaggedError<FailureReported>()("FailureReported", {
  exitCode: Schema.Int,
}) {
  public override readonly [Runtime.errorReported] = false;

  public override get [Runtime.errorExitCode]() {
    return this.exitCode;
  }

  public override get message() {
    return `exited with code ${this.exitCode}`;
  }
}
