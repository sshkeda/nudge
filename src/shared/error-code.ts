import { Schema } from "effect";

const ErrorCode = Schema.Struct({ code: Schema.String });

export const codeOf = (error: Error) => (Schema.is(ErrorCode)(error) ? error.code : undefined);
