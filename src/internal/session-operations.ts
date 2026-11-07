import { Effect, Option } from "effect";

import { Claude } from "../lib/claude/index.ts";
import { Codex } from "../lib/codex/index.ts";
import type { Sender } from "../shared/message-envelope.ts";
import type { Speed } from "../shared/speed.ts";
import type { findSession } from "./session-resolution.ts";

export const archiveSession = ({
  session,
  isArchived,
}: {
  readonly session: Effect.Success<ReturnType<typeof findSession>>;
  readonly isArchived: boolean;
}) =>
  Effect.gen(function* () {
    if (session.provider === "Claude") {
      return yield* (yield* Claude).archive(session);
    }
    if (isArchived) {
      return "unchanged" as const;
    }
    yield* (yield* Codex).archive(session);
    return "archived" as const;
  });

export const unarchiveSession = ({
  session,
  isArchived,
}: {
  readonly session: Effect.Success<ReturnType<typeof findSession>>;
  readonly isArchived: boolean;
}) =>
  Effect.gen(function* () {
    if (session.provider === "Claude") {
      return yield* (yield* Claude).unarchive(session);
    }
    if (!isArchived) {
      return "unchanged" as const;
    }
    yield* (yield* Codex).unarchive(session);
    return "unarchived" as const;
  });

export const renameSession = ({
  session,
  name,
}: {
  readonly session: Effect.Success<ReturnType<typeof findSession>>;
  readonly name: string;
}) =>
  Effect.gen(function* () {
    if (session.provider === "Claude") {
      return (yield* (yield* Claude).rename({ session, name })).appTitle;
    }
    yield* (yield* Codex).rename({ session, name });
    return Option.none<string>();
  });

export const checkSend = ({
  session,
  ...change
}: {
  readonly session: Effect.Success<ReturnType<typeof findSession>>;
  readonly model: Option.Option<string>;
  readonly effort: Option.Option<string>;
  readonly speed: Option.Option<typeof Speed.Type>;
}) =>
  Effect.gen(function* () {
    if (session.provider === "Claude") {
      return yield* (yield* Claude).checkSend({ session, ...change });
    }
    return yield* (yield* Codex).checkSend({ session, ...change });
  });

export const sendToSession = ({
  session,
  ...delivery
}: {
  readonly session: Effect.Success<ReturnType<typeof findSession>>;
  readonly message: string;
  readonly sender: Option.Option<typeof Sender.Type>;
  readonly model: Option.Option<string>;
  readonly effort: Option.Option<string>;
  readonly speed: Option.Option<typeof Speed.Type>;
}) =>
  Effect.gen(function* () {
    if (session.provider === "Claude") {
      return yield* (yield* Claude).send({ session, ...delivery });
    }
    return yield* (yield* Codex).send({ session, ...delivery });
  });
