export const columns = (rows: readonly (readonly string[])[], gap = "  "): string => {
  const widths =
    rows[0]?.map((_heading, column) => Math.max(...rows.map((row) => row[column]?.length ?? 0))) ??
    [];
  return rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column] ?? 0))
        .join(gap)
        .trimEnd(),
    )
    .join("\n");
};
