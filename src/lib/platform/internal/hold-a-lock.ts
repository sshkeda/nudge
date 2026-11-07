import { Effect, Option, Schema } from "effect";

import { CodexBridgeLockFailed, CodexBridgeLockHeldElsewhere } from "./errors.ts";

const NodeFailure = Schema.Struct({
  message: Schema.String,
  code: Schema.optional(Schema.String),
});

const decodeNodeFailure = Schema.decodeUnknownOption(NodeFailure);

export const holdALock = ({
  file,
  lock,
  heldElsewhereCodes,
}: {
  readonly file: string;
  readonly lock: () => Promise<Effect.Effect<void>>;
  readonly heldElsewhereCodes: ReadonlySet<string>;
}) =>
  Effect.tryPromise({
    try: lock,
    catch: (error) => {
      const failure = Option.getOrElse(decodeNodeFailure(error), () => ({
        message: "it failed without an error message",
        code: undefined,
      }));
      const isHeldElsewhere = heldElsewhereCodes.has(failure.code ?? "");
      return isHeldElsewhere
        ? new CodexBridgeLockHeldElsewhere({ file })
        : new CodexBridgeLockFailed({ file, reason: failure.message });
    },
  }).pipe(
    Effect.map((release) => Option.some({ release })),
    Effect.catchTag("CodexBridgeLockHeldElsewhere", () => Effect.succeedNone),
  );
