import assert from "node:assert/strict";

import { Effect } from "effect";

import { machineTest, NUDGE } from "./machine-commands.ts";

export const checkingDoctorBeforeCodex = machineTest((machine) =>
  Effect.gen(function* () {
    const doctor = yield* machine.attempt(`${NUDGE} doctor`);
    assert.equal(doctor.code, 1, doctor.standardOutput);
    assert.match(doctor.standardOutput, /^ok: .* registers this nudge's MCP server$/mu);
    assert.match(doctor.standardOutput, /^error: Codex Desktop isn't running$/mu);
    assert.match(doctor.standardOutput, /^error: nudge's Codex helper doesn't answer at /mu);
  }),
);
