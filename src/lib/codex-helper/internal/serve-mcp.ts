import { Effect, Option, Result, Schema, Stdio, Stream } from "effect";

import { name, version } from "../../../../package.json" with { type: "json" };
import { linePrinter, toOneLine } from "../../../shared/print-line.ts";

const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

const PARSE_ERROR = -32_700;

const METHOD_NOT_FOUND = -32_601;

const RequestId = Schema.Union([Schema.String, Schema.Int]);

const Message = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.optional(RequestId),
    method: Schema.String,
    params: Schema.optional(Schema.Struct({ protocolVersion: Schema.optional(Schema.String) })),
  }),
);

const Reply = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({
      jsonrpc: Schema.Literal("2.0"),
      id: Schema.NullOr(RequestId),
      result: Schema.Record(Schema.String, Schema.Json),
    }),
    Schema.Struct({
      jsonrpc: Schema.Literal("2.0"),
      id: Schema.NullOr(RequestId),
      error: Schema.Struct({ code: Schema.Int, message: Schema.String }),
    }),
  ]),
);

const decodeMessage = Schema.decodeResult(Message);

const encodeReply = Schema.encodeResult(Reply);

const resultFor = (message: Omit<typeof Message.Type, "id">) => {
  switch (message.method) {
    case "initialize": {
      return Option.some({
        protocolVersion: message.params?.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name, version },
      });
    }
    case "tools/list": {
      return Option.some({ tools: [] });
    }
    case "ping": {
      return Option.some({});
    }
    default: {
      return Option.none();
    }
  }
};

const JSON_RPC_VERSION = "2.0" as const;

const replyTo = (line: string): Option.Option<typeof Reply.Type> =>
  Result.match(decodeMessage(line), {
    onFailure: (error) =>
      Option.some({
        jsonrpc: JSON_RPC_VERSION,
        id: null,
        error: { code: PARSE_ERROR, message: toOneLine(error.message) },
      }),
    onSuccess: ({ id, ...message }) =>
      id === undefined
        ? Option.none()
        : Option.some(
            Option.match(resultFor(message), {
              onNone: () => ({
                jsonrpc: JSON_RPC_VERSION,
                id,
                error: { code: METHOD_NOT_FOUND, message: `nudge has no method ${message.method}` },
              }),
              onSome: (result) => ({ jsonrpc: JSON_RPC_VERSION, id, result }),
            }),
          ),
  });

export const serveMcp = Effect.gen(function* () {
  const { printLine, printErrorLine } = yield* linePrinter;
  yield* (yield* Stdio.Stdio).stdin.pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.runForEach((line) =>
      Option.match(replyTo(line), {
        onNone: () => Effect.void,
        onSome: (reply) =>
          Result.match(encodeReply(reply), {
            onFailure: (error) => printErrorLine(`error: ${toOneLine(error.message)}`),
            onSuccess: (text) => printLine(text),
          }),
      }),
    ),
  );
});
