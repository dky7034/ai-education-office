import { useEffect, useRef, useState } from "react";
import { ApiError, jobsApi } from "./jobsApi";
import { AI_STATUS, AiProtocolError, aiActive, aiOutcome, aiUuid, parseAiDetail, parseAiPage, parseAiAdmission, parseAiCancel, parseAiText,
  type AiDetail, type AiPage, type AiRun, type AiText } from "./aiProtocol";
const date = (v: string) => new Date(v).toLocaleString("ko-KR");
const failure = (e: unknown) => e instanceof DOMException && e.name === "TimeoutError"
  ? "서버 응답 대기 시간을 초과했습니다. 기록을 조회한 뒤 다시 확인해 주세요."
  : e instanceof Error ? e.message : "AI 기록을 확인하지 못했습니다.";
const denied = (e: unknown) => e instanceof ApiError && [401, 403, 404].includes(e.status);
export default function AiRuns({ jobId, accountId, refreshKey, onUnauthorized }: {
  jobId: string; accountId: string; refreshKey: number; onUnauthorized: () => void;
}) {
  const base = `/${jobId}/ai-runs`, headers = { "X-Office-Account": accountId };
  const [offset, setOffset] = useState(0), [version, setVersion] = useState(0);
  const [page, setPage] = useState<{ offset: number; value: AiPage } | null>(null);
  const [loading, setLoading] = useState(true), [fresh, setFresh] = useState(false), [listError, setListError] = useState("");
  const [selected, setSelected] = useState<string | null>(() => {
    const value = new URLSearchParams(location.search).get("aiRun"); return aiUuid(value) ? value : null;
  });
  const [detail, setDetail] = useState<AiDetail | null>(null), [text, setText] = useState<{ id: string; value: AiText } | null>(null);
  const [detailError, setDetailError] = useState(""), [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false), [actionError, setActionError] = useState(""), [notice, setNotice] = useState("");
  const [retry, setRetry] = useState(false);
  const lock = useRef(false), lifetime = useRef(new AbortController()), requestKey = useRef<string | null>(null);
  const accessGeneration = useRef(0);
  const unauthorized = useRef(onUnauthorized); unauthorized.current = onUnauthorized;
  useEffect(() => {
    lifetime.current = new AbortController();
    return () => { lifetime.current.abort(); };
  }, []);
  function clearAccess() {
    accessGeneration.current++;
    setPage(null); setDetail(null); setText(null); setFresh(false);
    requestKey.current = null; setRetry(false);
  }
  const checkAuth = (e: unknown) => { if (e instanceof ApiError && e.status === 401) unauthorized.current(); };
  useEffect(() => {
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
    const generation = accessGeneration.current;
    setLoading(true); setFresh(false);
    void jobsApi<unknown>(`${base}?limit=20&offset=${offset}`, { headers, signal })
      .then((v) => {
        const next = parseAiPage(v, jobId, offset);
        if (!signal.aborted && generation === accessGeneration.current) { setPage({ offset, value: next }); setFresh(true); setListError(""); }
      }).catch((e) => {
        if (controller.signal.aborted || generation !== accessGeneration.current) return;
        checkAuth(e); setListError(failure(signal.aborted ? signal.reason : e));
        if (denied(e)) clearAccess();
      }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [base, accountId, offset, version, refreshKey]);
  useEffect(() => {
    if (!selected) { setDetail(null); setText(null); setDetailError(""); return; }
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
    const generation = accessGeneration.current;
    setDetailLoading(true);
    void (async () => {
      const next = parseAiDetail(await jobsApi(`${base}/${selected}`, { headers, signal }), jobId, selected);
      const stored = next.run.status === "completed" ? await parseAiText(
        await jobsApi(`${base}/${selected}/result`, { headers, signal }), next.run) : null;
      if (!signal.aborted && generation === accessGeneration.current) { setDetail(next); setText(stored ? { id: selected, value: stored } : null); setDetailError(""); }
    })().catch((e) => {
      if (controller.signal.aborted || generation !== accessGeneration.current) return;
      checkAuth(e); setDetailError(failure(signal.aborted ? signal.reason : e));
      if (denied(e)) clearAccess();
      else if (e instanceof AiProtocolError || (e instanceof ApiError && e.status === 409)) { setDetail(null); setText(null); }
    }).finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [base, accountId, selected, version, refreshKey]);
  const data = page?.offset === offset ? page.value : null;
  const view = detail?.run.id === selected ? detail : null;
  const stored = text?.id === selected ? text.value : null;
  useEffect(() => {
    if (!fresh || loading || listError || detailError || !(data?.runs.some(aiActive) || view && aiActive(view.run))) return;
    const timer = setTimeout(() => setVersion((v) => v + 1), 2000);
    return () => clearTimeout(timer);
  }, [data, view, fresh, loading, listError, detailError, version]);
  function select(id: string | null) {
    setSelected(id); setDetailError("");
    const url = new URL(location.href); url.searchParams.set("job", jobId);
    if (id) url.searchParams.set("aiRun", id); else url.searchParams.delete("aiRun");
    history.replaceState(null, "", url);
  }
  async function enqueue() {
    if (lock.current || (!requestKey.current && (!fresh || !data?.capability.configured))) return;
    lock.current = true; setBusy(true); setActionError(""); setNotice("");
    requestKey.current ??= crypto.randomUUID();
    const scopeSignal = lifetime.current.signal, generation = accessGeneration.current;
    const signal = AbortSignal.any([scopeSignal, AbortSignal.timeout(10000)]);
    try {
      const value = parseAiAdmission(await jobsApi<unknown>(base, {
        method: "POST", body: "{}", signal, headers: { ...headers, "Idempotency-Key": requestKey.current },
      }), jobId);
      const run = value.run;
      if (scopeSignal.aborted || generation !== accessGeneration.current) return;
      requestKey.current = null; setRetry(false); setOffset(0); select(run.id);
      setNotice(value.replayed ? "같은 요청의 접수 기록을 확인했습니다. 추가 실행을 만들지 않았습니다." : "텍스트 초안 요청을 접수했습니다.");
      setVersion((v) => v + 1);
    } catch (e) {
      if (scopeSignal.aborted || generation !== accessGeneration.current) return;
      checkAuth(e); setActionError(failure(signal.aborted ? signal.reason : e));
      if (denied(e)) clearAccess();
      if (e instanceof ApiError && [400, 401, 403, 404, 409, 429, 503].includes(e.status)) { requestKey.current = null; setRetry(false); setVersion((v) => v + 1); }
      else setRetry(true);
    } finally { if (!scopeSignal.aborted) { lock.current = false; setBusy(false); } }
  }
  async function cancel(run: AiRun) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setActionError(""); setNotice("");
    const scopeSignal = lifetime.current.signal, generation = accessGeneration.current;
    const signal = AbortSignal.any([scopeSignal, AbortSignal.timeout(10000)]);
    try {
      const next = parseAiCancel(await jobsApi<unknown>(`${base}/${run.id}/cancel`, { method: "POST", body: "{}", signal, headers }), jobId, run.id);
      if (!scopeSignal.aborted && generation === accessGeneration.current) { setNotice(next.status === "cancelling" ? "중단 요청을 접수했습니다. 원격 중단 확인을 기다립니다." : "취소 요청 후 실행 기록을 확인했습니다."); setVersion((v) => v + 1); }
    } catch (e) { if (!scopeSignal.aborted && generation === accessGeneration.current) { checkAuth(e); setActionError(failure(signal.aborted ? signal.reason : e)); if (denied(e)) clearAccess(); } }
    finally { if (!scopeSignal.aborted) { lock.current = false; setBusy(false); } }
  }
  return <section className="ai-runs" aria-label="AI 텍스트 초안·실행 이력">
    <h4>AI 텍스트 초안·실행 이력</h4>
    <p className="session-note">저장한 업무 요청으로 텍스트 초안을 별도 접수합니다. 첨부 파일은 보내지 않으며 정량 집계·오피스 시연과 별개입니다. 화면을 열거나 새로고침하는 것만으로 실행되지 않습니다.</p>
    <p role="status" aria-label="AI 접수 설정">
      {!fresh ? "설정 확인 필요" : data?.capability.mode === "disabled" ? "AI 실행 미설정 · 기록 조회·취소만 가능" :
        data?.capability.mode === "synthetic" ? "합성 실행기 설정 · 실제 AI 호출 아님" : "Codex 접수 설정 · 실제 연결 성공 여부는 실행 후 확인"}
    </p>
    {data?.capability.mode === "codex" && <p className="session-note">접수하면 저장된 요청 내용이 AI 제공자에게 전송되며 모델 사용료가 발생할 수 있습니다.</p>}
    <div className="ai-actions">
      <button className="secondary-button" disabled={busy || (!retry && (!fresh || !data?.capability.configured || data.runs.some(aiActive)))} onClick={enqueue}>
        {retry ? "접수 응답 다시 확인" : "텍스트 초안 접수"}
      </button>
      <button className="text-button" disabled={busy} onClick={() => setVersion((v) => v + 1)}>AI 기록 새로고침</button>
    </div>
    {busy && <p className="session-note" role="status">AI 요청 응답을 확인하고 있습니다…</p>}
    {retry && <p className="session-note">접수 여부를 확인하지 못했습니다. 재확인 버튼은 같은 요청 식별자를 사용합니다. 자동으로 재접수하지 않습니다.</p>}
    {actionError && <p className="request-error" role="alert">{actionError}</p>}
    {notice && <p className="request-success" role="status">{notice}</p>}
    {listError && <p className="request-error" role="alert">{listError} 표시된 목록은 마지막 확인 기록입니다.</p>}
    {loading && <p className="session-note" role="status">AI 기록 확인 중…</p>}
    {data && <>
      <p className="session-note">AI 실행 기록 {data.page.total}개 · 표시 {data.runs.length ? offset + 1 : 0}~{offset + data.runs.length}</p>
      {!data.runs.length && <p className="session-note">접수한 AI 텍스트 초안이 없습니다.</p>}
      <ul className="ai-run-list">{data.runs.map((run) => <li key={run.id} data-ai-run-id={run.id}>
        <p><strong>{AI_STATUS[run.status]}</strong> · {run.mode === "synthetic" ? "합성 실행 기록 · 실제 AI 호출 아님" : "Codex 실행 기록"}</p>
        <p className="session-note">접수 {date(run.createdAt)} · 실행 ID {run.id}</p>
        {aiOutcome(run) && <p className="session-note">{aiOutcome(run)}</p>}
        <div className="ai-actions"><button className="text-button" aria-pressed={selected === run.id} onClick={() => select(run.id)}>
          {run.status === "completed" ? "AI 초안 결과 보기" : "AI 실행 상세 보기"}</button>
          {["queued", "running"].includes(run.status) && <button className="text-button" disabled={busy || !fresh} onClick={() => cancel(run)}>{run.status === "queued" ? "AI 대기 취소" : "AI 실행 중단 요청"}</button>}
        </div>
      </li>)}</ul>
      <div className="ai-actions"><button className="text-button" disabled={busy || loading || offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>이전 AI 기록</button>
        <button className="text-button" disabled={busy || loading || !data.page.hasMore} onClick={() => setOffset(offset + 20)}>다음 AI 기록</button></div>
    </>}
    {selected && <section className="ai-run-detail" aria-label="선택한 AI 실행 기록">
      <h5>AI 실행 상세·초안</h5>
      <button className="text-button" onClick={() => select(null)}>AI 상세 닫기</button>
      {detailLoading && <p className="session-note" role="status">선택한 AI 기록 확인 중…</p>}
      {detailError && <p className="request-error" role="alert">{detailError} 현재 상태 확인이 필요합니다.</p>}
      {view && <>
        <p><strong>{AI_STATUS[view.run.status]}</strong> · {view.run.mode === "synthetic" ? "합성 실행 기록 · 실제 AI 호출 아님" : "Codex 실행 기록"}</p>
        <p className="session-note">실행 ID {view.run.id}</p>
        {aiOutcome(view.run) && <p className="session-note">{aiOutcome(view.run)}</p>}
        <ol className="ai-events" aria-label="AI 실행 상태 이력">{view.events.map((e, i) => <li key={i}>{date(e.createdAt)} · {AI_STATUS[e.status]}</li>)}</ol>
      </>}
      {stored && <section aria-label="검수 필요한 AI 초안" className="ai-text">
        <h5>검수 필요 · 미승인 초안</h5>
        <p className="session-note">생성된 문장의 사실성·표현을 사람이 확인해야 합니다. 승인·외부 발송·파일 반영은 하지 않았습니다.{detailError && " 마지막으로 확인한 초안이며 현재 무결성은 재확인하지 못했습니다."}</p>
        <pre>{stored.text}</pre>
      </section>}
    </section>}
  </section>;
}
