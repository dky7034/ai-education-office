import type { JobActivity as Activity } from "./jobsApi";
const states = {
  queued: "대기",
  running: "실행 중",
  completed: "완료",
  failed: "실패",
  cancelled: "취소됨",
};
const reviews = {
  pending: "검토 대기",
  approved: "승인 기록",
  rejected: "반려 기록",
  summary_only: "요약만 보관",
};
export default function JobActivity({
  activity,
  onOpen,
  compact = false,
}: {
  activity?: Activity;
  compact?: boolean;
  onOpen?: (fileId: string, runId: string) => void;
}) {
  if (!activity)
    return (
      <span className="job-activity">집계·검토 상태를 새로고침해 주세요.</span>
    );
  if (!activity.latest.length)
    return <span className="job-activity">집계 이력 없음</span>;
  const count = (value: Activity["latest"][number]["review"]) =>
    activity.latest.filter((r) => r.review === value).length;
  const failures = activity.latest.filter((r) => r.status === "failed").length,
    cancelled = activity.latest.filter((r) => r.status === "cancelled").length,
    completed = activity.latest.filter((r) => r.status === "completed").length;
  return (
    <span className={`job-activity${compact ? " job-activity-compact" : ""}`}>
      <span className="activity-progress">
        진행 중 전체 · 대기 {activity.active.queued}건 · 실행 중{" "}
        {activity.active.running}건
      </span>
      <span>
        첨부별 최근 집계 · 완료 {completed}건 · 실패 {failures}건 · 취소{" "}
        {cancelled}건
      </span>
      <span>
        검토 대기 {count("pending")}건 · 승인 기록 {count("approved")}건 · 반려
        기록 {count("rejected")}건
        {count("summary_only") > 0 &&
          ` · 요약만 보관 ${count("summary_only")}건`}
      </span>
      {!compact && (
        <>
          <span className="session-note">
            첨부마다 가장 최근에 접수한 실행 기준입니다. 승인·반려는 당시
            기록이며 파일 무결성과 결정 유효성은 결과 상세에서 다시 확인합니다.
          </span>
          {activity.latest.map((run) => (
            <span className="activity-file" key={run.fileId}>
              <strong>{run.filename}</strong>
              <span>
                선택 버전 {run.revision} · {states[run.status]}
                {run.review && ` · ${reviews[run.review]}`}
              </span>
              {onOpen && (
                <button
                  className="text-button"
                  onClick={() => onOpen(run.fileId, run.runId)}
                >
                  {run.filename} 집계·검토 보기
                </button>
              )}
            </span>
          ))}
        </>
      )}
    </span>
  );
}
