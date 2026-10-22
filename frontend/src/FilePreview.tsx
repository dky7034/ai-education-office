import { useEffect, useRef, useState } from "react";
import SurveySettings, { type QuestionDraft } from "./SurveySettings";
import BackgroundSummary from "./BackgroundSummary";
import FileSummary from "./FileSummary";
import { ApiError, jobsApi } from "./jobsApi";
interface Selection {
  questions: { index: number; min: number; max: number; required: boolean }[];
  sheetId: string;
  headerRow: number;
  columns: number[];
  revision: number;
  sourceHash: string;
  updatedAt: string;
}
interface Preview {
  sheets: { id: string; name: string }[];
  sheetId: string;
  headerRow: number;
  columns: { index: number; letter: string; label: string }[];
  rows: { rowNumber: number; values: string[] }[];
  totalRows: number;
  dataRows: number;
  rowsTruncated: boolean;
  cellsTruncated: boolean;
  warnings: string[];
}
interface Result {
  preview: Preview;
  selection: Selection | null;
}
export default function FilePreview({
  jobId,
  fileId,
  accountId,
  onUnauthorized,
  onActivityChange,
}: {
  jobId: string;
  fileId: string;
  accountId: string;
  onUnauthorized: () => void;
  onActivityChange?: () => void;
}) {
  const [result, setResult] = useState<Result | null>(null);
  const [sheetId, setSheetId] = useState<string | null>(null),
    [headerRow, setHeaderRow] = useState<number | null>(null);
  const [questions, setQuestions] = useState<QuestionDraft[]>([]);
  const [chosen, setChosen] = useState<number[]>([]);
  const [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [version, setVersion] = useState(0),
    [dirty, setDirty] = useState(false);
  const alive = useRef(true),
    controller = useRef(new AbortController());
  const base = `/${jobId}/attachments/${fileId}`;
  const headers = { "X-Office-Account": accountId };
  function fail(e: unknown) {
    if (!alive.current) return;
    if (e instanceof ApiError && e.status === 401) onUnauthorized();
    setError(
      e instanceof Error ? e.message : "미리보기를 불러오지 못했습니다.",
    );
  }
  useEffect(() => {
    alive.current = true;
    controller.current = new AbortController();
    return () => {
      alive.current = false;
      controller.current.abort();
    };
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError("");
    setNotice("");
    setResult(null);
    const query = new URLSearchParams();
    if (sheetId !== null) query.set("sheetId", sheetId);
    if (headerRow !== null) query.set("headerRow", String(headerRow));
    jobsApi<Result>(`${base}/preview?${query}`, {
      headers,
      signal: abort.signal,
    })
      .then((data) => {
        if (abort.signal.aborted) return;
        setResult(data);
        const selected = data.selection;
        setChosen(
          selected?.sheetId === data.preview.sheetId &&
            selected.headerRow === data.preview.headerRow
            ? selected.columns
            : [],
        );
        setQuestions(
          selected?.sheetId === data.preview.sheetId &&
            selected.headerRow === data.preview.headerRow
            ? selected.questions.map((q) => ({
                ...q,
                min: String(q.min),
                max: String(q.max),
              }))
            : [],
        );
        setDirty(false);
      })
      .catch((e) => {
        if (!abort.signal.aborted) fail(e);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [jobId, fileId, accountId, sheetId, headerRow, version]);
  async function save() {
    if (!result || saving || !chosen.length || loading) return;
    if (
      questions.some(
        (q) =>
          q.min.trim() === "" ||
          q.max.trim() === "" ||
          !Number.isSafeInteger(Number(q.min)) ||
          !Number.isSafeInteger(Number(q.max)) ||
          Number(q.min) < -1000000 ||
          Number(q.max) > 1000000 ||
          Number(q.min) > Number(q.max),
      )
    ) {
      setError(
        "문항 척도의 최솟값·최댓값을 -1,000,000~1,000,000 사이의 정수로 확인해 주세요.",
      );
      return;
    }
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await jobsApi<{ selection: Selection }>(
        `${base}/selection`,
        {
          method: "PUT",
          headers,
          signal: controller.current.signal,
          body: JSON.stringify({
            sheetId: result.preview.sheetId,
            headerRow: result.preview.headerRow,
            columns: chosen,
            questions: questions.map((q) => ({
              ...q,
              min: Number(q.min),
              max: Number(q.max),
            })),
            revision: result.selection?.revision ?? 0,
          }),
        },
      );
      if (!alive.current) return;
      setResult({ ...result, selection: response.selection });
      setDirty(false);
      setNotice(
        "분석할 열 선택을 저장했습니다. 자동 집계·AI 분석은 실행되지 않습니다.",
      );
    } catch (e) {
      fail(e);
    } finally {
      if (alive.current) setSaving(false);
    }
  }
  return (
    <section className="file-preview" aria-label="파일 내용 미리보기·열 선택">
      <h4>파일 내용 미리보기·열 선택</h4>
      <p className="session-note">
        원본을 수정하지 않습니다. 제목 행과 분석할 열을 직접 확인해 주세요.
        선택을 저장해도 분석은 실행되지 않습니다.
      </p>
      {loading && <p role="status">파일 내용을 불러오는 중입니다.</p>}
      {error && (
        <p className="request-error" role="alert">
          {error}
        </p>
      )}
      <button
        className="text-button"
        disabled={loading || saving}
        onClick={() => {
          setSheetId(null);
          setHeaderRow(null);
          setVersion((v) => v + 1);
        }}
      >
        저장 상태 다시 불러오기
      </button>
      {result && (
        <>
          <fieldset disabled={saving || loading} className="preview-controls">
            <div className="preview-control">
              <label htmlFor={`sheet-${fileId}`}>시트</label>
              <select
                id={`sheet-${fileId}`}
                value={result.preview.sheetId}
                onChange={(e) => {
                  setSheetId(e.target.value);
                  setHeaderRow(result.preview.headerRow);
                  setNotice("");
                }}
              >
                {result.preview.sheets.map((sheet) => (
                  <option key={sheet.id} value={sheet.id}>
                    {sheet.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="preview-control">
              <label htmlFor={`header-${fileId}`}>제목 행</label>
              <select
                id={`header-${fileId}`}
                value={result.preview.headerRow}
                onChange={(e) => {
                  setSheetId(result.preview.sheetId);
                  setHeaderRow(Number(e.target.value));
                  setNotice("");
                }}
              >
                {Array.from(
                  { length: Math.min(20, result.preview.totalRows) },
                  (_, i) => (
                    <option key={i + 1} value={i + 1}>
                      {i + 1}행
                    </option>
                  ),
                )}
              </select>
            </div>
          </fieldset>
          <p className="session-note">
            마지막 행 위치 {result.preview.totalRows.toLocaleString("ko-KR")} ·
            제목 이후 {result.preview.dataRows.toLocaleString("ko-KR")}행(빈 행
            포함) · {result.preview.columns.length}열
          </p>
          <ul className="preview-notes">
            {result.preview.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
          <div
            className="preview-table-scroll"
            role="region"
            aria-label="파일 데이터 표"
            tabIndex={0}
          >
            <table>
              <caption>제목 다음 최대 20행 · 원본 행 번호</caption>
              <thead>
                <tr>
                  <th scope="col">행</th>
                  {result.preview.columns.map((column) => (
                    <th key={column.index} scope="col">
                      {column.letter} · {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.preview.rows.map((row) => (
                  <tr key={row.rowNumber}>
                    <th scope="row">{row.rowNumber}</th>
                    {result.preview.columns.map((column) => (
                      <td key={column.index}>
                        {row.values[column.index] || "—"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!result.preview.rows.length && (
            <p className="session-note">
              제목 행 이후 표시할 데이터가 없습니다.
            </p>
          )}
          <fieldset disabled={saving || loading} className="column-choices">
            <legend>분석할 열 · {chosen.length}개 선택</legend>
            {result.preview.columns.map((column) => (
              <label key={column.index}>
                <input
                  type="checkbox"
                  checked={chosen.includes(column.index)}
                  onChange={(e) => {
                    setChosen((previous) =>
                      e.target.checked
                        ? [...previous, column.index]
                        : previous.filter((index) => index !== column.index),
                    );
                    if (!e.target.checked)
                      setQuestions((previous) =>
                        previous.filter((q) => q.index !== column.index),
                      );
                    setDirty(true);
                    setNotice("");
                  }}
                />
                {column.letter} · {column.label}
              </label>
            ))}
          </fieldset>
          <SurveySettings
            columns={result.preview.columns.filter((c) =>
              chosen.includes(c.index),
            )}
            questions={questions}
            disabled={saving || loading}
            onChange={(value) => {
              setQuestions(value);
              setDirty(true);
              setNotice("");
            }}
          />
          <button
            className="secondary-button"
            disabled={saving || loading || !chosen.length}
            onClick={save}
          >
            {saving ? "열 선택 저장 중…" : "열 선택 저장"}
          </button>
          {dirty && (
            <p className="session-note">
              저장하지 않은 열 선택·설문 설정이 있습니다. 시트·제목 행 변경이나
              다시 불러오기는 현재 선택을 초기화합니다.
            </p>
          )}
          <BackgroundSummary
            onActivityChange={onActivityChange}
            jobId={jobId}
            fileId={fileId}
            accountId={accountId}
            revision={result.selection?.revision ?? null}
            canSubmit={
              !!result.selection &&
              !dirty &&
              result.selection.sheetId === result.preview.sheetId &&
              result.selection.headerRow === result.preview.headerRow
            }
            onUnauthorized={onUnauthorized}
          />
          {result.selection &&
          !dirty &&
          result.selection.sheetId === result.preview.sheetId &&
          result.selection.headerRow === result.preview.headerRow ? (
            <FileSummary
              key={result.selection.revision}
              jobId={jobId}
              fileId={fileId}
              accountId={accountId}
              revision={result.selection.revision}
              onUnauthorized={onUnauthorized}
            />
          ) : (
            <p className="session-note">
              기초 집계를 실행하려면 분석할 열을 선택해 먼저 저장해 주세요.
            </p>
          )}
          {result.selection && (
            <p className="session-note">
              최근 저장:{" "}
              {new Date(result.selection.updatedAt).toLocaleString("ko-KR")} ·
              버전 {result.selection.revision}
            </p>
          )}
        </>
      )}
      {notice && (
        <p className="request-success" role="status">
          {notice}
        </p>
      )}
    </section>
  );
}
