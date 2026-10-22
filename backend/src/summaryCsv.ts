import type { summarize } from "./summary.ts";
import { PreviewError } from "./tabular.ts";
export const MAX_EXPORT_BYTES = 20 * 1024 * 1024;
interface ExportMeta {
  jobId: string;
  fileId: string;
  filename: string;
  sourceHash: string;
  revision: number;
  calculatedAt: string;
}
// User-derived text is always prefixed, even when its current first character is harmless.
// Numbers are emitted only from server-computed counts, never from source cell strings.
const text = (value: string) => "'" + value;
const encode = (cells: (string | number)[]) =>
  cells
    .map((value) => '"' + String(value).replaceAll('"', '""') + '"')
    .join(",") + "\r\n";
export function summaryCsv(
  summary: ReturnType<typeof summarize>,
  meta: ExportMeta,
  byteLimit = MAX_EXPORT_BYTES,
) {
  const chunks: Buffer[] = [Buffer.from("\uFEFF")];
  let size = chunks[0]!.length;
  const add = (cells: (string | number)[]) => {
    const chunk = Buffer.from(encode(cells));
    size += chunk.length;
    if (size > byteLimit)
      throw new PreviewError(
        "CSV 결과가 20MiB를 초과했습니다. 선택 열이나 원본 데이터를 줄여 다시 시도해 주세요.",
      );
    chunks.push(chunk);
  };
  add(["구역", "열", "열 제목", "항목", "값", "건수", "설명", "원문 문자 수"]);
  const metadata = (label: string, value: string | number, isText = false) =>
    add([
      "메타데이터",
      "",
      "",
      label,
      isText ? text(String(value)) : value,
      "",
      "",
      "",
    ]);
  metadata("업무 ID", meta.jobId, true);
  metadata("원본 파일 ID", meta.fileId, true);
  metadata("원본 파일명", meta.filename, true);
  metadata("원본 SHA-256", meta.sourceHash, true);
  metadata("선택 버전", meta.revision);
  metadata("생성 시각(UTC)", meta.calculatedAt, true);
  metadata("시트", summary.sheetName, true);
  metadata("제목 행", summary.headerRow);
  for (const [label, count] of [
    ["제목 이후 전체 행", summary.totalRows],
    ["집계 포함 행", summary.includedRows],
    ["선택 열 공란 제외 행", summary.excludedRows],
  ] as const)
    add(["전체 요약", "", "", label, "", count, "", ""]);
  const rules = [
    "저장한 시트·제목 행·선택 열의 전체 데이터를 계산합니다. 행 수는 응답자 수가 아닙니다.",
    "선택 열이 모두 공란인 행은 제외합니다. 나머지 행에서 열별 누락을 셉니다.",
    "일반 값은 앞뒤 공백만 제거합니다. 대소문자·숫자 표기·내부 공백은 유지합니다.",
    "XLSX 수식·오류 셀은 별도로 세며 계산하거나 캐시 결과를 사용하지 않습니다. CSV 수식 모양은 문자열입니다.",
    "숫자·날짜는 원본 저장값, 불리언은 표시 문자열입니다. 숨김 시트·행·열도 포함될 수 있습니다.",
    "모든 빈도와 전체 값을 내보냅니다. 원문 문자 수는 집계 시 앞뒤 공백 제거 후 JavaScript UTF-16 길이입니다.",
    "수식 주입 방지를 위해 파일명·시트·열 제목·값 등 텍스트 앞에 작은따옴표를 추가했습니다. 원본 파일은 바꾸지 않습니다.",
    "자동 평가·AI 해석·메시지 발송은 수행하지 않습니다.",
  ];
  for (const rule of rules) add(["집계 기준", "", "", "", "", "", rule, ""]);
  for (const column of summary.columns) {
    const label = text(column.label);
    for (const [name, count] of [
      ["일반 값", column.valueCount],
      ["누락", column.missingCount],
      ["수식 제외", column.formulaCount],
      ["오류 제외", column.errorCount],
      ["서로 다른 일반 값", column.distinctCount],
    ] as const)
      add(["열 요약", column.letter, label, name, "", count, "", ""]);
    if (
      column.otherCount ||
      column.otherDistinctCount ||
      column.frequencies.some((entry) => entry.valueTruncated)
    )
      throw new PreviewError("전체 빈도를 읽지 못해 CSV 생성을 중단했습니다.");
    for (const entry of column.frequencies)
      add([
        "값별 빈도",
        column.letter,
        label,
        "일반 값",
        text(entry.value),
        entry.count,
        "",
        entry.value.length,
      ]);
  }
  return Buffer.concat(chunks, size);
}
