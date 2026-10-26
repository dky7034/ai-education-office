import { AI_STATUS, AiProtocolError, aiUuid, type AiStatus } from "./aiProtocol";
export interface AiActivityRun {
  runId: string; jobId: string; jobTitle: string; status: AiStatus; mode: "synthetic" | "codex";
  review: "pending" | "approved" | "rejected" | null;
  createdAt: string; startedAt: string | null; finishedAt: string | null;
}
export interface AiActivity { active: {queued: number; running: number; cancelling: number}; latest: AiActivityRun | null }
export interface AiOffice {
  executionMode: "ai_records"; connectionVerified: false;
  totals: Record<"latestRuns" | "queued" | "running" | "cancelling" | "syntheticLatest" | "codexLatest" | "completed" | "failed" | "cancelled" | "timedOut" | "interrupted" | "reviewPending" | "approved" | "rejected", number>;
  focus: AiActivityRun | null; recent: AiActivityRun[];
}
export interface AiOfficeView { data: AiOffice | null; error: string; verifiedAt: string | null }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const date = (v: unknown) => typeof v === "string" && v.length <= 32 && Number.isFinite(Date.parse(v));
export function parseAiActivityRun(v: unknown, jobId?: string): AiActivityRun {
  if (!object(v) || !aiUuid(v.runId) || !aiUuid(v.jobId) || jobId !== undefined && v.jobId !== jobId
    || typeof v.jobTitle !== "string" || v.jobTitle.length < 2 || v.jobTitle.length > 100
    || typeof v.status !== "string" || !Object.hasOwn(AI_STATUS, v.status) || !["synthetic", "codex"].some((m) => m === v.mode)
    || !(v.review === null || ["pending", "approved", "rejected"].some((r) => r === v.review))
    || (v.status === "completed" ? v.review === null : v.review !== null)
    || !date(v.createdAt) || !(v.startedAt === null || date(v.startedAt)) || !(v.finishedAt === null || date(v.finishedAt))) throw new AiProtocolError();
  return v as unknown as AiActivityRun;
}
export function parseAiActivity(v: unknown, jobId: string): AiActivity {
  if (!object(v) || !object(v.active) || !["queued", "running", "cancelling"].every((k) => count((v.active as Record<string, unknown>)[k]))) throw new AiProtocolError();
  const latest = v.latest === null ? null : parseAiActivityRun(v.latest, jobId);
  if (!latest && Object.values(v.active).some((n) => n !== 0)) throw new AiProtocolError();
  return { active: v.active as unknown as AiActivity["active"], latest };
}
export function parseAiOffice(v: unknown): AiOffice {
  const keys = ["latestRuns", "queued", "running", "cancelling", "syntheticLatest", "codexLatest", "completed", "failed", "cancelled", "timedOut", "interrupted", "reviewPending", "approved", "rejected"];
  if (!object(v) || v.executionMode !== "ai_records" || v.connectionVerified !== false || !object(v.totals)
    || !keys.every((k) => count((v.totals as Record<string, unknown>)[k])) || !Array.isArray(v.recent) || v.recent.length > 5) throw new AiProtocolError();
  const t = v.totals as AiOffice["totals"];
  if (t.syntheticLatest + t.codexLatest !== t.latestRuns || t.reviewPending + t.approved + t.rejected !== t.completed
    || t.completed + t.failed + t.cancelled + t.timedOut + t.interrupted > t.latestRuns) throw new AiProtocolError();
  const recent = v.recent.map((r) => parseAiActivityRun(r));
  const focus = v.focus === null ? null : parseAiActivityRun(v.focus);
  if (new Set(recent.map((r) => r.jobId)).size !== recent.length || (t.latestRuns === 0) !== (focus === null) || recent.length !== Math.min(5, t.latestRuns)) throw new AiProtocolError();
  return { executionMode: "ai_records", connectionVerified: false, totals: t, focus, recent };
}
export const aiActivityLabel = (run: AiActivityRun) => run.status === "completed"
  ? { pending: "AI 초안 검토 대기", approved: "AI 승인 기록", rejected: "AI 반려 기록" }[run.review!]
  : `AI ${AI_STATUS[run.status]}`;
export const aiActivityLink = (run: AiActivityRun) => "/?" + new URLSearchParams({ job: run.jobId, aiRun: run.runId }).toString();
