import { expect } from "bun:test"

import { Effect } from "effect"

import { testEffect } from "../../support.ts"

let timeoutFinalized = false
let failureFinalized = false

testEffect(
  "deliberate timeout with slow cleanup",
  Effect.acquireRelease(Effect.void, () =>
    Effect.sleep(1300).pipe(
      Effect.andThen(
        Effect.sync(() => {
          timeoutFinalized = true
        })
      )
    )
  ).pipe(Effect.andThen(Effect.never)),
  50
)

testEffect(
  "the next test observes completed timeout cleanup",
  Effect.sync(() => expect(timeoutFinalized).toBe(true))
)

testEffect(
  "deliberate assertion failure",
  Effect.acquireRelease(Effect.void, () =>
    Effect.sync(() => {
      failureFinalized = true
    })
  ).pipe(Effect.andThen(Effect.sync(() => expect("actual").toBe("expected"))))
)

testEffect(
  "the next test observes completed failure cleanup",
  Effect.sync(() => expect(failureFinalized).toBe(true))
)
