import { parseAiActivity, aiActivityLabel } from "./aiActivity";
export default function AiActivity({ value, jobId }: { value: unknown; jobId: string }) {
  try {
    const data = parseAiActivity(value, jobId), run = data.latest;
    if (!run) return <span className="job-activity">AI 실행 이력 없음</span>;
    return <span className="job-activity job-ai-activity">
      <span>AI 전체 진행 · 대기 {data.active.queued}건 · 실행 중 {data.active.running}건 · 중단 요청 {data.active.cancelling}건</span>
      <span>{aiActivityLabel(run)} · {run.mode === "synthetic" ? "합성 기록 · 실제 AI 호출 아님" : "Codex 기록"}</span>
      <span className="session-note">업무별 최근 실행 기준 · 검토 유효성은 상세에서 확인</span>
    </span>;
  } catch { return <span className="job-activity">AI 현황 확인 필요</span>; }
}
