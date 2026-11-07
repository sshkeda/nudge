import { Predicate } from "effect";
import { Completions } from "effect/cli";

import { archiveCommand } from "./archive-command.ts";
import { SESSION_ARGUMENT } from "./command-flags.ts";
import { positionalsOf } from "./command-line.ts";
import { doctorCommand } from "./doctor-command.ts";
import { listCommand } from "./list-command.ts";
import { newCommand } from "./new-command.ts";
import { renameCommand } from "./rename-command.ts";
import { sendCommand } from "./send-command.ts";
import { showCommand } from "./show-command.ts";
import { unarchiveCommand } from "./unarchive-command.ts";

export const SUBCOMMANDS = [
  listCommand,
  showCommand,
  newCommand,
  sendCommand,
  renameCommand,
  archiveCommand,
  unarchiveCommand,
  doctorCommand,
] as const;

const isTextArgument = (argument: Completions.ArgumentDescriptor) =>
  Predicate.isTagged(argument.type, "String") && argument.name !== SESSION_ARGUMENT;

export const TEXT_POSITIONS: ReadonlyMap<string, number> = new Map(
  SUBCOMMANDS.flatMap((command) => {
    const position = Completions.fromCommand(command).arguments.findIndex(isTextArgument);
    return position === -1 ? [] : [[command.name, position] as const];
  }),
);

const SUBCOMMAND_NAMES: ReadonlySet<string> = new Set(SUBCOMMANDS.map((command) => command.name));

export const subcommandOf = (words: readonly string[]) => {
  const [first] = positionalsOf(words);
  const isSubcommand = first !== undefined && SUBCOMMAND_NAMES.has(first.value);
  return isSubcommand ? first.value : undefined;
};
