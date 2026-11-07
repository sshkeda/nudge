import { Effect, Schema } from "effect";

import { describeProvider, Session } from "../shared/session.ts";

const encodeShownSession = Schema.encodeEffect(Session);

export const encodeSession = Effect.fn("encodeSession")(function* (session: typeof Session.Type) {
  const shown = yield* encodeShownSession(session);
  return {
    provider: describeProvider(session.provider),
    id: shown.id,
    name: shown.name,
    status: shown.status,
    project: shown.project,
    section: shown.section,
    cwd: shown.directory,
    transcript: shown.transcript,
    lastActiveAt: shown.lastActiveAt,
  };
});

export const describeTarget = ({ id, name }: Pick<typeof Session.Type, "id" | "name">) => ({
  id,
  name,
});
