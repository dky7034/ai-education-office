import { SaxesParser } from "saxes";
import { XMLParser } from "fast-xml-parser";
import { posix } from "node:path";
import { csvRows } from "./csv.ts";

export const LIMITS = {
  rows: 20000,
  columns: 100,
  cells: 100000,
  sampleRows: 20,
  cellChars: 200,
  headerRows: 20,
} as const;
export class PreviewError extends Error {}
export interface Sheet {
  id: string;
  name: string;
}
interface SampleRow {
  rowNumber: number;
  values: string[];
}
export interface TablePreview {
  sheets: Sheet[];
  sheetId: string;
  headerRow: number;
  columns: { index: number; letter: string; label: string }[];
  rows: SampleRow[];
  totalRows: number;
  dataRows: number;
  rowsTruncated: boolean;
  cellsTruncated: boolean;
  warnings: string[];
}
export const letter = (index: number) => {
  let value = index + 1,
    result = "";
  while (value > 0) {
    value--;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
};
function sax(xml: string, bind: (parser: SaxesParser) => void) {
  const parser = new SaxesParser({ xmlns: false });
  parser.on("doctype", () => {
    throw new PreviewError("DTD가 있는 XML은 지원하지 않습니다.");
  });
  bind(parser);
  parser.write(xml).close();
}
function strings(xml?: string) {
  const result: string[] = [];
  if (!xml) return result;
  let value = "",
    inItem = false,
    inText = false,
    phonetic = false;
  sax(xml, (parser) => {
    parser.on("opentag", (tag) => {
      if (tag.name === "si") {
        inItem = true;
        value = "";
      }
      if (tag.name === "rPh") phonetic = true;
      if (tag.name === "t" && inItem && !phonetic) inText = true;
    });
    const append = (text: string) => {
      if (inText) value += text;
    };
    parser.on("text", append);
    parser.on("cdata", append);
    parser.on("closetag", (tag) => {
      if (tag.name === "t") inText = false;
      if (tag.name === "rPh") phonetic = false;
      if (tag.name === "si") {
        if (result.length >= LIMITS.cells)
          throw new PreviewError(
            "공유 문자열이 너무 많아 미리보기를 열 수 없습니다.",
          );
        result.push(value);
        inItem = false;
      }
    });
  });
  return result;
}
export interface CellFlags {
  formulas: Set<number>;
  errors: Set<number>;
}
const emptyFlags = (): CellFlags => ({
  formulas: new Set(),
  errors: new Set(),
});
function xlsxRows(
  xml: string,
  shared: string[],
  accept: (number: number, values: string[], flags: CellFlags) => void,
) {
  let rowNumber = 0,
    currentRow = 0,
    values: string[] = [],
    inCell = false,
    capture = false;
  let flags = emptyFlags();
  let type = "",
    raw = "",
    formula = false,
    column = -1,
    cellCount = 0;
  sax(xml, (parser) => {
    parser.on("opentag", (tag) => {
      const a = tag.attributes as Record<string, string>;
      if (tag.name === "row") {
        currentRow = a.r ? Number(a.r) : rowNumber + 1;
        if (
          !Number.isInteger(currentRow) ||
          currentRow <= rowNumber ||
          currentRow > LIMITS.rows
        )
          throw new PreviewError(
            "미리보기는 순서대로 기록된 최대 20,000행까지 지원합니다.",
          );
        rowNumber = currentRow;
        values = [];
        flags = emptyFlags();
        column = -1;
      }
      if (tag.name === "c") {
        if (!currentRow || ++cellCount > LIMITS.cells)
          throw new PreviewError(
            "미리보기는 최대 100,000개 셀까지 지원합니다.",
          );
        const match = a.r?.match(/^([A-Z]+)([1-9][0-9]*)$/);
        let next = column + 1;
        if (a.r) {
          if (!match || Number(match[2]) !== currentRow)
            throw new PreviewError("셀 주소를 읽을 수 없습니다.");
          next =
            [...match[1]!].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) -
            1;
        }
        if (next <= column || next >= LIMITS.columns)
          throw new PreviewError(
            "미리보기는 순서대로 기록된 최대 100열까지 지원합니다.",
          );
        column = next;
        type = a.t ?? "n";
        raw = "";
        formula = false;
        inCell = true;
      }
      if (inCell && tag.name === "f") formula = true;
      if (inCell && (tag.name === "v" || tag.name === "t")) capture = true;
    });
    const append = (text: string) => {
      if (capture) raw += text;
    };
    parser.on("text", append);
    parser.on("cdata", append);
    parser.on("closetag", (tag) => {
      if (tag.name === "v" || tag.name === "t") capture = false;
      if (tag.name === "c") {
        let value = raw;
        if (formula) {
          value = "[수식: 계산하지 않음]";
          flags.formulas.add(column);
        } else if (type === "s") {
          const index = Number(raw);
          if (
            !/^\d+$/.test(raw) ||
            !Number.isSafeInteger(index) ||
            shared[index] === undefined
          )
            throw new PreviewError("공유 문자열 참조를 읽을 수 없습니다.");
          value = shared[index]!;
        } else if (type === "b")
          value = raw === "1" ? "TRUE" : raw === "0" ? "FALSE" : raw;
        else if (type === "e") {
          value = "[셀 오류] " + raw;
          flags.errors.add(column);
        }
        values[column] = value;
        inCell = false;
      }
      if (tag.name === "row") {
        accept(currentRow, values, flags);
        currentRow = 0;
      }
    });
  });
}
export function scanTable(
  format: "csv" | "xlsx",
  data: Buffer,
  xml: Map<string, string> | null,
  sheetId: string | undefined,
  headerRow: number,
  onRow: (rowNumber: number, values: string[], flags: CellFlags) => void,
) {
  if (
    !Number.isInteger(headerRow) ||
    headerRow < 1 ||
    headerRow > LIMITS.headerRows
  )
    throw new PreviewError("제목 행은 1~20 중 선택해 주세요.");
  const parser = new XMLParser({
    ignoreAttributes: false,
    processEntities: false,
    parseAttributeValue: false,
  });
  let sheets: Sheet[] = [{ id: "csv", name: "CSV" }],
    paths = new Map<string, string>();
  if (format === "xlsx") {
    const workbook = parser.parse(xml!.get("xl/workbook.xml")!).workbook;
    const relations = [
      parser.parse(xml!.get("xl/_rels/workbook.xml.rels")!).Relationships
        .Relationship,
    ].flat();
    sheets = [workbook.sheets.sheet].flat().map((s, index) => {
      const id = String(index),
        relation = relations.find((r) => r["@_Id"] === s["@_r:id"]);
      const target = relation["@_Target"] as string;
      paths.set(
        id,
        target.startsWith("/")
          ? target.slice(1)
          : posix.normalize("xl/" + target),
      );
      return { id, name: String(s["@_name"]).slice(0, 120) };
    });
  }
  const selected = sheetId ?? sheets[0]!.id;
  if (!sheets.some((s) => s.id === selected))
    throw new PreviewError("선택한 시트를 찾을 수 없습니다.");
  let totalRows = 0,
    width = 0,
    cells = 0;
  let header: string[] = [];
  const accept = (rowNumber: number, values: string[], flags: CellFlags) => {
    cells += values.length;
    if (
      rowNumber > LIMITS.rows ||
      values.length > LIMITS.columns ||
      cells > LIMITS.cells
    )
      throw new PreviewError(
        "파일 처리 한도(20,000행·100열·100,000셀)를 초과했습니다. 작은 파일로 나눠 주세요.",
      );
    totalRows = rowNumber;
    width = Math.max(width, values.length);
    if (rowNumber === headerRow) header = values;
    if (rowNumber > headerRow) onRow(rowNumber, values, flags);
  };
  try {
    if (format === "csv") {
      let row = 0;
      for (const values of csvRows(data, LIMITS.columns))
        accept(++row, values, emptyFlags());
    } else
      xlsxRows(
        xml!.get(paths.get(selected)!)!,
        strings(xml!.get("xl/sharedStrings.xml")),
        accept,
      );
  } catch (error) {
    if (error instanceof PreviewError) throw error;
    throw new PreviewError(
      error instanceof Error ? error.message : "표 내용을 읽을 수 없습니다.",
    );
  }
  if (headerRow > totalRows || !width)
    throw new PreviewError("선택한 제목 행이 없거나 시트가 비어 있습니다.");
  return {
    sheets,
    sheetId: selected,
    headerRow,
    totalRows,
    columns: Array.from({ length: width }, (_, index) => ({
      index,
      letter: letter(index),
      label: (header[index] || "제목 없음").slice(0, 120),
    })),
  };
}

