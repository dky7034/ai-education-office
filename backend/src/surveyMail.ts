import { createHash } from "node:crypto";
import { RunError, type SummaryRun } from "./runStore.ts";
import { SURVEY_RULE } from "./survey.ts";

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const invalid = () => new RunError(409, "설문 초안을 만들 수 없습니다. 완료된 설문 집계 결과와 저장 상태를 확인해 주세요.");
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown): value is string => typeof value === "string" && value.length <= 100000;
const label = (value: string) => {
  const characters = Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " "));
  return JSON.stringify(characters.slice(0, 160).join("") + (characters.length > 160 ? "…[표시 생략]" : ""));
};
const decimal = (value: unknown) => typeof value === "string" && value.length <= 120 && /^-?\d+(?:\.\d{1,6})?$/.test(value);

/** Derived plain text only. No AI, recipients, sending, new artifact, review decision or raw response values. */
export function surveyMail(summary: unknown, run: SummaryRun, byteLimit = 128 * 1024) {
  if (run.status !== "completed" || !record(summary) || summary.revision !== run.revision || summary.sourceHash !== run.sourceHash
    || !/^[a-f0-9]{64}$/.test(run.sourceHash) || !text(summary.sheetName)
    || typeof summary.calculatedAt !== "string" || summary.calculatedAt.length > 32 || !Number.isFinite(Date.parse(summary.calculatedAt))
    || !count(summary.totalRows) || !count(summary.includedRows) || !count(summary.excludedRows)
    || summary.includedRows + summary.excludedRows !== summary.totalRows
    || !record(summary.survey) || !count(summary.survey.validRows) || !count(summary.survey.invalidRows)
    || summary.survey.validRows + summary.survey.invalidRows !== summary.includedRows
    || !Array.isArray(summary.survey.questions) || !summary.survey.questions.length || summary.survey.questions.length > 100)
    throw invalid();
  const questions: string[] = [], indexes = new Set<number>();
  for (const q of summary.survey.questions) {
    const fields = ["validCount", "missingCount", "formulaCount", "errorCount", "nonNumericCount", "nonIntegerCount", "outOfRangeCount"];
    if (!record(q) || !count(q.index) || q.index > 99 || indexes.has(q.index) || !text(q.label)
      || typeof q.letter !== "string" || !/^[A-Z]{1,2}$/.test(q.letter) || typeof q.required !== "boolean"
      || !Number.isSafeInteger(q.min) || !Number.isSafeInteger(q.max) || (q.min as number) < -1000000
      || (q.max as number) > 1000000 || (q.min as number) > (q.max as number)
      || !fields.every((field) => count(q[field])) || fields.reduce((sum, field) => sum + (q[field] as number), 0) !== summary.includedRows
      || ![q.sum, q.mean, q.minValue, q.maxValue].every((value) => q.validCount === 0 ? value === null : decimal(value))) throw invalid();
    indexes.add(q.index);
    questions.push(
      `${q.letter}열 ${label(q.label)} · ${q.min}~${q.max} 정수 · ${q.required ? "필수" : "선택"}`,
      `  유효값 ${q.validCount}개 · 누락 ${q.missingCount}개 · 수식 ${q.formulaCount}개 · 오류 ${q.errorCount}개 · 숫자 아님 ${q.nonNumericCount}개 · 정수 아님 ${q.nonIntegerCount}개 · 범위 밖 ${q.outOfRangeCount}개`,
      q.validCount === 0 ? "  유효값 없음 · 합계/평균/최솟값/최댓값 계산 불가" :
        `  유효값 합계 ${q.sum} · 평균 ${q.mean} · 최솟값 ${q.minValue} · 최댓값 ${q.maxValue}`,
    );
  }
  const hash = createHash("sha256").update(JSON.stringify(summary)).digest("hex");
  const lines = [
    "제목: [검수 필요] 설문 집계 결과 공유 초안", "", "[규칙 기반 초안 · AI 생성 아님 · 자동 발송 없음]", "",
    "안녕하세요. 저장된 설문 집계 결과를 공유드립니다.",
    `분석 시트: ${label(summary.sheetName)}`,
    `제목 이후 전체 ${summary.totalRows}행 중 집계 포함 ${summary.includedRows}행, 선택 열 전체 공란으로 제외 ${summary.excludedRows}행입니다.`,
    `설문 기준 유효 응답 ${summary.survey.validRows}행, 기준 미충족 ${summary.survey.invalidRows}행입니다. 행 수는 고유 응답자 수가 아닙니다.`,
    "", "문항별 집계", ...questions,
    "", "집계 기준", SURVEY_RULE,
    "문항 평균은 각 문항의 모든 유효값 기준이며 유효 응답 행만의 평균이 아닙니다. 평균은 소수점 이하 최대 6자리로 반올림합니다.",
    "수치에 대한 만족도·성과·원인 해석은 포함하지 않았습니다.",
    "", "공유 전 확인", "수신자·공유 범위·열 제목의 개인정보와 수치·척도·필수 기준을 확인하고 문구를 수정하세요.",
    "이 초안은 승인 또는 발송 기록이 아니며, 내려받아도 검토 결정이 바뀌지 않습니다.",
    "", "작성 근거", `업무 ${run.jobId} · 첨부 ${run.fileId} · 실행 ${run.id}`, `저장 선택 버전 ${run.revision} · 집계 시각 ${new Date(summary.calculatedAt).toISOString()}`,
    `원본 SHA-256 ${run.sourceHash}`, `현재 저장 집계 JSON SHA-256 ${hash}`,
    "현재 설정으로 다시 집계한 결과가 아닙니다. 원본·보관 파일의 현재 무결성이나 과거 검토의 유효성을 증명하지 않습니다.", "",
  ];
  const bytes = Buffer.from("\ufeff" + lines.join("\r\n"), "utf8");
  if (bytes.length > byteLimit) throw new RunError(409, "설문 메일 초안이 출력 한도 128KiB를 초과했습니다.");
  return bytes;
}
