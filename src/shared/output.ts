import { Context, Effect, HashSet, Layer, Predicate, Ref, Schema } from "effect";

import { linePrinter } from "./print-line.ts";
import { prose, Report, trusted } from "./report.ts";
import type { Audience, Shown } from "./report.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

const printJsonLine = (
  print: Effect.Success<typeof linePrinter>["printLine"],
  value: Schema.Json,
) => Effect.flatMap(encodeJson(value), print);

const reportOf = (error: Error) => {
  const report = Predicate.hasProperty(error, "report") ? error.report : undefined;
  return report instanceof Report ? report : new Report({ message: prose`${error.message}` });
};

const make = (audience: typeof Audience.Type) =>
  Effect.gen(function* () {
    const { printLine, printErrorLine } = yield* linePrinter;
    const warned = yield* Ref.make(HashSet.empty<string>());
    const isJson = audience.mode === "json";
    const show = (shown: Shown) => shown.show(audience);

    const warn = (warning: Error) =>
      printErrorLine(`warning: ${show(reportOf(warning).parts.message)}`);

    return {
      isJson,
      audience,

      print: ({ shown, json }: { readonly shown: Shown; readonly json: Schema.Json }) =>
        isJson ? printJsonLine(printLine, json) : printLine(show(shown)),

      warn,

      warnOnce: ({ key, warning }: { readonly key: string; readonly warning: Error }) =>
        Ref.modify(warned, (keys) => [!HashSet.has(keys, key), HashSet.add(keys, key)]).pipe(
          Effect.flatMap((isFirst) => (isFirst ? warn(warning) : Effect.void)),
        ),

      fail: (
        failure: Error,
        added: {
          readonly hint?: string | null | undefined;
          readonly data?: Readonly<Record<string, Schema.Json>> | undefined;
        } = {},
      ) => {
        const { message, hint: ownHint, details, data } = reportOf(failure).parts;
        const addedHint = added.hint ?? null;
        const hint = addedHint === null ? ownHint : trusted(addedHint);
        if (isJson) {
          return printJsonLine(printErrorLine, {
            error: failure.name,
            message: show(message),
            hint: hint === undefined ? null : show(hint),
            ...data,
            ...added.data,
          });
        }
        return printErrorLine(
          [
            `error: ${show(message)}`,
            ...(details === undefined ? [] : ["", show(details), ""]),
            ...(hint === undefined ? [] : [`hint: ${show(hint)}`]),
          ].join("\n"),
        );
      },
    };
  });

export class Output extends Context.Service<Output, Effect.Success<ReturnType<typeof make>>>()(
  "nudge/Output",
) {}

export const outputLayerFor = (audience: typeof Audience.Type) =>
  Layer.effect(Output, make(audience));
