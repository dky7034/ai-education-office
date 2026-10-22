import {
  officeStale,
  runLabel,
  resultLink,
  type ServerOfficeView,
} from "./serverOffice";
export default function ServerOfficePanel({
  view,
}: {
  view: ServerOfficeView;
}) {
  const data = view.data,
    run = data?.focus,
    stale = officeStale(view);
  return (
    <section
      className="card status-card server-office-panel"
      aria-label="서버 집계 현황"
    >
      <div className="card-heading">
        <h2>서버 집계 현황</h2>
        <span className="quiet-badge">계정 전체 · 읽기 전용</span>
      </div>
      <p className="session-note">
        {view.connection}
        {view.verifiedAt &&
          ` · 마지막 확인 ${new Date(view.verifiedAt).toLocaleString("ko-KR")}`}
      </p>
      {view.error && (
        <p className="request-error" role="alert">
          {view.error}
        </p>
      )}
      <div className="server-phase" role="status">
        {stale
          ? "상태 확인 필요 · 마지막 기록"
          : run
            ? runLabel(run)
            : "접수한 집계 없음"}
      </div>
      <dl className="numeric-counts server-counts">
        <dt>보관 업무</dt>
        <dd>{data?.totals.jobs ?? "—"}건</dd>
        <dt>전체 집계 대기</dt>
        <dd>{data?.totals.queued ?? "—"}건</dd>
        <dt>전체 집계 실행 중</dt>
        <dd>{data?.totals.running ?? "—"}건</dd>
        <dt>최근 실행 검토 대기</dt>
        <dd>{data?.totals.reviewPending ?? "—"}건</dd>
        <dt>최근 실행 승인 기록</dt>
        <dd>{data?.totals.approved ?? "—"}건</dd>
        <dt>최근 실행 반려 기록</dt>
        <dd>{data?.totals.rejected ?? "—"}건</dd>
        <dt>최근 집계 실패</dt>
        <dd>{data?.totals.failed ?? "—"}건</dd>
        <dt>최근 집계 취소</dt>
        <dd>{data?.totals.cancelled ?? "—"}건</dd>
        <dt>요약만 보관</dt>
        <dd>{data?.totals.summaryOnly ?? "—"}건</dd>
      </dl>
      {run && (
        <div className="current-task server-current">
          <span className="section-label">대표 집계 실행</span>
          <h3>{run.jobTitle}</h3>
          <p>
            {run.filename} · 선택 버전 {run.revision}
          </p>
          <p className="session-note">
            {stale ? "마지막 확인 상태" : "확인 상태"}: {runLabel(run)} · 실행
            ID {run.runId}
          </p>
          <a className="text-button" href={resultLink(run)}>
            집계 실행·결과·검토 보기
          </a>
        </div>
      )}
      <p className="session-note">
        실행 중 → 대기 → 검토 대기 → 최근 기록 순으로 대표 실행을 표시합니다.
        대기·실행 건수는 전체, 나머지는 첨부별 최근 실행 기준입니다. 승인·반려는
        당시 기록이며 파일 유효성은 결과 상세에서 확인합니다.
      </p>
      <p className="approval-note">
        정량 집계는 서버 워커가 수행합니다. AI는 미연결이며 캐릭터가
        실행·승인하지 않습니다.
      </p>
    </section>
  );
}
export function ServerOfficeRecent({ view }: { view: ServerOfficeView }) {
  return (
    <section className="card log-card" aria-label="최근 서버 집계 기록">
      <div className="card-heading">
        <h2>최근 서버 집계 기록</h2>
        <span className="quiet-badge">첨부별 최근 실행 · 최대 5개</span>
      </div>
      {officeStale(view) && (
        <p className="session-note">연결 확인 전의 마지막 기록입니다.</p>
      )}
      {!view.data?.recent.length && (
        <p className="request-empty">표시할 서버 집계 기록이 없습니다.</p>
      )}
      <ul className="server-recent-list">
        {view.data?.recent.map((run) => (
          <li key={run.runId}>
            <strong>{run.jobTitle}</strong>
            <span>
              {runLabel(run)} · {run.filename}
            </span>
            <a className="text-button" href={resultLink(run)}>
              이 실행 보기
            </a>
          </li>
        ))}
      </ul>
      <p className="session-note">
        서버의 현재 기록입니다. 예시 이벤트 로그와 별도로 표시하며 지난 모든
        전환을 재현하지 않습니다.
      </p>
    </section>
  );
}
