import { Effect } from "effect";
import { Command } from "effect/cli";

import { Output } from "../shared/output.ts";
import { trusted } from "../shared/report.ts";
import { checkInstallation, describeInstallation } from "./check-installation.ts";
import { FAILED_EXIT_CODE, jsonFlag } from "./command-arguments.ts";
import { FailureReported } from "./errors.ts";

export const doctorCommand = Command.make(
  "doctor",
  { json: jsonFlag },
  Effect.fn("nudge.doctor")(function* () {
    const output = yield* Output;
    const rows = yield* checkInstallation;
    const described = describeInstallation(rows, output.audience);
    yield* output.print({
      shown: trusted(described.shown),
      json: { action: "doctor", ...described.json },
    });
    if (described.json.status !== "ok") {
      return yield* new FailureReported({ exitCode: FAILED_EXIT_CODE });
    }
  }),
).pipe(
  Command.withDescription(
    "Check nudge's setup, and print how to fix what isn't. It changes nothing.",
  ),
);
