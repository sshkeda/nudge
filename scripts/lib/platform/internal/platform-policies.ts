import { Effect, Option } from "effect";

import {
  installCommandLineTools,
  installLinuxPackages,
  installLinuxCodexArchive,
  installMacosCodexArchive,
} from "./platform-install.ts";
import { bypassesFilePermissions, claudeKeychainLogin } from "./platform-safety.ts";

export const policies = {
  linux: {
    processStartFormat: /^\d+$/u,
    pidDomainFormat: /^linux:[\da-f]*:(?:pid:\[\d+\])?$/u,
    installedCodexVersion: () => `dpkg-query -W -f='\${Version}' chatgpt`,
    installCodexArchive: installLinuxCodexArchive,
    requiredCommands: [
      {
        missing: "Xvfb, dbus-run-session or waitpid isn't installed",
        command: "command -v Xvfb && command -v dbus-run-session && command -v waitpid",
      },
    ],
    installPrerequisites: installLinuxPackages,
    codexConfigReplacements: (lines: readonly string[]) => lines,
    claudeKeychainLogin: Effect.succeed(Option.none<string>()),
    bypassesFilePermissions,
    prepareDisplay: <Success, Failure, Services>(
      display: Effect.Effect<Success, Failure, Services>,
    ) => display,
    runWatchLimit: <Success, Failure, Services>(test: Effect.Effect<Success, Failure, Services>) =>
      test,
  },
  macos: {
    processStartFormat: /^\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/u,
    pidDomainFormat: /^darwin$/u,
    installedCodexVersion: (app: string) =>
      `defaults read ${app}/Contents/Info.plist CFBundleShortVersionString`,
    installCodexArchive: installMacosCodexArchive,
    requiredCommands: [],
    installPrerequisites: installCommandLineTools,
    codexConfigReplacements: () => [],
    claudeKeychainLogin,
    bypassesFilePermissions: Effect.succeed(false),
    prepareDisplay: () => Effect.void,
    runWatchLimit: () => Effect.void,
  },
} as const;
