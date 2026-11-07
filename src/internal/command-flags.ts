import { Flag, Param } from "effect/cli";

import { Speed } from "../shared/speed.ts";

export const SESSION_ARGUMENT = "session";

export const VALUE_FLAGS = {
  model: Flag.String("model").pipe(Flag.withMetavar("model")),
  effort: Flag.String("effort").pipe(Flag.withMetavar("effort")),
  name: Flag.String("name").pipe(Flag.withMetavar("name")),
  limit: Flag.Int("limit").pipe(Flag.withMetavar("n")),
  offset: Flag.Int("offset").pipe(Flag.withMetavar("n")),
  speed: Flag.Literals("speed", Speed.literals).pipe(Flag.withMetavar("speed")),
};

export const BUILT_IN_FLAGS = {
  help: Flag.Boolean("help").pipe(Flag.withAlias("h")),
  version: Flag.Boolean("version").pipe(Flag.withAlias("v")),
};

const singleOf = (flag: Flag.Flag<unknown>) => (Param.isSingle(flag) ? [flag] : []);

export const namesOf = (flag: Flag.Flag<unknown>) => [
  ...singleOf(flag).map((single) => single.name),
  ...singleOf(flag).flatMap((single) => single.aliases),
];

export const VALUE_FLAG_NAMES: ReadonlySet<string> = new Set(
  Object.values(VALUE_FLAGS).flatMap((flag) => singleOf(flag).map((single) => single.name)),
);

export const SHORT_FLAG_NAMES: ReadonlySet<string> = new Set(
  Object.values(BUILT_IN_FLAGS).flatMap((flag) =>
    singleOf(flag).flatMap((single) => single.aliases),
  ),
);
