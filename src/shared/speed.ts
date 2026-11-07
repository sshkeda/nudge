import { Option, Schema } from "effect";

export const Speed = Schema.Literals(["fast", "standard"]);

export const isFastRequest = (speed: Option.Option<typeof Speed.Type>) =>
  Option.contains(speed, "fast");
