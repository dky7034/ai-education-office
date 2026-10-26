import type { DatabaseSync } from "node:sqlite";
import type { AiStatus } from "./aiStore.ts";
export interface AiActivityRun {
  runId: string; jobId: string; jobTitle: string; status: AiStatus; mode: "synthetic" | "codex";
  review: "pending" | "approved" | "rejected" | null;
  createdAt: string; startedAt: string | null; finishedAt: string | null;
}
export interface AiActivity {
  active: { queued: number; running: number; cancelling: number };
  latest: AiActivityRun | null;
}
const reviewSql = "CASE WHEN r.status='completed' THEN coalesce(v.decision,'pending') ELSE NULL END";
const ranked = (scope = "") => `WITH ranked AS (
 SELECT r.id,r.account_id,r.job_id,r.status,r.mode,r.created_at,r.started_at,r.finished_at,
 row_number() OVER(PARTITION BY r.job_id ORDER BY r.created_at DESC,r.id DESC) AS position,
 sum(r.status='queued') OVER(PARTITION BY r.job_id) AS queued,
 sum(r.status='running') OVER(PARTITION BY r.job_id) AS running,
 sum(r.status='cancelling') OVER(PARTITION BY r.job_id) AS cancelling
 FROM ai_runs r JOIN jobs j ON j.id=r.job_id AND j.account_id=r.account_id WHERE r.account_id=? ${scope})`;
const columns = `r.id AS runId,r.job_id AS jobId,j.title AS jobTitle,r.status,r.mode,${reviewSql} AS review,
 r.created_at AS createdAt,r.started_at AS startedAt,r.finished_at AS finishedAt`;
const joins = ` FROM ranked r JOIN jobs j ON j.id=r.job_id AND j.account_id=r.account_id
 LEFT JOIN ai_run_reviews v ON v.run_id=r.id AND v.account_id=r.account_id`;
export function aiActivities(db: DatabaseSync, account: string, ids: string[]) {
  const result = new Map<string, AiActivity>(ids.map((id) => [id, { active: {queued: 0, running: 0, cancelling: 0}, latest: null }]));
  if (!ids.length) return result;
  const rows = db.prepare(ranked(`AND r.job_id IN (${ids.map(() => "?").join(",")})`) + ` SELECT ${columns},r.queued,r.running,r.cancelling ${joins} WHERE r.position=1`)
    .all(account, ...ids) as unknown as (AiActivityRun & AiActivity["active"])[];
  for (const {queued, running, cancelling, ...run} of rows) result.set(run.jobId, { active: {queued, running, cancelling}, latest: run });
  return result;
}
export function aiOfficeRepository(db: DatabaseSync) {
  return {
    aiOfficeState(account: string) {
      db.exec("BEGIN");
      try {
        const totals = db.prepare(ranked() + ` SELECT count(*) AS latestRuns,
          (SELECT count(*) FROM ranked WHERE status='queued') AS queued,
          (SELECT count(*) FROM ranked WHERE status='running') AS running,
          (SELECT count(*) FROM ranked WHERE status='cancelling') AS cancelling,
          coalesce(sum(r.mode='synthetic'),0) AS syntheticLatest,coalesce(sum(r.mode='codex'),0) AS codexLatest,
          coalesce(sum(r.status='completed'),0) AS completed,coalesce(sum(r.status='failed'),0) AS failed,
          coalesce(sum(r.status='cancelled'),0) AS cancelled,coalesce(sum(r.status='timed_out'),0) AS timedOut,
          coalesce(sum(r.status='interrupted'),0) AS interrupted,
          coalesce(sum((${reviewSql})='pending'),0) AS reviewPending,
          coalesce(sum((${reviewSql})='approved'),0) AS approved,coalesce(sum((${reviewSql})='rejected'),0) AS rejected
          ${joins} WHERE r.position=1`).get(account) as Record<string, number>;
        const focus = db.prepare(ranked() + ` SELECT ${columns} ${joins}
          WHERE r.status IN ('queued','running','cancelling') OR r.position=1
          ORDER BY CASE r.status WHEN 'running' THEN 0 WHEN 'cancelling' THEN 1 WHEN 'queued' THEN 2
            ELSE CASE WHEN (${reviewSql})='pending' THEN 3 ELSE 4 END END,
          CASE WHEN r.mode='codex' THEN 0 ELSE 1 END,
          CASE WHEN r.status IN ('queued','running','cancelling') THEN r.created_at END ASC,r.created_at DESC,r.id DESC LIMIT 1`)
          .get(account) as AiActivityRun | undefined;
        const recent = db.prepare(ranked() + ` SELECT ${columns} ${joins} WHERE r.position=1 ORDER BY r.created_at DESC,r.id DESC LIMIT 5`).all(account) as unknown as AiActivityRun[];
        db.exec("COMMIT");
        return { executionMode: "ai_records" as const, connectionVerified: false as const, totals, focus: focus ?? null, recent };
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  };
}
