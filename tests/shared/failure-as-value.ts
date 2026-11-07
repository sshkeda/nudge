import { Effect } from "effect";

export const exitOf = <Success, Failure, Requirements>(
  effect: Effect.Effect<Success, Failure, Requirements>,
) => Effect.exit(effect);

export const resultOf = <Success, Failure, Requirements>(
  effect: Effect.Effect<Success, Failure, Requirements>,
) => Effect.result(effect);
