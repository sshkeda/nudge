import { Data } from "effect"

export class UsageError extends Data.TaggedError("UsageError")<{ message: string }> {
  constructor(message: string) {
    super({ message })
  }
}
