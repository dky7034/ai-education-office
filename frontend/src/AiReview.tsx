import { useEffect, useId, useRef, useState } from "react";
import { jobsApi, ApiError } from "./jobsApi";
import { AiProtocolError } from "./aiProtocol";
import { parseAiReview, parseAiReviewWrite, type AiReviewState } from "./aiReviewProtocol";
const failure = (e: unknown) => e instanceof DOMException && e.name === "TimeoutError"
  ? "AI 검토 응답 대기 시간을 초과했습니다. 기록을 확인한 뒤 같은 결정으로 다시 확인해 주세요."
  : e instanceof Error ? e.message : "AI 검토 기록을 확인하지 못했습니다.";
export default function AiReview({ jobId, runId, accountId, expectedTargetHash, expectedResultHash, readable, refreshKey, onUnauthorized }: {
  jobId: string; runId: string; accountId: string; expectedTargetHash: string | null; expectedResultHash: string | null;
  readable: boolean; refreshKey: string; onUnauthorized: () => void;
}) {
  const base = `/${jobId}/ai-runs/${runId}/review`, headers = { "X-Office-Account": accountId };
  const [state, setState] = useState<AiReviewState | null>(null), [fresh, setFresh] = useState(false);
  const [version, setVersion] = useState(0), [busy, setBusy] = useState(false);
  const [readError, setReadError] = useState(""), [actionError, setActionError] = useState("");
  const [decision, setDecision] = useState<"approved" | "rejected">("approved"), [comment, setComment] = useState(""), [confirmed, setConfirmed] = useState(false);
  const scope = useRef(new AbortController()), lock = useRef(false), generation = useRef(0), fingerprint = useRef("");
  const request = useRef<{ key: string; payload: string } | null>(null);
  const unauthorized = useRef(onUnauthorized); unauthorized.current = onUnauthorized;
  const decisionId = useId(), commentId = useId();
  useEffect(() => { scope.current = new AbortController(); return () => scope.current.abort(); }, []);
  useEffect(() => {
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]), token = ++generation.current;
    setFresh(false);
    void jobsApi<unknown>(base, { headers, signal }).then((value) => {
      const next = parseAiReview(value, runId);
      if (signal.aborted || token !== generation.current) return;
      const mark = JSON.stringify(next);
      if (mark !== fingerprint.current) setConfirmed(false);
      fingerprint.current = mark; setState(next); setFresh(true); setReadError("");
    }).catch((error) => {
      if (controller.signal.aborted || token !== generation.current) return;
      if (error instanceof ApiError && error.status === 401) unauthorized.current();
      setReadError(failure(signal.aborted ? signal.reason : error));
      if (error instanceof AiProtocolError || error instanceof ApiError && [401, 403, 404].includes(error.status)) {
        setState(null); setConfirmed(false); request.current = null;
      }
    });
    return () => controller.abort();
  }, [base, accountId, expectedTargetHash, expectedResultHash, refreshKey, version]);
  const hasExpected = !!expectedTargetHash && !!expectedResultHash;
  const matches = hasExpected && state?.targetHash === expectedTargetHash && state?.resultHash === expectedResultHash;
  const canDecide = readable && fresh && matches && state?.reviewable && !state.decision;
  function edited() { setConfirmed(false); request.current = null; setActionError(""); }
  async function submit() {
    if (lock.current || !canDecide || !confirmed || decision === "rejected" && !comment.trim()) return;
    const payload = JSON.stringify({ targetHash: expectedTargetHash, decision, comment: comment.trim() });
    if (request.current?.payload !== payload) request.current = { key: crypto.randomUUID(), payload };
    lock.current = true; setBusy(true); setActionError("");
    const lifetime = scope.current.signal, signal = AbortSignal.any([lifetime, AbortSignal.timeout(10000)]);
    // Older reads must not replace the acknowledgment of this explicit decision.
    generation.current++;
    try {
      const result = parseAiReviewWrite(await jobsApi(base, { method: "POST", headers: { ...headers, "Idempotency-Key": request.current.key }, body: payload, signal }), runId);
      if (lifetime.aborted) return;
      if (result.decision.targetHash !== expectedTargetHash || result.decision.decision !== decision || result.decision.comment !== comment.trim()) throw new AiProtocolError();
      request.current = null; setConfirmed(false); setVersion((v) => v + 1);
    } catch (error) {
      if (lifetime.aborted) return;
      if (error instanceof ApiError && error.status === 401) unauthorized.current();
      setActionError(failure(signal.aborted ? signal.reason : error));
      if (error instanceof ApiError && [400, 401, 403, 404, 409].includes(error.status)) {
        request.current = null; setConfirmed(false); setVersion((v) => v + 1);
      }
    } finally { if (!lifetime.aborted) { lock.current = false; setBusy(false); } }
  }
  return <section className="run-review ai-review" aria-label="AI 초안 검토" lang="ko">
    <h5>AI 초안 검토·승인 기록</h5>
    <p className="session-note">이 실행의 초안 내용과 출처에 대한 검토를 한 번 기록합니다. 승인해도 AI 재실행·외부 발송·파일 반영을 하지 않습니다. 정량 집계 결과의 검토와 별개입니다.</p>
    <button className="text-button" disabled={busy} onClick={() => { setActionError(""); setVersion((v) => v + 1); }}>AI 검토 상태 새로고침</button>
    {readError && <p className="request-error" role="alert">{readError} 현재 검토 상태 확인이 필요합니다.</p>}
    {actionError && <p className="request-error" role="alert">{actionError}</p>}
    {!fresh && <p className="session-note">AI 검토 상태를 확인하고 있습니다. 확인 전에는 결정할 수 없습니다.</p>}
    {!readable && <p className="session-note">초안을 다시 조회해 현재 내용을 확인한 뒤 검토해 주세요.</p>}
    {state?.problem && <p className="request-error">{state.problem}</p>}
    {state?.reviewable && hasExpected && !matches && <p className="request-error" role="alert">표시 중인 초안의 검토 대상이 변경됐습니다. AI 기록을 새로고침해 초안을 다시 확인해 주세요.</p>}
    {state?.decision ? <div className="ai-review-decision">
      <p><strong>{state.decision.decision === "approved" ? "AI 초안 승인 기록" : "AI 초안 반려 기록"}</strong> · {new Date(state.decision.decidedAt).toLocaleString("ko-KR")}</p>
      <p className="ai-review-comment">검토 의견: {state.decision.comment || "의견 없음"}</p>
      {(!state.decision.valid || !matches || !fresh || !readable) && <p className="request-error" role="alert">당시 결정은 보존하지만 현재 표시된 초안에 유효한지 확인할 수 없습니다.</p>}
    </div> : state?.reviewable && matches ? <form aria-label="AI 초안 검토 결정" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <p className="session-note">검토 대기 · 미승인 초안</p>
      <label htmlFor={decisionId}>AI 검토 결정</label>
      <select id={decisionId} value={decision} disabled={busy} onChange={(event) => { setDecision(event.target.value as typeof decision); edited(); }}>
        <option value="approved">승인</option><option value="rejected">반려</option>
      </select>
      <label htmlFor={commentId}>AI 검토 의견{decision === "rejected" ? " (필수)" : " (선택)"}</label>
      <textarea id={commentId} maxLength={2000} required={decision === "rejected"} disabled={busy} value={comment} onChange={(event) => { setComment(event.target.value); edited(); }} />
      <label><input type="checkbox" checked={confirmed} disabled={busy || !canDecide} onChange={(event) => setConfirmed(event.target.checked)} />이 AI 초안의 내용과 출처를 확인했습니다</label>
      <button className="secondary-button" type="submit" disabled={busy || !canDecide || !confirmed || decision === "rejected" && !comment.trim()}>
        {busy ? "AI 검토 결정 저장 중…" : decision === "approved" ? "AI 승인 확정" : "AI 반려 확정"}
      </button>
    </form> : null}
  </section>;
}
