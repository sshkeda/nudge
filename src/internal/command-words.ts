import { Effect, Stdio } from "effect";

import { withJsonAfterCommand } from "./command-line.ts";

export const HELP_COMMAND = "help";

export const commandWords = Effect.gen(function* () {
  const words = withJsonAfterCommand(yield* (yield* Stdio.Stdio).args);
  const [first, ...rest] = words;
  return first === HELP_COMMAND ? [...rest, "--help"] : words;
});
