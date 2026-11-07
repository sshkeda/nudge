import { Option, Schema } from "effect";

import { cutToEchoLimit, quoted, quoteForShell, showOnTerminal } from "./report.ts";
import { describeKind } from "./session.ts";

export const Sender = Schema.Struct({
  provider: Schema.Literals(["Claude", "Codex"]),
  id: Schema.String,
  name: Schema.String,
});

const escapeAttribute = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\n", "&#10;")
    .replaceAll("\r", "&#13;")
    .replaceAll("\t", "&#9;");

const describeSender = ({ provider, id, name }: typeof Sender.Type) => {
  const shownName = quoted(name).show({ mode: "terminal", home: "" });
  return `Message from ${describeKind(provider)} ${shownName} (${showOnTerminal(id)}) via nudge CLI.\nTo reply, run nudge send ${quoteForShell(id)} followed by your reply.`;
};

export const envelopeForCodex = ({
  message,
  sender,
}: {
  readonly message: string;
  readonly sender: Option.Option<typeof Sender.Type>;
}) =>
  Option.match(sender, {
    onNone: () => `Message via nudge CLI:\n\n${message}`,
    onSome: (known) => `${describeSender(known)}\n\n${message}`,
  });

export const envelopeForNewSession = ({
  prompt,
  sender,
}: {
  readonly prompt: string;
  readonly sender: Option.Option<typeof Sender.Type>;
}) =>
  Option.match(sender, {
    onNone: () => prompt,
    onSome: (known) => `${describeSender(known)}\n\n${prompt}`,
  });

export const envelopeForClaude = ({
  message,
  sender,
}: {
  readonly message: string;
  readonly sender: Option.Option<typeof Sender.Type>;
}) => {
  const body = envelopeForCodex({ message, sender }).replaceAll(
    /<\/cross-session-message/giu,
    String.raw`<\/cross-session-message`,
  );
  const attributes = Option.match(
    Option.filter(sender, ({ provider }) => provider === "Claude"),
    {
      onNone: () => "",
      onSome: ({ id, name }) =>
        ` from-session="${escapeAttribute(id)}" from-name="${escapeAttribute(cutToEchoLimit(name))}"`,
    },
  );
  return `<cross-session-message${attributes}>\n${body}\n</cross-session-message>`;
};
