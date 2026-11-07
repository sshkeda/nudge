import { Effect, Schema } from "effect";

import { BUN } from "../../scripts/shared/codex-and-claude.ts";
import type { makeMachine } from "./machine-commands.ts";

const TRACES_UNDER_HOME = ".local/state/nudge/traces";

export const TRACES = `~/${TRACES_UNDER_HOME}`;

export const TODAYS_TRACES = `${TRACES}/$(date +%F).jsonl`;

export const ALL_TRACES = `${BUN} -e '
const directory = process.env.HOME + "/${TRACES_UNDER_HOME}";
const names = (await Array.fromAsync(new Bun.Glob("????-??-??.jsonl").scan(directory))).toSorted();
const texts = await Promise.all(names.map((name) => Bun.file(directory + "/" + name).text().catch((error) => (error.code === "ENOENT" ? "" : Promise.reject(error)))));
process.stdout.write(texts.join(""));'`;

const TraceAttribute = Schema.Struct({
  key: Schema.String,
  value: Schema.Struct({
    stringValue: Schema.optional(Schema.String),
    boolValue: Schema.optional(Schema.Boolean),
    intValue: Schema.optional(Schema.Int),
    arrayValue: Schema.optional(
      Schema.Struct({ values: Schema.Array(Schema.Struct({ stringValue: Schema.String })) }),
    ),
  }),
});

export const decodeTraceLine = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      resourceSpans: Schema.Array(
        Schema.Struct({
          resource: Schema.Struct({ attributes: Schema.Array(TraceAttribute) }),
          scopeSpans: Schema.Array(
            Schema.Struct({
              spans: Schema.Array(
                Schema.Struct({
                  traceId: Schema.String,
                  spanId: Schema.String,
                  name: Schema.String,
                  startTimeUnixNano: Schema.String,
                  endTimeUnixNano: Schema.String,
                  attributes: Schema.Array(TraceAttribute),
                }),
              ),
            }),
          ),
        }),
      ),
    }),
  ),
);

export const spansIn = (lines: string) =>
  Effect.map(
    Effect.forEach(
      lines.split("\n").filter((line) => line !== ""),
      (line) => decodeTraceLine(line),
    ),
    (traces) =>
      traces.flatMap((trace) =>
        trace.resourceSpans.flatMap((resourceSpan) =>
          resourceSpan.scopeSpans.flatMap((scopeSpan) => scopeSpan.spans),
        ),
      ),
  );

export const attributeOf = (
  span: Effect.Success<ReturnType<typeof spansIn>>[number],
  key: string,
) => span.attributes.find((attribute) => attribute.key === key)?.value.stringValue;

export const spansMentioning = ({
  machine,
  text,
}: {
  readonly machine: Effect.Success<typeof makeMachine>;
  readonly text: string;
}) =>
  Effect.flatMap(machine.shell(ALL_TRACES), (traces) =>
    spansIn(
      traces
        .split("\n")
        .filter((line) => line.includes(text))
        .join("\n"),
    ),
  );
