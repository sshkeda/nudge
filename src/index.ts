import { BunRuntime } from "@effect/platform-bun";
import { Effect } from "effect";

import { runNudge, nudgeLayer } from "./internal/run-nudge.ts";

BunRuntime.runMain(runNudge.pipe(Effect.provide(nudgeLayer)));
