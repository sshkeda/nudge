import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Effect, FileSystem, Path, Schema } from "effect";
import { Reactivity } from "effect/reactivity";
import type { SqlError } from "effect/sql";

export const queryCodexDatabase = <RowSchema extends Schema.Top, Rows>({
  database,
  query,
  row,
}: {
  readonly database: string;
  readonly query: (sql: SqliteClient.SqliteClient) => Effect.Effect<Rows, SqlError.SqlError>;
  readonly row: RowSchema;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const isOpenForWriting = yield* fileSystem.exists(`${database}-wal`);
    const mode = isOpenForWriting ? "mode=ro" : "immutable=1";
    const url = yield* (yield* Path.Path).toFileUrl(database);
    const rows = yield* Effect.scoped(
      Effect.flatMap(SqliteClient.make({ filename: `${url.href}?${mode}`, readonly: true }), query),
    ).pipe(Effect.provideServiceEffect(Reactivity.Reactivity, Reactivity.make));
    return yield* Schema.decodeUnknownEffect(Schema.Array(row))(rows);
  });
