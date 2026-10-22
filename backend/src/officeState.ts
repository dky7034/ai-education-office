import type { DatabaseSync } from "node:sqlite";
import { REVIEW_STATE_SQL } from "./jobActivity.ts";
import type { RunStatus } from "./runStore.ts";
export interface OfficeRun {
  runId: string;
  jobId: string;
  jobTitle: string;
  fileId: string;
  filename: string;
  status: RunStatus;
  revision: number;
  review: "pending" | "approved" | "rejected" | "summary_only" | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
export function officeRepository(db: DatabaseSync) {
  const ranked = `WITH ranked AS (SELECT r.*,row_number() OVER(PARTITION BY file_id ORDER BY created_at DESC,id DESC) AS position
    FROM summary_runs r WHERE account_id=?)`;
  const select = `SELECT r.id AS runId,r.job_id AS jobId,j.title AS jobTitle,r.file_id AS fileId,a.name AS filename,
    r.status,r.revision,${REVIEW_STATE_SQL} AS review,r.created_at AS createdAt,r.started_at AS startedAt,r.finished_at AS finishedAt
    FROM ranked r JOIN jobs j ON j.id=r.job_id AND j.account_id=r.account_id
    JOIN attachments a ON a.id=r.file_id AND a.job_id=j.id
    LEFT JOIN summary_run_reviews v ON v.run_id=r.id AND v.account_id=r.account_id`;
  return {
    officeState(account: string) {
      // One read transaction keeps counts, focus and recent records consistent.
      // No result JSON, original/output files, free-form instructions or opinions.
      db.exec("BEGIN");
      try {
        const totals = db
          .prepare(
            ranked +
              ` SELECT
          (SELECT count(*) FROM jobs WHERE account_id=?) AS jobs,
          (SELECT count(*) FROM ranked WHERE status='queued') AS queued,
          (SELECT count(*) FROM ranked WHERE status='running') AS running,
          count(*) AS latestRuns,
          coalesce(sum(r.status='completed'),0) AS completed,
          coalesce(sum(r.status='failed'),0) AS failed,
          coalesce(sum(r.status='cancelled'),0) AS cancelled,
          coalesce(sum((${REVIEW_STATE_SQL})='pending'),0) AS reviewPending,
          coalesce(sum((${REVIEW_STATE_SQL})='approved'),0) AS approved,
          coalesce(sum((${REVIEW_STATE_SQL})='rejected'),0) AS rejected,
          coalesce(sum((${REVIEW_STATE_SQL})='summary_only'),0) AS summaryOnly
          FROM ranked r LEFT JOIN summary_run_reviews v ON v.run_id=r.id AND v.account_id=r.account_id WHERE r.position=1`,
          )
          .get(account, account) as Record<string, number>;
        const focus = db
          .prepare(
            ranked +
              select +
              ` WHERE r.status IN ('queued','running') OR r.position=1
          ORDER BY CASE WHEN r.status='running' THEN 0 WHEN r.status='queued' THEN 1
            WHEN (${REVIEW_STATE_SQL})='pending' THEN 2 ELSE 3 END,
          CASE WHEN r.status IN ('queued','running') THEN r.created_at END ASC,
          r.created_at DESC,r.id DESC LIMIT 1`,
          )
          .get(account) as OfficeRun | undefined;
        const recent = db
          .prepare(
            ranked +
              select +
              " WHERE r.position=1 ORDER BY r.created_at DESC,r.id DESC LIMIT 5",
          )
          .all(account) as unknown as OfficeRun[];
        db.exec("COMMIT");
        return {
          executionMode: "quantitative_summary" as const,
          aiConnected: false as const,
          totals,
          focus: focus ?? null,
          recent,
        };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
