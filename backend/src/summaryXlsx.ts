import type { Readable } from "node:stream";
import { ZipFile } from "yazl";
import type { summarize } from "./summary.ts";
import { PreviewError } from "./tabular.ts";
import { NUMERIC_RULE } from "./numericSummary.ts";
import { SURVEY_RULE } from "./survey.ts";
export const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const MAX_XLSX_BYTES = 20 * 1024 * 1024;
export const VALUE_CHUNK_LENGTH = 32000;
interface ExportMeta {
  jobId: string;
  fileId: string;
  filename: string;
  sourceHash: string;
  revision: number;
  calculatedAt: string;
  runId?: string;
}
// Escape literal OOXML escape patterns first. Then encode XML-forbidden code units and CR.
// Keep tab/LF and valid surrogate pairs, including astral characters at chunk boundaries.
export function spreadsheetText(value: string) {
  return value
    .replace(/_x[0-9a-fA-F]{4}_/g, (match) => "_x005F_" + match.slice(1))
    .replace(
      /[\u0000-\u0008\u000B-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
      (c) =>
        "_x" +
        c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0") +
        "_",
    )
    .replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&apos;",
        })[c]!,
    );
}
export function valueChunks(value: string) {
  const chunks: string[] = [];
  for (let start = 0; start < value.length; ) {
    let end = Math.min(start + VALUE_CHUNK_LENGTH, value.length);
    if (
      end < value.length &&
      /[\uD800-\uDBFF]/.test(value[end - 1]!) &&
      /[\uDC00-\uDFFF]/.test(value[end]!)
    )
      end--;
    chunks.push(value.slice(start, end));
    start = end;
  }
  return chunks.length ? chunks : [""];
}
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const letter = (index: number) => {
  let value = index + 1,
    out = "";
  while (value) {
    value--;
    out = String.fromCharCode(65 + (value % 26)) + out;
    value = Math.floor(value / 26);
  }
  return out;
};
type Cell = string | number | null;
export async function summaryXlsx(
  summary: ReturnType<typeof summarize>,
  meta: ExportMeta,
  limits: { xmlBytes?: number; archiveBytes?: number } = {},
) {
  const maxXml = limits.xmlBytes ?? MAX_XLSX_BYTES,
    maxArchive = limits.archiveBytes ?? MAX_XLSX_BYTES;
  const entries: { name: string; bytes: Buffer }[] = [];
  let xmlSize = 0;
  const encode = (value: string) => {
    const bytes = Buffer.from(value);
    xmlSize += bytes.length;
    if (xmlSize > maxXml)
      throw new PreviewError(
        "XLSX 결과 XML이 20MiB를 초과했습니다. 선택 열이나 원본 데이터를 줄여 주세요.",
      );
    return bytes;
  };
  const add = (name: string, value: string) =>
    entries.push({ name, bytes: encode(value) });
  const sheets: { name: string; id: number }[] = [];
  function sheet(
    name: string,
    headers: string[],
    populate: (row: (cells: Cell[]) => void) => void,
  ) {
    const id = sheets.length + 1;
    sheets.push({ name, id });
    const parts = [
      encode(
        `${XML}<worksheet xmlns="${NS}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${headers.map((_, i) => `<col min="${i + 1}" max="${i + 1}" width="${i === 1 ? 45 : 22}" customWidth="1"/>`).join("")}</cols><sheetData>`,
      ),
    ];
    let rows = 0;
    const row = (cells: Cell[]) => {
      rows++;
      if (rows > 1048576)
        throw new PreviewError("XLSX 시트의 행 한도를 초과했습니다.");
      const content = cells
        .map((value, i) => {
          const r = letter(i) + rows,
            s = rows === 1 ? 1 : 0;
          if (value === null) return "";
          if (typeof value === "number") {
            if (!Number.isSafeInteger(value) || value < 0)
              throw new PreviewError("XLSX 건수를 확인해 주세요.");
            return `<c r="${r}" s="${s}" t="n"><v>${value}</v></c>`;
          }
          if (value.length > 32767)
            throw new PreviewError("XLSX 셀 길이 한도를 초과했습니다.");
          return `<c r="${r}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${spreadsheetText(value)}</t></is></c>`;
        })
        .join("");
      parts.push(encode(`<row r="${rows}">${content}</row>`));
    };
    row(headers);
    populate(row);
    parts.push(
      encode(
        `</sheetData><autoFilter ref="A1:${letter(headers.length - 1)}${rows}"/></worksheet>`,
      ),
    );
    entries.push({
      name: `xl/worksheets/sheet${id}.xml`,
      bytes: Buffer.concat(parts),
    });
  }
  sheet("집계 안내", ["항목", "내용"], (row) => {
    for (const [name, value] of [
      ["업무 ID", meta.jobId],
      ["원본 파일 ID", meta.fileId],
      ["원본 파일명", meta.filename],
      ["원본 SHA-256", meta.sourceHash],
      ["선택 버전", meta.revision],
      ["생성 시각(UTC)", meta.calculatedAt],
      ["시트", summary.sheetName],
      ["제목 행", summary.headerRow],
    ] as const)
      row([name, value]);
    if (meta.runId) row(["집계 작업 ID", meta.runId]);
    for (const rule of [
      NUMERIC_RULE,
      SURVEY_RULE,
      "선택한 시트·제목 행·열의 전체 데이터입니다. 선택 열이 모두 공란인 행은 제외합니다. 행 수는 고유 응답자 수가 아닙니다.",
      "일반 값은 앞뒤 공백만 제거합니다. 대소문자·숫자 표기·내부 공백은 유지합니다. XLSX 수식·오류 셀은 별도 건수이며 실행하거나 캐시 결과를 사용하지 않습니다.",
      "숫자·날짜는 원본 저장값, 불리언은 표시 문자열입니다. 숨김 시트·행·열도 포함될 수 있습니다.",
      "전체 빈도는 상위 30개·200자 표시 제한 없이 보존합니다. 긴 값은 최대 32,000 UTF-16 단위로 나눕니다. 같은 열·항목 번호의 조각을 순서대로 이어 붙이면 원문입니다.",
      "빈도 건수·원문 문자 수는 첫 조각에만 기록합니다. 원문 문자 수는 앞뒤 공백 제거 후 UTF-16 길이입니다.",
      "원본 유래 값과 정밀도 보존용 계산값은 텍스트 셀입니다. 수식·외부 링크·매크로를 생성하지 않습니다. 건수는 숫자 셀입니다.",
      "이 파일은 생성 시점의 결과입니다. 원본·설정·업무 상태를 바꾸지 않으며 AI 해석·자동 평가·발송은 수행하지 않습니다.",
      summary.survey
        ? "설문 문항 시트는 저장한 설정에 따른 별도 집계입니다."
        : "설문 설정이 없어 설문 문항 시트는 제목 행만 표시합니다.",
    ])
      row(["집계 기준", rule]);
  });
  sheet("전체 요약", ["항목", "건수"], (row) => {
    row(["제목 이후 전체 행", summary.totalRows]);
    row(["집계 포함 행", summary.includedRows]);
    row(["선택 열 공란 제외 행", summary.excludedRows]);
    if (summary.survey) {
      row(["유효 응답 행", summary.survey.validRows]);
      row(["기준 미충족 행", summary.survey.invalidRows]);
    }
  });
  sheet(
    "열별 집계",
    [
      "열",
      "열 제목",
      "일반 값",
      "누락",
      "수식 제외",
      "오류 제외",
      "서로 다른 일반 값",
      "숫자 인정",
      "숫자 아닌 일반 값",
      "숫자 범위 초과",
      "합계",
      "평균",
      "최솟값",
      "최댓값",
    ],
    (row) => {
      for (const c of summary.columns)
        row([
          c.letter,
          c.label,
          c.valueCount,
          c.missingCount,
          c.formulaCount,
          c.errorCount,
          c.distinctCount,
          c.numeric.count,
          c.numeric.nonNumericCount,
          c.numeric.outOfRangeCount,
          c.numeric.sum,
          c.numeric.mean,
          c.numeric.min,
          c.numeric.max,
        ]);
    },
  );
  sheet(
    "설문 문항",
    [
      "열",
      "열 제목",
      "척도 최솟값",
      "척도 최댓값",
      "응답 기준",
      "유효값",
      "누락",
      "수식 제외",
      "오류 제외",
      "숫자 아님",
      "정수 아님",
      "범위 밖",
      "유효값 합계",
      "유효값 평균",
      "유효값 최솟값",
      "유효값 최댓값",
    ],
    (row) => {
      for (const q of summary.survey?.questions ?? [])
        row([
          q.letter,
          q.label,
          String(q.min),
          String(q.max),
          q.required ? "필수" : "선택",
          q.validCount,
          q.missingCount,
          q.formulaCount,
          q.errorCount,
          q.nonNumericCount,
          q.nonIntegerCount,
          q.outOfRangeCount,
          q.sum,
          q.mean,
          q.minValue,
          q.maxValue,
        ]);
    },
  );
  sheet(
    "전체 빈도",
    [
      "열",
      "열 제목",
      "항목 번호",
      "값",
      "건수",
      "원문 문자 수",
      "분할 조각 번호",
      "조각 수",
    ],
    (row) => {
      for (const c of summary.columns) {
        if (
          c.otherCount ||
          c.otherDistinctCount ||
          c.frequencies.some((e) => e.valueTruncated)
        )
          throw new PreviewError(
            "전체 빈도를 읽지 못해 XLSX 생성을 중단했습니다.",
          );
        c.frequencies.forEach((entry, index) => {
          const parts = valueChunks(entry.value);
          parts.forEach((part, chunk) =>
            row([
              c.letter,
              c.label,
              index + 1,
              part,
              chunk === 0 ? entry.count : null,
              chunk === 0 ? entry.value.length : null,
              chunk + 1,
              parts.length,
            ]),
          );
        });
      }
    },
  );
  add(
    "xl/workbook.xml",
    `${XML}<workbook xmlns="${NS}" xmlns:r="${REL}"><sheets>${sheets.map((s) => `<sheet name="${s.name}" sheetId="${s.id}" r:id="rId${s.id}"/>`).join("")}</sheets></workbook>`,
  );
  add(
    "xl/_rels/workbook.xml.rels",
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s) => `<Relationship Id="rId${s.id}" Type="${REL}/worksheet" Target="worksheets/sheet${s.id}.xml"/>`).join("")}<Relationship Id="styles" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
  );
  add(
    "_rels/.rels",
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  add(
    "[Content_Types].xml",
    `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((s) => `<Override PartName="/xl/worksheets/sheet${s.id}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`,
  );
  add(
    "xl/styles.xml",
    `${XML}<styleSheet xmlns="${NS}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF28583E"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
  );
  const zip = new ZipFile();
  // yazl exposes a Node PassThrough; its legacy declaration only lists ReadableStream.
  const output = zip.outputStream as Readable;
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    output.on("error", reject);
    output.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxArchive) {
        output.destroy(
          new PreviewError(
            "XLSX 파일이 20MiB를 초과했습니다. 선택 열이나 원본 데이터를 줄여 주세요.",
          ),
        );
        return;
      }
      chunks.push(chunk);
    });
    output.on("end", () => resolve(Buffer.concat(chunks, size)));
    for (const entry of entries) zip.addBuffer(entry.bytes, entry.name);
    zip.end();
  });
}
