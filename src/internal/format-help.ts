import { Option } from "effect";
import type { FlagDoc, HelpDoc } from "effect/cli/HelpDoc";

import { columns } from "../shared/columns.ts";

const describeFlagValue = (type: string) => (type === "boolean" ? "" : ` <${type}>`);

const ROOT_ONLY_FLAGS = new Set(["version"]);

const CHOICES_SUFFIX = / \(choices: [^)]*\)$/u;

const describeFlag = (flag: FlagDoc) => {
  const short = flag.aliases.find((alias) => /^-\w$/u.test(alias));
  const long = `--${flag.name}${describeFlagValue(flag.type)}`;
  return [
    short === undefined ? `    ${long}` : `${short}, ${long}`,
    Option.getOrElse(flag.description, () => "").replace(CHOICES_SUFFIX, ""),
  ];
};

const deriveUsage = (doc: HelpDoc) =>
  doc.usage
    .replace(" <subcommand> [flags]", " [command] [flags]")
    .replaceAll(/\[<(?<name>[^>]+)>\]/gu, "[$<name>]");

const HELP_COLUMN_GAP = "   ";

const indent = (text: string) => text.replaceAll(/^(?=.)/gmu, "  ");

export const formatHelpDoc = (doc: HelpDoc): string => {
  const commands = (doc.subcommands ?? []).flatMap((group) => group.commands);
  const isRoot = commands.length > 0;
  const commandName = doc.usage.split(" [flags]")[0]?.split(" <subcommand>")[0] ?? "";
  const flags = [...doc.flags, ...(doc.globalFlags ?? [])]
    .filter((flag) => isRoot || !ROOT_ONLY_FLAGS.has(flag.name))
    .toSorted((left, right) => left.name.localeCompare(right.name));
  return [
    doc.description,
    `Usage:\n${indent(deriveUsage(doc))}`,
    ...(isRoot
      ? [
          `Available Commands:\n${indent(
            columns(
              commands.map((command) => [
                command.name,
                command.shortDescription ?? command.description.split("\n")[0] ?? "",
              ]),
              HELP_COLUMN_GAP,
            ),
          )}`,
        ]
      : []),
    `Flags:\n${indent(
      columns(
        flags.map((flag) => describeFlag(flag)),
        HELP_COLUMN_GAP,
      ),
    )}`,
    ...(isRoot ? [`Use "${commandName} [command] --help" for more about a command.`] : []),
  ].join("\n\n");
};
