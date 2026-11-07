import { Option, Schema, SchemaTransformation } from "effect";

import { prose, quoted } from "./report.ts";

const PathOrEmpty = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Option(Schema.String),
    SchemaTransformation.transform({
      decode: (path) => (path === "" ? Option.none() : Option.some(path)),
      encode: Option.getOrElse(() => ""),
    }),
  ),
);

export const Provider = Schema.Literals(["Claude", "Codex"]);

export const SessionStatus = Schema.Literals([
  "running",
  "idle",
  "waiting-for-input",
  "waiting-for-approval",
  "failed",
  "stopped",
  "archived",
  "unknown",
]);

export const Session = Schema.Struct({
  provider: Provider,
  id: Schema.String,
  name: Schema.String,
  status: SessionStatus,
  project: Schema.String,
  section: Schema.String,
  directory: Schema.String,
  transcript: PathOrEmpty,
  lastActiveAt: Schema.String,
});

export const NamedSession = Schema.Struct({
  provider: Provider,
  id: Schema.String,
  name: Schema.String,
});

const CONTROL_CHARACTER = /[\p{Cc}\p{Zl}\p{Zp}]/u;

export const hasControlCharacters = (value: string) => CONTROL_CHARACTER.test(value);

export const describeProvider = (provider: typeof Provider.Type) =>
  provider === "Claude" ? "claude" : "codex";

export const describeKind = (provider: typeof Provider.Type) =>
  provider === "Codex" ? "Codex session" : "Claude session";

export const describeSession = ({ provider, id, name }: typeof NamedSession.Type) =>
  prose`${describeKind(provider)} ${quoted(name)} (${id})`;
