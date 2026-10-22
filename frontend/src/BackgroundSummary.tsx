import { useEffect, useRef, useState } from "react";
import { jobsApi, ApiError } from "./jobsApi";
import type { Summary } from "./FileSummary";
import SurveyResults from "./SurveyResults";
interface Run {
  id: string;
  revision: number;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  sourceHash: string;
}
interface RunPage {
  runs: Run[];
  page: { total: number; hasMore: boolean };
}
const names = {
  queued: "대기",
  running: "실행 중",
  completed: "완료",
  failed: "실패",
  cancelled: "취소됨",
};
export default function BackgroundSummary({
  jobId,
  fileId,
  accountId,
  revision,
  canSubmit,
  onUnauthorized,
}: {
  jobId: string;
  fileId: string;
  accountId: string;
  revision: number | null;
  canSubmit: boolean;
  onUnauthorized: () => void;
}) {
  const [data, setData] = useState<RunPage | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [offset, setOffset] = useState(0),
    [version, setVersion] = useState(0);
  const [stored, setStored] = useState<{ run: Run; summary: Summary } | null>(
    null,
  );
  const mounted = useRef(true),
    abort = useRef(new AbortController()),
    requestKey = useRef<string | null>(null);
  const base = `/${jobId}/attachments/${fileId}/runs`,
    headers = { "X-Office-Account": accountId };
  const unauthorized = useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;
  const fail = (e: unknown) => {
    if (!mounted.current) return;
    if (e instanceof DOMException && e.name === "AbortError") return;
    if (e instanceof ApiError && e.status === 401) unauthorized.current();
    setError(
      e instanceof Error ? e.message : "집계 작업을 확인하지 못했습니다.",
    );
  };
  useEffect(() => {
    mounted.current = true;
    abort.current = new AbortController();
    return () => {
      mounted.current = false;
      abort.current.abort();
    };
  }, []);
  useEffect(() => {
    requestKey.current = null;
  }, [revision]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const result = await jobsApi<RunPage>(
          `${base}?limit=20&offset=${offset}`,
          { headers, signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setData(result);
        if (
          result.runs.some(
            (r) => r.status === "queued" || r.status === "running",
          )
        )
          timer = setTimeout(load, 1000);
      } catch (e) {
        if (!controller.signal.aborted) fail(e);
      }
    };
    void load();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [base, accountId, offset, version]);
  async function enqueue() {
    if (busy || !canSubmit || revision === null) return;
    setBusy(true);
    setError("");
    requestKey.current ??= crypto.randomUUID();
    try {
      await jobsApi(base, {
        method: "POST",
        headers: { ...headers, "Idempotency-Key": requestKey.current },
        signal: abort.current.signal,
        body: JSON.stringify({ revision }),
      });
      if (!mounted.current) return;
      requestKey.current = null;
      setOffset(0);
      setVersion((v) => v + 1);
    } catch (e) {
      fail(e);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function cancel(run: Run) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await jobsApi(`${base}/${run.id}/cancel`, {
        method: "POST",
        headers,
        signal: abort.current.signal,
        body: "{}",
      });
      if (mounted.current) setVersion((v) => v + 1);
    } catch (e) {
      fail(e);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function result(run: Run) {
    if (busy) return;
    setBusy(true);
    setError("");
    setStored(null);
    try {
      const value = await jobsApi<{ summary: Summary }>(
        `${base}/${run.id}/result`,
        { headers, signal: abort.current.signal },
      );
      if (mounted.current) setStored({ run, summary: value.summary });
    } catch (e) {
      fail(e);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section className="background-summary" aria-label="백그라운드 집계 작업">
      <h4>백그라운드 집계 작업</h4>
      <p className="session-note">
        현재 저장한 파일·설정 버전으로 정량 집계를 접수합니다. 화면을 닫거나
        로그아웃해도 서버에서 계속 처리하며 AI는 호출하지 않습니다. 결과는 생성
        당시의 기록이며 현재 설정과 다를 수 있습니다. 파일 다운로드 버튼은 현재
        설정으로 다시 계산합니다.
      </p>
      <button
        className="secondary-button"
        disabled={busy || !canSubmit || revision === null}
        onClick={enqueue}
      >
        {busy ? "요청 처리 중…" : "백그라운드 집계 접수"}
      </button>
      <button
        className="text-button"
        disabled={busy}
        onClick={() => {
          setError("");
          setVersion((v) => v + 1);
        }}
      >
        작업 목록 새로고침
      </button>
      {!canSubmit && (
        <p className="session-note">
          작업을 접수하려면 현재 열·설문 설정을 먼저 저장해 주세요.
        </p>
      )}
      {error && (
        <p role="alert" className="request-error">
          {error}
        </p>
      )}
      {data && (
        <>
          <p className="session-note">
            집계 작업 {data.page.total}개 · 표시{" "}
            {data.runs.length ? offset + 1 : 0}~{offset + data.runs.length}
          </p>
          {!data.runs.length && (
            <p className="session-note">접수한 백그라운드 집계가 없습니다.</p>
          )}
          <ul className="summary-run-list">
            {data.runs.map((run) => (
              <li key={run.id} data-run-id={run.id}>
                <p>
                  <strong>{names[run.status]}</strong> · 선택 버전{" "}
                  {run.revision} ·{" "}
                  {new Date(run.createdAt).toLocaleString("ko-KR")}
                </p>
                <p className="session-note">
                  작업 ID: {run.id}
                  {run.startedAt && (
                    <>
                      {" "}
                      · 시작: {new Date(run.startedAt).toLocaleString("ko-KR")}
                    </>
                  )}
                  {run.finishedAt && (
                    <>
                      {" "}
                      · 종료: {new Date(run.finishedAt).toLocaleString("ko-KR")}
                    </>
                  )}
                </p>
                {run.error && <p className="request-error">{run.error}</p>}
                {(run.status === "queued" || run.status === "running") && (
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => cancel(run)}
                  >
                    집계 작업 취소
                  </button>
                )}
                {run.status === "completed" && (
                  <button
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => result(run)}
                  >
                    저장된 집계 결과 보기
                  </button>
                )}
              </li>
            ))}
          </ul>
          <div className="survey-fields">
            <button
              className="text-button"
              disabled={busy || offset === 0}
              onClick={() => setOffset(Math.max(0, offset - 20))}
            >
              이전 작업 목록
            </button>
            <button
              className="text-button"
              disabled={busy || !data.page.hasMore}
              onClick={() => setOffset(offset + 20)}
            >
              다음 작업 목록
            </button>
          </div>
        </>
      )}
      {stored && (
        <section
          className="stored-summary"
          aria-label="저장된 백그라운드 집계 결과"
        >
          <h5>저장된 집계 결과</h5>
          <p className="session-note">
            작업 {stored.run.id} · 선택 버전 {stored.run.revision} ·{" "}
            {new Date(stored.summary.calculatedAt).toLocaleString("ko-KR")} ·{" "}
            {stored.summary.sheetName} · 제목 {stored.summary.headerRow}행
          </p>
          <p className="session-note">원본 SHA-256: {stored.run.sourceHash}</p>
          <dl className="numeric-counts stored-row-counts">
            <dt>제목 이후 전체 행</dt>
            <dd>{stored.summary.totalRows}행</dd>
            <dt>집계 포함 행</dt>
            <dd>{stored.summary.includedRows}행</dd>
            <dt>공란 제외 행</dt>
            <dd>{stored.summary.excludedRows}행</dd>
          </dl>
          {stored.summary.survey && (
            <SurveyResults survey={stored.summary.survey} />
          )}
          {stored.summary.columns.map((c) => (
            <details key={c.index}>
              <summary>
                {c.letter} · {c.label} 집계 결과
              </summary>
              <dl className="numeric-counts">
                <dt>일반 값</dt>
                <dd>{c.valueCount}개</dd>
                <dt>누락</dt>
                <dd>{c.missingCount}개</dd>
                <dt>수식 제외</dt>
                <dd>{c.formulaCount}개</dd>
                <dt>오류 제외</dt>
                <dd>{c.errorCount}개</dd>
                <dt>숫자 인정</dt>
                <dd>{c.numeric.count}개</dd>
                <dt>숫자 아님</dt>
                <dd>{c.numeric.nonNumericCount}개</dd>
                <dt>숫자 범위 초과</dt>
                <dd>{c.numeric.outOfRangeCount}개</dd>
                <dt>합계</dt>
                <dd>{c.numeric.sum ?? "—"}</dd>
                <dt>평균</dt>
                <dd>{c.numeric.mean ?? "—"}</dd>
                <dt>최솟값</dt>
                <dd>{c.numeric.min ?? "—"}</dd>
                <dt>최댓값</dt>
                <dd>{c.numeric.max ?? "—"}</dd>
              </dl>
              <div
                className="preview-table-scroll"
                role="region"
                aria-label={`${c.letter}열 저장 빈도`}
                tabIndex={0}
              >
                <table>
                  <caption>
                    일반 값 상위 최대 30개 · 긴 값 최대 200자 표시
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">값</th>
                      <th scope="col">건수</th>
                    </tr>
                  </thead>
                  <tbody>
                    {c.frequencies.map((f, i) => (
                      <tr key={i}>
                        <td>
                          {f.value}
                          {f.valueTruncated && "… (표시 줄임)"}
                        </td>
                        <td>{f.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="session-note">
                서로 다른 값 {c.distinctCount}종 · 나머지 {c.otherDistinctCount}
                종 {c.otherCount}건
              </p>
            </details>
          ))}
          <p className="session-note">
            숫자는 부호·소수·지수 표기를 지원하며 쉼표·통화·퍼센트·날짜 문자는
            변환하지 않습니다. 정규화 후 정수부·소수부 각각 100자리까지
            지원합니다. 평균은 소수점 이하 최대 6자리 반올림입니다. XLSX 날짜
            숫자 저장값·숫자 모양 식별자도 포함될 수 있습니다. 행 수는 응답자
            수·평가 점수가 아닙니다.
          </p>
        </section>
      )}
    </section>
  );
}