export function tablePreview(
  format: "csv" | "xlsx",
  data: Buffer,
  xml: Map<string, string> | null,
  sheetId?: string,
  headerRow = 1,
): TablePreview {
  let cellsTruncated = false;
  const rows: SampleRow[] = [];
  const table = scanTable(
    format,
    data,
    xml,
    sheetId,
    headerRow,
    (rowNumber, values) => {
      if (rowNumber > headerRow + LIMITS.sampleRows) return;
      rows.push({
        rowNumber,
        values: Array.from({ length: values.length }, (_, index) => {
          const value = values[index] ?? "";
          if (value.length > LIMITS.cellChars) cellsTruncated = true;
          return value.slice(0, LIMITS.cellChars);
        }),
      });
    },
  );
  const { totalRows } = table;
  const byRow = new Map(rows.map((row) => [row.rowNumber, row]));
  const sample: SampleRow[] = [];
  for (
    let number = headerRow + 1;
    number <= Math.min(totalRows, headerRow + LIMITS.sampleRows);
    number++
  )
    sample.push(byRow.get(number) ?? { rowNumber: number, values: [] });
  const warnings = [
    "첫 20개 데이터 행만 표시합니다. 셀은 200자, 열 제목은 120자까지 표시합니다.",
  ];
  if (format === "xlsx")
    warnings.push(
      "수식·매크로·외부 연결은 실행하지 않습니다. 숫자·날짜는 원본 저장값이며 서식·병합 셀은 재현하지 않습니다. 숨김 시트·행·열도 포함될 수 있습니다.",
    );
  return {
    ...table,
    rows: sample,
    totalRows,
    dataRows: Math.max(0, totalRows - headerRow),
    rowsTruncated: totalRows - headerRow > sample.length,
    cellsTruncated,
    warnings,
  };
}
