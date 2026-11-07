import { Schema } from "effect";

export class SetUpRefused extends Schema.TaggedError<SetUpRefused>()("SetUpRefused", {
  file: Schema.String,
}) {
  public override get message() {
    return `${this.file} already exists, and set-up-fresh-machine.ts never overwrites a file\nhint: Run it in a fresh machine, or move ${this.file} away first`;
  }
}
