export interface SurveyResult {
  validRows: number;
  invalidRows: number;
  questions: {
    index: number;
    letter: string;
    label: string;
    min: number;
    max: number;
    required: boolean;
    validCount: number;
    missingCount: number;
    formulaCount: number;
    errorCount: number;
    nonNumericCount: number;
    nonIntegerCount: number;
    outOfRangeCount: number;
    sum: string | null;
    mean: string | null;
    minValue: string | null;
    maxValue: string | null;
  }[];
}
export default function SurveyResults({ survey }: { survey: SurveyResult }) {
  return (
    <section className="survey-results" aria-label="설문 기준 집계 결과">
      <h5>설문 기준 집계 결과</h5>
      <p className="session-note">
        설정한 정수 척도의 양 끝값을 포함합니다. 필수 문항은 유효값이 필요하고
        선택 문항은 공란을 허용합니다. 잘못된 값이 없고 최소 한 문항이 유효한
        행만 유효 응답 행입니다. 문항 통계는 행 전체의 유효 여부와 별개로 해당
        문항의 모든 유효값을 집계합니다. 행 수는 고유 응답자 수가 아닙니다. 기존
        기초·숫자 집계는 이 기준으로 필터링하지 않습니다.
      </p>
      <dl className="numeric-counts survey-row-counts">
        <dt>유효 응답 행</dt>
        <dd>{survey.validRows}행</dd>
        <dt>기준 미충족 행</dt>
        <dd>{survey.invalidRows}행</dd>
      </dl>
      {survey.questions.map((q) => (
        <div role="group" aria-label={`${q.letter}열 설문 집계`} key={q.index}>
          <h6>
            {q.letter} · {q.label} · {q.min}~{q.max} 정수 ·{" "}
            {q.required ? "필수" : "선택"}
          </h6>
          <dl className="numeric-counts">
            <dt>유효값</dt>
            <dd>{q.validCount}개</dd>
            <dt>누락</dt>
            <dd>{q.missingCount}개</dd>
            <dt>수식 제외</dt>
            <dd>{q.formulaCount}개</dd>
            <dt>오류 제외</dt>
            <dd>{q.errorCount}개</dd>
            <dt>숫자 아님</dt>
            <dd>{q.nonNumericCount}개</dd>
            <dt>정수 아님</dt>
            <dd>{q.nonIntegerCount}개</dd>
            <dt>범위 밖</dt>
            <dd>{q.outOfRangeCount}개</dd>
            <dt>유효값 합계</dt>
            <dd>{q.sum ?? "—"}</dd>
            <dt>유효값 평균</dt>
            <dd>{q.mean ?? "—"}</dd>
            <dt>유효값 최솟값</dt>
            <dd>{q.minValue ?? "—"}</dd>
            <dt>유효값 최댓값</dt>
            <dd>{q.maxValue ?? "—"}</dd>
          </dl>
        </div>
      ))}
    </section>
  );
}
