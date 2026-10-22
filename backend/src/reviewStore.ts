import type { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { validArtifacts, type RunArtifact } from "./runArtifacts.ts";
import { RunError } from "./runStore.ts";
export const REVIEW_SCHEMA = `BEGIN IMMEDIATE;
CREATE TABLE summary_run_reviews (
 id TEXT NOT NULL UNIQUE, run_id TEXT PRIMARY KEY REFERENCES summary_runs(id),
 account_id TEXT NOT NULL REFERENCES users(id), request_key TEXT NOT NULL,
 target_hash TEXT NOT NULL, manifest_json TEXT NOT NULL,
 decision TEXT NOT NULL CHECK(decision IN ('approved','rejected')), comment TEXT NOT NULL,
 decided_at TEXT NOT NULL, UNIQUE(account_id,request_key));
PRAGMA user_version=8; COMMIT;`;
export interface ReviewInput {
  targetHash: string;
  decision: "approved" | "rejected";
  comment: string;
}
interface Review extends ReviewInput {
  id: string;
  runId: string;
  reviewerId: string;
  decidedAt: string;
  requestKey: string;
}
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const publicReview = ({ requestKey: _, ...review }: Review) => review;
export function reviewRepository(db: DatabaseSync) {
  const context = (
    account: string,
    jobId: string,
    fileId: string,
    id: string,
  ) => {
    const run = db
      .prepare(
        "SELECT status,result_json AS result FROM summary_runs WHERE id=? AND account_id=? AND job_id=? AND file_id=?",
      )
      .get(id, account, jobId, fileId) as
      | { status: string; result: string }
      | undefined;
    if (!run) return null;
    if (run.status !== "completed")
      throw new RunError(409, "완료된 실행 결과만 검토할 수 있습니다.");
    const artifacts = db
      .prepare(
        "SELECT format,size,sha256,created_at AS createdAt FROM summary_run_artifacts WHERE run_id=? ORDER BY format",
      )
      .all(id) as unknown as RunArtifact[];
    const manifest = {
      runId: id,
      jobId,
      fileId,
      summaryHash: digest(JSON.parse(run.result)),
      artifacts,
    };
    const review = db
      .prepare(
        "SELECT id,run_id AS runId,account_id AS reviewerId,request_key AS requestKey,target_hash AS targetHash,decision,comment,decided_at AS decidedAt FROM summary_run_reviews WHERE run_id=?",
      )
      .get(id) as unknown as Review | undefined;
    return {
      targetHash: digest(manifest),
      manifest,
      artifacts,
      review: review ?? null,
    };
  };
  return {
    reviewContext: context,
    decideSummaryRun(
      account: string,
      jobId: string,
      fileId: string,
      id: string,
      key: string,
      input: ReviewInput,
    ) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const target = context(account, jobId, fileId, id);
        if (!target) {
          db.exec("COMMIT");
          return null;
        }
        const previous = db
          .prepare(
            "SELECT run_id AS runId,target_hash AS targetHash,decision,comment FROM summary_run_reviews WHERE account_id=? AND request_key=?",
          )
          .get(account, key) as unknown as
          | (ReviewInput & { runId: string })
          | undefined;
        if (previous) {
          if (
            previous.runId !== id ||
            previous.targetHash !== input.targetHash ||
            previous.decision !== input.decision ||
            previous.comment !== input.comment
          )
            throw new RunError(
              409,
              "같은 요청 식별자로 다른 검토 결정을 보낼 수 없습니다.",
            );
          db.exec("COMMIT");
          return { decision: publicReview(target.review!), replayed: true };
        }
        if (target.review)
          throw new RunError(
            409,
            "이미 검토 결정이 확정되었습니다. 최신 검토 상태를 확인해 주세요.",
          );
        if (!validArtifacts(target.artifacts))
          throw new RunError(
            409,
            "보관 파일 3종이 있는 결과만 검토할 수 있습니다.",
          );
        if (target.targetHash !== input.targetHash)
          throw new RunError(
            409,
            "검토 대상이 변경되었습니다. 결과와 파일을 다시 확인해 주세요.",
          );
        const review: Review = {
          ...input,
          id: randomUUID(),
          runId: id,
          reviewerId: account,
          decidedAt: new Date().toISOString(),
          requestKey: key,
        };
        db.prepare(
          "INSERT INTO summary_run_reviews(id,run_id,account_id,request_key,target_hash,manifest_json,decision,comment,decided_at) VALUES (?,?,?,?,?,?,?,?,?)",
        ).run(
          review.id,
          id,
          account,
          key,
          input.targetHash,
          JSON.stringify(target.manifest),
          input.decision,
          input.comment,
          review.decidedAt,
        );
        db.exec("COMMIT");
        return { decision: publicReview(review), replayed: false };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
