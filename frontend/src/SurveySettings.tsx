export interface QuestionDraft {
  index: number;
  min: string;
  max: string;
  required: boolean;
}
export default function SurveySettings({
  columns,
  questions,
  onChange,
  disabled,
}: {
  columns: { index: number; letter: string; label: string }[];
  questions: QuestionDraft[];
  onChange: (value: QuestionDraft[]) => void;
  disabled: boolean;
}) {
  return (
    <fieldset disabled={disabled} className="survey-settings">
      <legend>설문 문항·척도 설정 (선택)</legend>
      <p className="session-note">
        설문 문항으로 쓸 열을 지정하세요. 정수 척도는 양 끝값을 포함하며
        -1,000,000~1,000,000 사이로 설정합니다. 필수 문항은 유효값이 필요하고
        선택 문항은 공란을 허용합니다. 모든 문항에 잘못된 값이 없고 최소 한
        문항에 유효값이 있는 행만 유효 응답 행입니다. 날짜·식별자를 문항으로
        지정하지 마세요.
      </p>
      {columns.map((c) => {
        const q = questions.find((q) => q.index === c.index),
          name = `${c.letter} · ${c.label}`;
        const update = (patch: Partial<QuestionDraft>) =>
          onChange(
            questions.map((item) =>
              item.index === c.index ? { ...item, ...patch } : item,
            ),
          );
        return (
          <div
            className="survey-question"
            role="group"
            aria-label={`${c.letter}열 문항 설정`}
            key={c.index}
          >
            <label>
              <input
                type="checkbox"
                checked={!!q}
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? [
                          ...questions,
                          {
                            index: c.index,
                            min: "1",
                            max: "5",
                            required: true,
                          },
                        ]
                      : questions.filter((q) => q.index !== c.index),
                  )
                }
              />{" "}
              {name} 설문 문항으로 사용
            </label>
            {q && (
              <div className="survey-fields">
                <label>
                  척도 최솟값
                  <input
                    aria-label={`${c.letter}열 척도 최솟값`}
                    type="number"
                    min={-1000000}
                    max={1000000}
                    step="1"
                    value={q.min}
                    onChange={(e) => update({ min: e.target.value })}
                  />
                </label>
                <label>
                  척도 최댓값
                  <input
                    aria-label={`${c.letter}열 척도 최댓값`}
                    type="number"
                    min={-1000000}
                    max={1000000}
                    step="1"
                    value={q.max}
                    onChange={(e) => update({ max: e.target.value })}
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={q.required}
                    onChange={(e) => update({ required: e.target.checked })}
                  />{" "}
                  필수 응답
                </label>
              </div>
            )}
          </div>
        );
      })}
    </fieldset>
  );
}
