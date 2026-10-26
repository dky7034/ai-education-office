import type { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { AiError } from "./aiStore.ts";
import { textFits, validId } from "./codex/executionProtocol.ts";
import type { ReviewInput } from "./reviewStore.ts";
export const AI_REVIEW_SCHEMA = `BEGIN IMMEDIATE;
CREATE TABLE ai_run_reviews (
 id TEXT NOT NULL UNIQUE, run_id TEXT PRIMARY KEY REFERENCES ai_runs(id),
 account_id TEXT NOT NULL REFERENCES users(id), request_key TEXT NOT NULL,
 target_hash TEXT NOT NULL, manifest_json TEXT NOT NULL,
 decision TEXT NOT NULL CHECK(decision IN ('approved','rejected')), comment TEXT NOT NULL,
 decided_at TEXT NOT NULL, UNIQUE(account_id,request_key));
CREATE TRIGGER ai_review_update BEFORE UPDATE ON ai_run_reviews BEGIN SELECT RAISE(ABORT,'Immutable AI review'); END;
CREATE TRIGGER ai_review_delete BEFORE DELETE ON ai_run_reviews BEGIN SELECT RAISE(ABORT,'Immutable AI review'); END;
CREATE TRIGGER ai_review_owner BEFORE INSERT ON ai_run_reviews WHEN NOT EXISTS(
 SELECT 1 FROM ai_runs r JOIN jobs j ON j.id=r.job_id WHERE r.id=NEW.run_id AND r.account_id=NEW.account_id AND j.account_id=NEW.account_id AND r.status='completed'
) BEGIN SELECT RAISE(ABORT,'Invalid AI review owner'); END;
CREATE TRIGGER activity_ai_review AFTER INSERT ON ai_run_reviews BEGIN
 UPDATE activity_streams SET sequence=sequence+1 WHERE account_id=NEW.account_id;
 INSERT INTO activity_events(account_id,sequence,type,job_id,file_id,run_id,state,revision,created_at)
 SELECT NEW.account_id,s.sequence,'review.decided',r.job_id,NULL,r.id,'ai.'||NEW.decision,NULL,NEW.decided_at
 FROM ai_runs r JOIN activity_streams s ON s.account_id=NEW.account_id WHERE r.id=NEW.run_id;
END;
PRAGMA user_version=11; COMMIT;`;
interface Review extends ReviewInput { id: string; runId: string; reviewerId: string; requestKey: string; decidedAt: string }
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const publicReview = ({ requestKey: _key, ...review }: Review, valid: boolean) => ({ ...review, valid });
export function aiReviewRepository(db: DatabaseSync) {
  const context = (account: string, job: string, id: string) => {
    const row = db.prepare(`SELECT r.id,r.mode,r.model,r.policy_id AS policyId,r.input_text AS inputText,
      r.status,r.code,r.remote_status AS remoteStatus,r.thread_id AS threadId,r.turn_id AS turnId,
      r.result_text AS text,r.result_hash AS resultHash FROM ai_runs r JOIN jobs j ON j.id=r.job_id
      WHERE r.id=? AND r.job_id=? AND r.account_id=? AND j.account_id=?`).get(id, job, account, account) as {
        id: string; mode: string; model: string; policyId: string; inputText: string; status: string; code: string | null;
        remoteStatus: string; threadId: string | null; turnId: string | null; text: string | null; resultHash: string | null;
      } | undefined;
    if (!row) return null;
    const review = db.prepare(`SELECT id,run_id AS runId,account_id AS reviewerId,request_key AS requestKey,
      target_hash AS targetHash,decision,comment,decided_at AS decidedAt FROM ai_run_reviews WHERE run_id=?`).get(id) as Review | undefined;
    const valid = row.status === "completed" && row.remoteStatus === "completed" && row.code === null
      && typeof row.inputText === "string" && validId(row.policyId) && typeof row.model === "string"
      && ["synthetic", "codex"].includes(row.mode) && /^[A-Za-z0-9._-]{1,100}$/.test(row.model)
      && validId(row.threadId) && validId(row.turnId) && textFits(row.text) && digest(row.text) === row.resultHash;
    const manifest = valid ? { version: 1, accountId: account, jobId: job, runId: id, mode: row.mode,
      model: row.model, policyId: row.policyId, inputHash: digest(row.inputText), resultHash: row.resultHash,
      threadId: row.threadId, turnId: row.turnId } : null;
    const targetHash = manifest ? digest(JSON.stringify(manifest)) : null;
    return { targetHash, resultHash: valid ? row.resultHash : null, reviewable: valid,
      problem: valid ? null : row.status === "completed" ? "보관된 AI 초안의 무결성을 확인하지 못했습니다." : "완료된 AI 초안만 검토할 수 있습니다.",
      review: review ?? null, manifest };
  };
  const state = (value: NonNullable<ReturnType<typeof context>>) => ({
    targetHash: value.targetHash, resultHash: value.resultHash, reviewable: value.reviewable, problem: value.problem,
    decision: value.review ? publicReview(value.review, value.reviewable && value.review.targetHash === value.targetHash) : null,
  });
  return {
    aiReviewState(account: string, job: string, id: string) {
      const value = context(account, job, id); return value ? state(value) : null;
    },
    decideAiReview(account: string, job: string, id: string, key: string, input: ReviewInput) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const target = context(account, job, id);
        if (!target) { db.exec("COMMIT"); return null; }
        const previous = db.prepare("SELECT run_id AS runId,target_hash AS targetHash,decision,comment FROM ai_run_reviews WHERE account_id=? AND request_key=?").get(account, key) as (ReviewInput & {runId: string}) | undefined;
        if (previous) {
          if (previous.runId !== id || previous.targetHash !== input.targetHash || previous.decision !== input.decision || previous.comment !== input.comment)
            throw new AiError(409, "같은 요청 식별자로 다른 AI 검토 결정을 보낼 수 없습니다.");
          db.exec("COMMIT"); return { decision: state(target).decision!, replayed: true };
        }
        if (target.review) throw new AiError(409, "이미 AI 초안 검토 결정이 확정되었습니다. 최신 검토 기록을 확인해 주세요.");
        if (!target.reviewable) throw new AiError(409, target.problem!);
        if (target.targetHash !== input.targetHash) throw new AiError(409, "검토 대상 AI 초안이 변경되었습니다. 초안을 다시 열어 확인해 주세요.");
        db.prepare("INSERT INTO ai_run_reviews(id,run_id,account_id,request_key,target_hash,manifest_json,decision,comment,decided_at) VALUES(?,?,?,?,?,?,?,?,?)")
          .run(randomUUID(), id, account, key, input.targetHash, JSON.stringify(target.manifest), input.decision, input.comment, new Date().toISOString());
        const saved = state(context(account, job, id)!);
        db.exec("COMMIT"); return { decision: saved.decision!, replayed: false };
      } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
    },
  };
}
