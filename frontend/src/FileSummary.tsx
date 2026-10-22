import { useEffect, useRef, useState } from "react";
import { jobsApi, ApiError } from "./jobsApi";
interface Summary {
  revision: number;
  sourceHash: string;
  calculatedAt: string;
  sheetName: string;
  headerRow: number;
  totalRows: number;
  includedRows: number;
  excludedRows: number;
  columns: {
    index: number;
    letter: string;
    label: string;
    valueCount: number;
    missingCount: number;
    formulaCount: number;
    errorCount: number;
    distinctCount: number;
    otherDistinctCount: number;
    otherCount: number;
    frequencies: { value: string; valueTruncated: boolean; count: number }[];
  }[];
}
export default function FileSummary({
  jobId,
  fileId,
  accountId,
  revision,
  onUnauthorized,
}: {
  jobId: string;
  fileId: string;
  accountId: string;
  revision: number;
  onUnauthorized: () => void;
}) {
  const [summary, setSummary] = useState<Summary | null>(null),
    [busy, setBusy] = useState(false),
    [exporting, setExporting] = useState<"csv" | "html" | null>(null),
    [error, setError] = useState("");
  const alive = useRef(true),
    abort = useRef(new AbortController());
  useEffect(() => {
    alive.current = true;
    abort.current = new AbortController();
    return () => {
      alive.current = false;
      abort.current.abort();
    };
  }, []);
  async function run() {
    if (busy || exporting) return;
    setBusy(true);
    setError("");
    setSummary(null);
    try {
      const data = await jobsApi<{ summary: Summary }>(
        `/${jobId}/attachments/${fileId}/summary`,
        {
          method: "POST",
          headers: { "X-Office-Account": accountId },
          signal: abort.current.signal,
          body: JSON.stringify({ revision }),
        },
      );
      if (alive.current) setSummary(data.summary);
    } catch (e) {
      if (!alive.current) return;
      if (e instanceof ApiError && e.status === 401) onUnauthorized();
      setError(
        e instanceof Error ? e.message : "집계 결과를 불러오지 못했습니다.",
      );
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function download(format: "csv" | "html") {
    if (busy || exporting || !summary) return;
    setExporting(format);
    setError("");
    try {
      const response = await fetch(
        `/api/jobs/${jobId}/attachments/${fileId}/summary.${format}`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            "X-Office-Request": "1",
            "X-Office-Account": accountId,
          },
          signal: abort.current.signal,
          body: JSON.stringify({ revision }),
        },
      );
      if (!response.ok) {
        const data = await response.json();
        throw new ApiError(data.error, response.status);
      }
      if (
        !response.headers
          .get("content-type")
          ?.includes(format === "html" ? "text/html" : "text/csv")
      )
        throw new Error();
      const blob = await response.blob();
      if (!alive.current) return;
      const url = URL.createObjectURL(blob),
        link = document.createElement("a");
      link.href = url;
      link.download = `office-summary-${fileId}.${format}`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (error) {
      if (!alive.current) return;
      if (error instanceof ApiError && error.status === 401) onUnauthorized();
      if (error instanceof ApiError && error.status === 409) setSummary(null);
      setError(
        error instanceof ApiError
          ? error.message
          : "파일을 내려받지 못했습니다. 연결을 확인하고 다시 시도해 주세요.",
      );
    } finally {
      if (alive.current) setExporting(null);
    }
  }
  return (
    <section className="file-summary" aria-label="선택 열 기초 집계">
      <h4>선택 열 기초 집계</h4>
      <p className="session-note">
        저장한 선택 버전 {revision}의 전체 데이터를 집계합니다. 미리보기 20행을
        넘어 계산하며, 원본과 선택 설정은 바꾸지 않습니다. 결과는 새로고침 후
        다시 실행해 확인해 주세요.
      </p>
      <details className="summary-rules">
        <summary>집계 기준 확인</summary>
        <ul>
          <li>
            선택한 열이 모두 공란인 행은 제외합니다. 나머지 행에서 열별 누락을
            셉니다. 행 수는 응답자 수가 아닙니다.
          </li>
          <li>
            값 앞뒤 공백을 제거해 비교합니다. 대소문자·숫자 표기 차이는 유지하며
            빈 값은 빈도에서 제외합니다.
          </li>
          <li>
            XLSX 수식·오류 셀은 별도 건수로 표시하고 빈도에 넣지 않습니다. CSV
            수식 모양의 값은 실행하지 않고 문자로 셉니다.
          </li>
          <li>
            빈도 상위 30개와 나머지 합계를 표시합니다. 긴 값은 표시만 200자로
            줄이며 서로 다른 원문을 합치지 않습니다.
          </li>
        </ul>
      </details>
      <button
        className="primary-button"
        disabled={busy || exporting !== null}
        onClick={run}
      >
        {busy ? "집계 중…" : "전체 데이터 집계"}
      </button>
      {busy && (
        <p role="status">저장한 원본과 열 선택을 확인해 집계하고 있습니다.</p>
      )}
      {error && (
        <p className="request-error" role="alert">
          {error}
        </p>
      )}
      {summary && (
        <div className="summary-results" aria-label="기초 집계 결과">
          <button
            className="secondary-button"
            disabled={busy || exporting !== null}
            onClick={() => download("csv")}
          >
            {exporting === "csv" ? "CSV 생성 중…" : "전체 빈도 CSV 다운로드"}
          </button>
          <button
            className="secondary-button"
            disabled={busy || exporting !== null}
            onClick={() => download("html")}
          >
            {exporting === "html"
              ? "보고서 생성 중…"
              : "인쇄용 HTML 보고서 다운로드"}
          </button>
          <p className="session-note">
            HTML 보고서는 브라우저에서 열어 인쇄하거나 PDF로 저장할 수 있습니다.
            그래프 상위 10개·빈도 상위 30개를 포함합니다.
          </p>
          <p className="session-note">
            저장한 원본과 선택 버전을 다시 확인해 전체 빈도를 내보냅니다. 수식
            주입을 막기 위해 CSV 텍스트 앞에는 작은따옴표가 추가됩니다.
          </p>
          <p className="session-note">
            {summary.sheetName} · 제목 {summary.headerRow}행 · 선택 버전{" "}
            {summary.revision} ·{" "}
            {new Date(summary.calculatedAt).toLocaleString("ko-KR")}
          </p>
          <dl className="summary-counts">
            <dt>제목 이후 전체 행</dt>
            <dd>{summary.totalRows.toLocaleString("ko-KR")}행</dd>
            <dt>집계 포함 행</dt>
            <dd>{summary.includedRows.toLocaleString("ko-KR")}행</dd>
            <dt>선택 열 모두 공란으로 제외</dt>
            <dd>{summary.excludedRows.toLocaleString("ko-KR")}행</dd>
          </dl>
          {summary.includedRows === 0 && (
            <p role="status">선택한 열에 집계할 값이 없습니다.</p>
          )}
          {summary.columns.map((column) => (
            <section
              className="column-summary"
              key={column.index}
              aria-label={`${column.letter}열 집계`}
            >
              <h5>
                {column.letter} · {column.label}
              </h5>
              <dl className="summary-counts">
                <dt>일반 값</dt>
                <dd>{column.valueCount}개</dd>
                <dt>누락</dt>
                <dd>{column.missingCount}개</dd>
                <dt>수식 제외</dt>
                <dd>{column.formulaCount}개</dd>
                <dt>오류 제외</dt>
                <dd>{column.errorCount}개</dd>
                <dt>서로 다른 일반 값</dt>
                <dd>{column.distinctCount}개</dd>
              </dl>
              {column.frequencies.length > 0 && (
                <div
                  className="frequency-chart"
                  aria-label={`${column.letter}열 빈도 그래프`}
                >
                  <p className="session-note">
                    일반 값 {column.valueCount}개 중 상위 최대 10개 ·
                    누락·수식·오류 제외
                  </p>
                  <ol>
                    {column.frequencies.slice(0, 10).map((entry, index) => (
                      <li key={index}>
                        <div className="frequency-label">
                          <span>
                            {entry.value}
                            {entry.valueTruncated && "… (표시 줄임)"}
                          </span>
                          <strong>
                            {entry.count}건 ·{" "}
                            {(column.valueCount
                              ? (entry.count / column.valueCount) * 100
                              : 0
                            ).toFixed(1)}
                            %
                          </strong>
                        </div>
                        <div className="frequency-track" aria-hidden="true">
                          <div
                            style={{
                              width: `${column.valueCount ? (entry.count / column.valueCount) * 100 : 0}%`,
                            }}
                          />
                        </div>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
              <div
                className="preview-table-scroll"
                role="region"
                aria-label={`${column.letter}열 값별 빈도`}
                tabIndex={0}
              >
                <table>
                  <caption>{column.letter}열 일반 값 빈도 · 최대 30개</caption>
                  <thead>
                    <tr>
                      <th scope="col">항목</th>
                      <th scope="col">값</th>
                      <th scope="col">건수</th>
                    </tr>
                  </thead>
                  <tbody>
                    {column.frequencies.map((entry, index) => (
                      <tr key={index}>
                        <th scope="row">{index + 1}</th>
                        <td>
                          {entry.value}
                          {entry.valueTruncated && <small>… (표시 줄임)</small>}
                        </td>
                        <td>{entry.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {column.otherDistinctCount > 0 && (
                <p className="session-note">
                  나머지 {column.otherDistinctCount}종의 값: 총{" "}
                  {column.otherCount}건
                </p>
              )}
              {!column.frequencies.length && (
                <p className="session-note">
                  빈도를 표시할 일반 값이 없습니다.
                </p>
              )}
            </section>
          ))}
          <p className="session-note">
            정량 기초 집계 결과입니다. AI 해석·교육생 평가 점수·자동 발송은
            생성하지 않습니다.
          </p>
        </div>
      )}
    </section>
  );
}
