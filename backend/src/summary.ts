import { scanTable, PreviewError } from "./tabular.ts";
export const FREQUENCY_LIMIT = 30;
export interface SummaryInput {
  sheetId: string;
  headerRow: number;
  columns: number[];
}
export function summarize(
  format: "csv" | "xlsx",
  bytes: Buffer,
  xml: Map<string, string> | null,
  selection: SummaryInput,
  options: { fullValues?: boolean; frequencyLimit?: number } = {},
) {
  const indexes = [...selection.columns].sort((a, b) => a - b);
  if (
    !indexes.length ||
    new Set(indexes).size !== indexes.length ||
    indexes.some(
      (index) => !Number.isInteger(index) || index < 0 || index >= 100,
    )
  )
    throw new PreviewError("저장된 열 선택을 확인해 주세요.");
  const stats = indexes.map((index) => ({
    index,
    valueCount: 0,
    missingCount: 0,
    formulaCount: 0,
    errorCount: 0,
    frequencies: new Map<string, number>(),
  }));
  let includedRows = 0;
  const table = scanTable(
    format,
    bytes,
    xml,
    selection.sheetId,
    selection.headerRow,
    (_number, values, flags) => {
      const active = indexes.some(
        (index) =>
          flags.formulas.has(index) ||
          flags.errors.has(index) ||
          (values[index] ?? "").trim() !== "",
      );
      if (!active) return;
      includedRows++;
      for (const stat of stats) {
        const value = (values[stat.index] ?? "").trim();
        if (flags.formulas.has(stat.index)) stat.formulaCount++;
        else if (flags.errors.has(stat.index)) stat.errorCount++;
        else if (!value) stat.missingCount++;
        else {
          stat.valueCount++;
          stat.frequencies.set(value, (stat.frequencies.get(value) ?? 0) + 1);
        }
      }
    },
  );
  if (
    indexes.some(
      (index) => !table.columns.some((column) => column.index === index),
    )
  )
    throw new PreviewError("파일에 없는 열은 집계할 수 없습니다.");
  const totalRows = Math.max(0, table.totalRows - selection.headerRow);
  return {
    sheetId: table.sheetId,
    sheetName: table.sheets.find((s) => s.id === table.sheetId)!.name,
    headerRow: selection.headerRow,
    totalRows,
    includedRows,
    excludedRows: totalRows - includedRows,
    columns: stats.map((stat) => {
      const all = [...stat.frequencies].sort(
        (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
      );
      const shown = all.slice(0, options.frequencyLimit ?? FREQUENCY_LIMIT);
      const { frequencies: _frequencies, ...counts } = stat;
      const column = table.columns.find((c) => c.index === stat.index)!;
      return {
        ...counts,
        letter: column.letter,
        label: column.label,
        distinctCount: all.length,
        frequencies: shown.map(([value, count]) => ({
          value: options.fullValues ? value : value.slice(0, 200),
          valueTruncated: !options.fullValues && value.length > 200,
          count,
        })),
        otherDistinctCount: all.length - shown.length,
        otherCount:
          stat.valueCount - shown.reduce((sum, item) => sum + item[1], 0),
      };
    }),
  };
}
