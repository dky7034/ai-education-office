import { aiActivityLabel, aiActivityLink } from "./aiActivity";
import { aiOfficeStale, type ServerOfficeView } from "./serverOffice";
export default function AiOfficePanel({ view }: { view: ServerOfficeView }) {
  const ai = view.ai, data = ai?.data, run = data?.focus, stale = aiOfficeStale(view);
  return <section className="card status-card ai-office-panel" aria-label="AI 실행·검토 현황">
    <div className="card-heading"><h2>AI 실행·검토 현황</h2><span className="quiet-badge">계정 전체 · 읽기 전용</span></div>
    <p className="session-note">{view.connection}{ai?.verifiedAt && ` · 마지막 확인 ${new Date(ai.verifiedAt).toLocaleString("ko-KR")}`}</p>
    {ai?.error && <p className="request-error" role="alert">{ai.error}</p>}
    <div role="status" className="server-phase">{stale ? "AI 기록 확인 필요 · 마지막 기록" : run ? aiActivityLabel(run) : "접수한 AI 기록 없음"}</div>
    <dl className="numeric-counts ai-office-counts">
      <dt>최근 AI 실행</dt><dd>{data?.totals.latestRuns ?? "—"}건</dd>
      <dt>전체 AI 대기</dt><dd>{data?.totals.queued ?? "—"}건</dd>
      <dt>전체 AI 실행 중</dt><dd>{data?.totals.running ?? "—"}건</dd>
      <dt>전체 AI 중단 요청</dt><dd>{data?.totals.cancelling ?? "—"}건</dd>
      <dt>최근 초안 검토 대기</dt><dd>{data?.totals.reviewPending ?? "—"}건</dd>
      <dt>최근 AI 승인 기록</dt><dd>{data?.totals.approved ?? "—"}건</dd>
      <dt>최근 AI 반려 기록</dt><dd>{data?.totals.rejected ?? "—"}건</dd>
      <dt>최근 합성 기록</dt><dd>{data?.totals.syntheticLatest ?? "—"}건</dd>
      <dt>최근 Codex 기록</dt><dd>{data?.totals.codexLatest ?? "—"}건</dd>
      <dt>최근 실행 미확정</dt><dd>{data?.totals.interrupted ?? "—"}건</dd>
    </dl>
    {run && <div className="current-task server-current"><span className="section-label">대표 AI 실행 기록</span>
      <h3>{run.jobTitle}</h3><p>{run.mode === "synthetic" ? "합성 기록 · 실제 AI 호출 아님" : "Codex 실행 기록 · 현재 연결 성공을 보증하지 않음"}</p>
      <p>{stale ? "마지막 확인 상태" : "확인 상태"}: {aiActivityLabel(run)}</p>
      <a className="text-button" href={aiActivityLink(run)}>AI 실행·초안·검토 보기</a>
    </div>}
    <p className="session-note">실행 중 → 중단 요청 → 대기 → 검토 대기 → 최근 기록 순입니다. 진행 중은 전체, 검토는 업무별 최근 실행 기준이며 합성 기록도 포함합니다. 승인·반려 유효성과 원격 중단 여부는 상세에서 확인합니다.</p>
    <ul className="server-recent-list">{data?.recent.map((record) => <li key={record.runId}><strong>{record.jobTitle}</strong>
      <span>{record.mode === "synthetic" ? "합성" : "Codex"} · {aiActivityLabel(record)}</span>
      <a className="text-button" href={aiActivityLink(record)}>이 AI 기록 보기</a></li>)}</ul>
    <p className="approval-note">AI 연결 상태가 아닌 저장된 기록입니다. 합성 기록은 작성가의 실제 작업 동작을 만들지 않으며, 화면 전환으로 실행·승인을 만들지 않습니다.</p>
  </section>;
}
