import { JobUpdateRevision } from "./jobUpdates";
import { useContext, useEffect, useRef, useState, useId } from "react";
import { jobsApi, ApiError } from "./jobsApi";
interface ReviewState {
  targetHash: string;
  reviewable: boolean;
  problem: string | null;
  decision: null | {
    id: string;
    decision: "approved" | "rejected";
    comment: string;
    reviewerId: string;
    decidedAt: string;
    targetHash: string;
    valid: boolean;
  };
}
export default function RunReview({
  base,
  accountId,
  expectedTargetHash,
  onUnauthorized,
  onActivityChange,
}: {
  base: string;
  accountId: string;
  expectedTargetHash: string;
  onUnauthorized: () => void;
  onActivityChange?: () => void;
}) {
  const liveRevision = useContext(JobUpdateRevision);
  const [state, setState] = useState<ReviewState | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [decision, setDecision] = useState<"approved" | "rejected">("approved"),
    [comment, setComment] = useState(""),
    [confirmed, setConfirmed] = useState(false);
  const decisionId = useId(),
    commentId = useId();
  const controller = useRef<AbortController | null>(null),
    request = useRef<{ key: string; payload: string } | null>(null),
    unauthorized = useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;
  const headers = { "X-Office-Account": accountId };
  function fail(e: unknown) {
    if (
      controller.current?.signal.aborted ||
      (e instanceof DOMException && e.name === "AbortError")
    )
      return;
    if (e instanceof ApiError && e.status === 401) unauthorized.current();
    setError(
      e instanceof Error ? e.message : "검토 상태를 확인하지 못했습니다.",
    );
  }
  const fingerprint = useRef("");
  const handledRevision = useRef(liveRevision);
  const loadSequence = useRef(0);
  async function load(signal: AbortSignal, automatic = false) {
    const sequence = ++loadSequence.current;
    const data = await jobsApi<ReviewState>(base + "/review", {
      headers,
      signal,
    });
    if (!signal.aborted && sequence === loadSequence.current) {
      setState(
        data.targetHash === expectedTargetHash
          ? data
          : {
              ...data,
              reviewable: false,
              problem:
                "표시 중인 결과가 변경되었습니다. 저장된 집계 결과를 다시 열어 확인해 주세요.",
              decision: data.decision
                ? { ...data.decision, valid: false }
                : null,
            },
      );
      const next = JSON.stringify([
        data.targetHash,
        data.reviewable,
        data.problem,
        data.decision,
      ]);
      if (!automatic || fingerprint.current !== next) setConfirmed(false);
      fingerprint.current = next;
    }
  }
  useEffect(() => {
    const current = new AbortController();
    controller.current = current;
    void load(current.signal).catch(fail);
    return () => current.abort();
  }, [base, accountId, expectedTargetHash]);
  useEffect(() => {
    if (!liveRevision || busy || handledRevision.current === liveRevision)
      return;
    handledRevision.current = liveRevision;
    const current = new AbortController();
    const timer = setTimeout(() => current.abort(), 10000);
    void load(current.signal, true).catch((e) => {
      if (!current.signal.aborted) fail(e);
    });
    return () => {
      current.abort();
      clearTimeout(timer);
    };
  }, [liveRevision, busy, base, accountId, expectedTargetHash]);
  async function refresh() {
    if (busy || !controller.current) return;
    setBusy(true);
    setError("");
    try {
      await load(controller.current.signal);
    } catch (e) {
      fail(e);
    } finally {
      if (!controller.current.signal.aborted) setBusy(false);
    }
  }
  async function submit() {
    if (
      busy ||
      !confirmed ||
      !state?.reviewable ||
      state.decision ||
      !controller.current
    )
      return;
    const payload = JSON.stringify({
      targetHash: state.targetHash,
      decision,
      comment: comment.trim(),
    });
    if (request.current?.payload !== payload)
      request.current = { key: crypto.randomUUID(), payload };
    setBusy(true);
    setError("");
    try {
      await jobsApi(base + "/review", {
        method: "POST",
        headers: { ...headers, "Idempotency-Key": request.current!.key },
        body: payload,
        signal: controller.current.signal,
      });
      onActivityChange?.();
      await load(controller.current.signal);
      request.current = null;
    } catch (e) {
      fail(e);
      if (e instanceof ApiError && e.status === 409)
        try {
          await load(controller.current.signal);
          onActivityChange?.();
        } catch (refreshError) {
          fail(refreshError);
        }
    } finally {
      if (!controller.current.signal.aborted) setBusy(false);
    }
  }
  return (
    <section className="run-review" aria-label="결과물 검토" lang="ko">
      <h5>결과물 검토·승인</h5>
      <p className="session-note">
        이 실행의 결과와 보관 파일 3종에 대한 검토를 기록합니다. 결정은 한 번
        확정하며, 다시 검토하려면 새 집계를 접수해 주세요. 승인으로 외부
        발송이나 AI 실행이 시작되지는 않습니다.
      </p>
      <button className="text-button" disabled={busy} onClick={refresh}>
        검토 상태 새로고침
      </button>
      {error && (
        <p role="alert" className="request-error">
          {error}
        </p>
      )}
      {!state && <p className="session-note">검토 상태를 확인하고 있습니다.</p>}
      {state && (
        <>
          {state.problem && <p className="request-error">{state.problem}</p>}
          {state.decision ? (
            <div className="review-decision">
              <p>
                <strong>
                  {state.decision.decision === "approved"
                    ? "승인 확정"
                    : "반려 확정"}
                </strong>{" "}
                · {new Date(state.decision.decidedAt).toLocaleString("ko-KR")}
              </p>
              <p className="session-note">
                검토자 계정 ID: {state.decision.reviewerId}
              </p>
              <p className="review-comment">
                검토 의견: {state.decision.comment || "의견 없음"}
              </p>
              <p className="session-note">
                검토 대상 SHA-256: {state.decision.targetHash}
              </p>
              {!state.decision.valid && (
                <p role="alert" className="request-error">
                  보관 결과가 검토 당시와 일치하는지 확인할 수 없어 기존 결정이
                  현재 파일에 유효하지 않습니다. 당시 결정 기록은 보존합니다.
                </p>
              )}
            </div>
          ) : state.reviewable ? (
            <form
              aria-label="결과물 검토 결정"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <p className="session-note">
                검토 대기 · 대상 SHA-256: {state.targetHash}
              </p>
              <div>
                <label htmlFor={decisionId}>검토 결정</label>
                <select
                  id={decisionId}
                  value={decision}
                  disabled={busy}
                  onChange={(e) => {
                    setDecision(e.target.value as typeof decision);
                    setConfirmed(false);
                  }}
                >
                  <option value="approved">승인</option>
                  <option value="rejected">반려</option>
                </select>
              </div>
              <div>
                <label htmlFor={commentId}>
                  검토 의견{decision === "rejected" ? " (필수)" : " (선택)"}
                </label>
                <textarea
                  id={commentId}
                  value={comment}
                  maxLength={2000}
                  required={decision === "rejected"}
                  disabled={busy}
                  onChange={(e) => {
                    setComment(e.target.value);
                    setConfirmed(false);
                  }}
                />
              </div>
              <label>
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={busy}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                이 실행 결과와 보관 파일을 확인했습니다
              </label>
              <button
                className="secondary-button"
                disabled={
                  busy ||
                  !confirmed ||
                  (decision === "rejected" && !comment.trim())
                }
                type="submit"
              >
                {busy
                  ? "검토 결정 저장 중…"
                  : decision === "approved"
                    ? "승인 확정"
                    : "반려 확정"}
              </button>
            </form>
          ) : null}
        </>
      )}
    </section>
  );
}
