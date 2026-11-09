import { scanTable, PreviewError, type CellFlags } from "./tabular.ts";
import type { ColumnSelection } from "./store.ts";
export const EVIDENCE_CELL_CHARS = 2000;
export function rowEvidence(format: "csv" | "xlsx", bytes: Buffer, xml: Map<string, string> | null,
  selection: ColumnSelection, rowNumber: number) {
  if (!Number.isInteger(rowNumber) || rowNumber <= selection.headerRow || rowNumber > 20000)
    throw new PreviewError("제목 행 다음부터 20,000행 이내의 자료 행을 지정해 주세요.");
  const indexes = [...selection.columns].sort((a, b) => a - b);
  if (!indexes.length || indexes.length > 100 || new Set(indexes).size !== indexes.length
    || indexes.some((index) => !Number.isInteger(index) || index < 0 || index >= 100)) throw new PreviewError("저장된 열 선택을 확인해 주세요.");
  let values: string[] = [], flags: CellFlags = {formulas: new Set(), errors: new Set()}, rowPresent = false;
  const table = scanTable(format, bytes, xml, selection.sheetId, selection.headerRow, (number, data, types) => {
    if (number === rowNumber) { values = data; flags = types; rowPresent = true; }
  });
  if (rowNumber > table.totalRows) throw new PreviewError("파일에 없는 행입니다. 마지막 자료 행 번호를 확인해 주세요.");
  const cells = indexes.map((index) => {
    const column = table.columns.find((column) => column.index === index);
    if (!column) throw new PreviewError("파일에 없는 열은 확인할 수 없습니다.");
    const raw = values[index] ?? "", characters = Array.from(raw);
    return {...column, value: characters.slice(0, EVIDENCE_CELL_CHARS).join(""), truncated: characters.length > EVIDENCE_CELL_CHARS,
      kind: flags.formulas.has(index) ? "formula" as const : flags.errors.has(index) ? "error" as const : !raw.trim() ? "blank" as const : "value" as const};
  });
  const result = {sheetId: table.sheetId, sheetName: table.sheets.find((sheet) => sheet.id === table.sheetId)!.name,
    headerRow: selection.headerRow, rowNumber, totalRows: table.totalRows, rowPresent, cells};
  if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024) throw new PreviewError("자료 행 응답이 1MiB 한도를 초과했습니다. 선택 열을 줄여 주세요.");
  return result;
}
