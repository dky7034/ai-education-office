import { AiProtocolError, aiUuid } from "./aiProtocol";
export interface AiDecision {
  id: string; runId: string; reviewerId: string; decision: "approved" | "rejected";
  comment: string; targetHash: string; decidedAt: string; valid: boolean;
}
export interface AiReviewState {
  targetHash: string | null; resultHash: string | null; reviewable: boolean;
  problem: string | null; decision: AiDecision | null;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export const reviewHash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
export function parseAiDecision(v: unknown, runId: string): AiDecision {
  if (!object(v) || !aiUuid(v.id) || v.runId !== runId || !aiUuid(v.reviewerId)
    || !(v.decision === "approved" || v.decision === "rejected") || typeof v.comment !== "string"
    || v.comment.length > 2000 || v.comment !== v.comment.trim() || (v.decision === "rejected" && !v.comment)
    || !reviewHash(v.targetHash) || typeof v.valid !== "boolean" || typeof v.decidedAt !== "string"
    || v.decidedAt.length > 32 || !Number.isFinite(Date.parse(v.decidedAt))) throw new AiProtocolError();
  return v as unknown as AiDecision;
}
export function parseAiReview(v: unknown, runId: string): AiReviewState {
  if (!object(v) || typeof v.reviewable !== "boolean" || !(v.targetHash === null || reviewHash(v.targetHash))
    || !(v.resultHash === null || reviewHash(v.resultHash)) || !(v.problem === null || typeof v.problem === "string" && v.problem.length <= 500)) throw new AiProtocolError();
  if (v.reviewable ? !reviewHash(v.targetHash) || !reviewHash(v.resultHash) || v.problem !== null
    : v.targetHash !== null || v.resultHash !== null || !v.problem) throw new AiProtocolError();
  const decision = v.decision === null ? null : parseAiDecision(v.decision, runId);
  if (decision && decision.valid !== (v.reviewable && decision.targetHash === v.targetHash)) throw new AiProtocolError();
  return { targetHash: v.targetHash, resultHash: v.resultHash, reviewable: v.reviewable, problem: v.problem, decision } as AiReviewState;
}
export function parseAiReviewWrite(v: unknown, runId: string) {
  if (!object(v) || typeof v.replayed !== "boolean") throw new AiProtocolError();
  return { decision: parseAiDecision(v.decision, runId), replayed: v.replayed };
}
