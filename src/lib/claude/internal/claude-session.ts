import { Schema } from "effect";

import { Session } from "../../../shared/session.ts";

export const ClaudeRegistration = Schema.TaggedStruct("ClaudeRegistration", {
  file: Schema.String,
});

export const ClaudeSavedSession = Schema.TaggedStruct("ClaudeSavedSession", {});

export const ClaudeSession = Schema.Struct({
  ...Session.fields,
  provider: Schema.Literal("Claude"),
  appTitle: Schema.Option(Schema.String),
  appState: Schema.Literals(["listed", "archived", "absent"]),
  handle: Schema.Union([ClaudeRegistration, ClaudeSavedSession]),
});
