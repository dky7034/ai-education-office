import {
  parseDecimal,
  DECIMAL_SCALE,
  numericAccumulator,
} from "./numericSummary.ts";
import { PreviewError } from "./tabular.ts";
export interface SurveyQuestion {
  index: number;
  min: number;
  max: number;
  required: boolean;
}
export const SURVEY_RULE =
  "설정한 정수 척도의 양 끝값을 포함합니다. 필수 문항은 유효값이 필요하고, 선택 문항의 공란만 허용합니다. 잘못된 값이 없고 최소 한 문항이 유효한 행만 유효 응답 행입니다. 문항 통계는 행 전체의 유효 여부와 별개로 해당 문항의 모든 유효값을 집계합니다. 행 수는 고유 응답자 수가 아닙니다. 기존 기초·숫자 집계는 설문 기준으로 필터링하지 않습니다.";
export function surveyQuestions(
  value: unknown,
  columns: number[],
): SurveyQuestion[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > columns.length)
    throw new PreviewError("설문 문항 설정을 확인해 주세요.");
  const indexes = new Set<number>();
  for (const q of value) {
    if (
      !q ||
      typeof q !== "object" ||
      Array.isArray(q) ||
      Object.keys(q).some(
        (k) => !["index", "min", "max", "required"].includes(k),
      ) ||
      !Number.isInteger(q.index) ||
      !columns.includes(q.index) ||
      indexes.has(q.index) ||
      !Number.isSafeInteger(q.min) ||
      !Number.isSafeInteger(q.max) ||
      q.min < -1000000 ||
      q.max > 1000000 ||
      q.min > q.max ||
      typeof q.required !== "boolean"
    )
      throw new PreviewError(
        "문항은 선택한 열마다 하나씩 지정하고 -1,000,000~1,000,000 사이의 정수 척도와 필수 여부를 확인해 주세요.",
      );
    indexes.add(q.index);
  }
  return value
    .map((q) => ({
      index: q.index,
      min: q.min,
      max: q.max,
      required: q.required,
    }))
    .sort((a, b) => a.index - b.index);
}
export function surveyAccumulator(questions: SurveyQuestion[]) {
  const stats = questions.map((q) => ({
    ...q,
    validCount: 0,
    missingCount: 0,
    formulaCount: 0,
    errorCount: 0,
    nonNumericCount: 0,
    nonIntegerCount: 0,
    outOfRangeCount: 0,
    numeric: numericAccumulator(),
  }));
  let validRows = 0,
    invalidRows = 0;
  return {
    add(
      values: string[],
      flags: { formulas: Set<number>; errors: Set<number> },
    ) {
      let valid = true,
        answered = false;
      for (const s of stats) {
        const value = (values[s.index] ?? "").trim();
        if (flags.formulas.has(s.index)) {
          s.formulaCount++;
          valid = false;
        } else if (flags.errors.has(s.index)) {
          s.errorCount++;
          valid = false;
        } else if (!value) {
          s.missingCount++;
          if (s.required) valid = false;
        } else {
          const parsed = parseDecimal(value);
          if (parsed === "nonNumeric") {
            s.nonNumericCount++;
            valid = false;
          } else if (parsed === "outOfRange") {
            s.outOfRangeCount++;
            valid = false;
          } else if (parsed % DECIMAL_SCALE !== 0n) {
            s.nonIntegerCount++;
            valid = false;
          } else if (
            parsed < BigInt(s.min) * DECIMAL_SCALE ||
            parsed > BigInt(s.max) * DECIMAL_SCALE
          ) {
            s.outOfRangeCount++;
            valid = false;
          } else {
            s.validCount++;
            s.numeric.add(value);
            answered = true;
          }
        }
      }
      if (valid && answered) validRows++;
      else invalidRows++;
    },
    result(columns: { index: number; letter: string; label: string }[]) {
      return questions.length
        ? {
            validRows,
            invalidRows,
            questions: stats.map(({ numeric, ...s }) => {
              const column = columns.find((c) => c.index === s.index)!;
              const n = numeric.result();
              return {
                ...s,
                letter: column.letter,
                label: column.label,
                sum: n.sum,
                mean: n.mean,
                minValue: n.min,
                maxValue: n.max,
              };
            }),
          }
        : null;
    },
  };
}
