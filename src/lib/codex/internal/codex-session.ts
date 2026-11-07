import { Schema } from "effect";

import { Session } from "../../../shared/session.ts";

export const CodexRollout = Schema.TaggedStruct("CodexRollout", { file: Schema.String });

export const CodexSession = Schema.Struct({
  ...Session.fields,
  provider: Schema.Literal("Codex"),
  handle: CodexRollout,
});
