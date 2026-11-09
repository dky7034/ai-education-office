export interface Evidence {
  jobId: string; fileId: string; revision: number; sourceHash: string; sheetId: string; sheetName: string;
  headerRow: number; rowNumber: number; totalRows: number; rowPresent: boolean;
  cells: {index: number; letter: string; label: string; value: string; truncated: boolean; kind: "value" | "blank" | "formula" | "error"}[];
}
export const kinds = {value: "저장값", blank: "공란", formula: "수식 · 계산하지 않음", error: "셀 오류"};
export function parseEvidence(value: unknown, jobId: string, fileId: string, revision: number, sourceHash: string, row: number, sheetId: string, headerRow: number, columns: readonly number[]): Evidence {
  const e = (value as {evidence?: Evidence})?.evidence;
  if (!e || e.jobId !== jobId || e.fileId !== fileId || e.revision !== revision || e.sourceHash !== sourceHash
    || e.rowNumber !== row || e.headerRow !== headerRow || e.sheetId !== sheetId || e.headerRow < 1 || e.headerRow > 20 || row <= e.headerRow || !Number.isInteger(e.totalRows) || row > e.totalRows || e.totalRows > 20000
    || typeof e.sheetName !== "string" || e.sheetName.length > 120 || typeof e.sheetId !== "string" || typeof e.rowPresent !== "boolean"
    || !Array.isArray(e.cells) || !e.cells.length || e.cells.length > 100
    || !e.cells.every((cell) => cell && Number.isInteger(cell.index) && cell.index >= 0 && cell.index < 100 && /^[A-Z]{1,2}$/.test(cell.letter)
      && typeof cell.label === "string" && cell.label.length <= 120 && typeof cell.value === "string" && Array.from(cell.value).length <= 2000
      && typeof cell.truncated === "boolean" && Object.hasOwn(kinds, cell.kind))
    || new Set(e.cells.map((c) => c.index)).size !== e.cells.length
    || e.cells.length !== columns.length || e.cells.some((c) => !columns.includes(c.index))) throw new Error("자료 행 응답을 확인하지 못했습니다. 다시 조회해 주세요.");
  return e;
}
