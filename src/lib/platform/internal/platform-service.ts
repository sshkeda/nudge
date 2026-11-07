import { Context, Effect, Layer } from "effect";
import type { FileSystem } from "effect";
import type { ChildProcessSpawner } from "effect/process";

import { runCommand } from "../../../shared/run-command.ts";
import { PlatformUnsupported } from "./errors.ts";
import { makeLinuxPlatform } from "./linux-platform.ts";
import { makeMacosPlatform } from "./macos-platform.ts";

export class Platform extends Context.Service<
  Platform,
  Effect.Success<typeof makeLinuxPlatform> | ReturnType<typeof makeMacosPlatform>
>()("nudge/Platform") {}

const linuxPlatformLayer = Layer.effect(Platform, makeLinuxPlatform);

const macosPlatformLayer = Layer.effect(
  Platform,
  Effect.gen(function* () {
    const services = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();
    return makeMacosPlatform((...runArguments) =>
      runCommand(...runArguments).pipe(Effect.provide(services)),
    );
  }),
);

export const platformLayer = Layer.unwrap(
  Effect.sync(
    (): Layer.Layer<
      Platform,
      PlatformUnsupported,
      ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
    > => {
      if (process.platform === "linux") {
        return linuxPlatformLayer;
      }
      if (process.platform === "darwin") {
        return macosPlatformLayer;
      }
      return Layer.effect(
        Platform,
        Effect.fail(new PlatformUnsupported({ platform: process.platform })),
      );
    },
  ),
);
