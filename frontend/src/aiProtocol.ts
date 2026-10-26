export const AI_STATUS = {
  queued: "대기", running: "실행 중", cancelling: "중단 요청 중", completed: "초안 생성 완료",
  failed: "실패", cancelled: "취소 기록", timed_out: "시간 초과", interrupted: "실행 결과 확인 필요",
} as const;
export type AiStatus = keyof typeof AI_STATUS;
export interface AiRun {
  id: string; jobId: string; status: AiStatus; mode: "synthetic" | "codex"; model: string;
  code: string | null; remoteStatus: "unknown" | "inProgress" | "completed" | "failed" | "interrupted";
  threadId: string | null; turnId: string | null;
  createdAt: string; startedAt: string | null; finishedAt: string | null;
}
export interface AiPage {
  runs: AiRun[];
  page: { total: number; limit: number; offset: number; hasMore: boolean };
  capability: { configured: boolean; mode: "disabled" | "synthetic" | "codex" };
}
export interface AiDetail { run: AiRun; events: { status: AiStatus; createdAt: string }[] }
export interface AiText { text: string; sha256: string; needsReview: true; mode: AiRun["mode"]; reviewTargetHash: string }
export class AiProtocolError extends Error {
  constructor() { super("AI 실행 응답을 확인하지 못했습니다. 다시 조회해 주세요."); }
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export const aiUuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
const id = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const date = (v: unknown) => typeof v === "string" && v.length <= 32 && Number.isFinite(Date.parse(v));
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const status = (v: unknown): v is AiStatus => typeof v === "string" && Object.hasOwn(AI_STATUS, v);
export const aiActive = (run: AiRun) => ["queued", "running", "cancelling"].includes(run.status);
export function parseAiRun(v: unknown, jobId: string): AiRun {
  if (!object(v) || !aiUuid(v.id) || v.jobId !== jobId || !status(v.status)
    || (typeof v.mode !== "string" || !["synthetic", "codex"].includes(v.mode)) || typeof v.model !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(v.model)
    || !(v.code === null || (typeof v.code === "string" && /^[a-z_]{1,64}$/.test(v.code)))
    || (typeof v.remoteStatus !== "string" || !["unknown", "inProgress", "completed", "failed", "interrupted"].includes(v.remoteStatus))
    || !(v.threadId === null || id(v.threadId)) || !(v.turnId === null || id(v.turnId))
    || !date(v.createdAt) || !(v.startedAt === null || date(v.startedAt)) || !(v.finishedAt === null || date(v.finishedAt))) throw new AiProtocolError();
  if ((["queued", "running", "cancelling"].includes(v.status) && v.finishedAt !== null)
    || (v.status === "completed" && (v.remoteStatus !== "completed" || v.code !== null || !id(v.threadId) || !id(v.turnId)))
    || (!["queued", "running", "cancelling"].includes(v.status) && v.finishedAt === null)) throw new AiProtocolError();
  return v as unknown as AiRun;
}
export function parseAiPage(value: unknown, jobId: string, offset: number): AiPage {
  if (!object(value) || !Array.isArray(value.runs) || value.runs.length > 20 || !object(value.page) || !object(value.capability)) throw new AiProtocolError();
  const p = value.page, cap = value.capability;
  if (!count(p.total) || p.limit !== 20 || p.offset !== offset || typeof p.hasMore !== "boolean"
    || value.runs.length > Math.max(0, p.total - offset) || p.hasMore !== (offset + value.runs.length < p.total)
    || !(cap.configured === false && cap.mode === "disabled") && !(cap.configured === true && typeof cap.mode === "string" && ["synthetic", "codex"].includes(cap.mode))) throw new AiProtocolError();
  const runs = value.runs.map((run) => parseAiRun(run, jobId));
  if (new Set(runs.map((run) => run.id)).size !== runs.length) throw new AiProtocolError();
  return { runs, page: p as unknown as AiPage["page"], capability: cap as unknown as AiPage["capability"] };
}
export function parseAiDetail(value: unknown, jobId: string, runId: string): AiDetail {
  if (!object(value) || !Array.isArray(value.events) || value.events.length < 1 || value.events.length > 5) throw new AiProtocolError();
  const run = parseAiRun(value.run, jobId);
  if (run.id !== runId || !value.events.every((e) => object(e) && status(e.status) && date(e.createdAt))
    || value.events[0].status !== "queued" || value.events.at(-1).status !== run.status) throw new AiProtocolError();
  const transitions: Record<AiStatus, AiStatus[]> = {
    queued: ["running", "cancelled", "failed"], running: ["cancelling", "completed", "failed", "cancelled", "timed_out", "interrupted"],
    cancelling: ["cancelled", "failed", "interrupted"], completed: [], failed: [], cancelled: [], timed_out: [], interrupted: [],
  };
  for (let i = 1; i < value.events.length; i++) {
    if (!transitions[value.events[i - 1].status as AiStatus].includes(value.events[i].status)) throw new AiProtocolError();
  }
  return { run, events: value.events as AiDetail["events"] };
}
export async function parseAiText(value: unknown, run: AiRun): Promise<AiText> {
  if (!object(value) || run.status !== "completed" || value.mode !== run.mode || value.needsReview !== true
    || typeof value.text !== "string" || !value.text.trim() || new TextEncoder().encode(value.text).length > 16384
    || typeof value.reviewTargetHash !== "string" || !/^[a-f0-9]{64}$/.test(value.reviewTargetHash)
    || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new AiProtocolError();
  let digest: ArrayBuffer;
  try { digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value.text)); }
  catch { throw new AiProtocolError(); }
  if ([...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, "0")).join("") !== value.sha256) throw new AiProtocolError();
  return value as unknown as AiText;
}
export function parseAiAdmission(value: unknown, jobId: string): { run: AiRun; replayed: boolean } {
  if (!object(value) || typeof value.replayed !== "boolean") throw new AiProtocolError();
  return { run: parseAiRun(value.run, jobId), replayed: value.replayed };
}
export function parseAiCancel(value: unknown, jobId: string, runId: string): AiRun {
  if (!object(value)) throw new AiProtocolError();
  const run = parseAiRun(value.run, jobId);
  if (run.id !== runId || ["queued", "running"].includes(run.status)) throw new AiProtocolError();
  return run;
}
export function aiOutcome(run: AiRun): string {
  if (run.code === "cleanup_failed") return "실행기 정리를 확인하지 못했습니다. 재접수 전에 서버 상태와 원격 실행 여부를 확인해 주세요.";
  if (run.status === "interrupted") return "서버 중단 등으로 실행 결과를 확인하지 못했습니다. 자동 재실행하지 않으며 재접수 전에 원격 실행 여부를 확인해야 합니다.";
  if (run.status === "cancelling") return "중단을 요청했습니다. 원격 중단 확인을 기다리는 중입니다.";
  if (run.status === "cancelled") {
    if (!run.startedAt) return "실행 전에 취소했습니다.";
    if (run.remoteStatus === "interrupted") return "원격 실행 중단이 확인됐습니다.";
    if (run.remoteStatus === "completed") return "취소와 원격 완료가 겹쳐 결과를 보관하지 않았습니다." + (run.mode === "codex" ? " 이미 발생한 사용료는 취소되지 않을 수 있습니다." : "");
    return "원격 중단이 확인되지 않았습니다. 재접수 전에 실행 여부를 확인해 주세요.";
  }
  if (run.status === "timed_out") return run.mode === "synthetic" ? "합성 실행이 제한 시간을 넘겼습니다. 실제 AI 호출은 아닙니다." : "제한 시간을 넘겼습니다. 원격 처리·사용료 중단은 확인되지 않았습니다.";
  if (run.code === "configuration_changed") return "서버 실행 설정이 변경돼 시작하지 않았습니다.";
  if (run.status === "failed") return "초안을 완료하지 못했습니다. 자동으로 다시 실행하지 않습니다.";
  return "";
}
