import type { DatabaseSync } from "node:sqlite";
import type { RunStatus } from "./runStore.ts";
export interface JobActivity {
  active: { queued: number; running: number };
  latest: {
    runId: string;
    fileId: string;
    filename: string;
    revision: number;
    status: RunStatus;
    review: "pending" | "approved" | "rejected" | "summary_only" | null;
  }[];
}
export function jobActivities(
  db: DatabaseSync,
  account: string,
  ids: string[],
) {
  const result = new Map<string, JobActivity>(
    ids.map((id) => [id, { active: { queued: 0, running: 0 }, latest: [] }]),
  );
  if (!ids.length) return result;
  const rows = db
    .prepare(
      `WITH ranked AS (
    SELECT id,job_id,file_id,revision,status,created_at,
      row_number() OVER (PARTITION BY file_id ORDER BY created_at DESC,id DESC) AS position,
      sum(status='queued') OVER (PARTITION BY job_id) AS queued,
      sum(status='running') OVER (PARTITION BY job_id) AS running
    FROM summary_runs WHERE account_id=? AND job_id IN (${ids.map(() => "?").join(",")})
  ) SELECT r.*,a.name AS filename,v.decision,
    (SELECT count(*) FROM summary_run_artifacts f WHERE f.run_id=r.id) AS formats
    FROM ranked r JOIN attachments a ON a.id=r.file_id AND a.job_id=r.job_id
    LEFT JOIN summary_run_reviews v ON v.run_id=r.id AND v.account_id=?
    WHERE r.position=1 ORDER BY r.created_at DESC,r.id DESC`,
    )
    .all(account, ...ids, account) as unknown as {
    id: string;
    job_id: string;
    file_id: string;
    filename: string;
    revision: number;
    status: RunStatus;
    queued: number;
    running: number;
    decision: "approved" | "rejected" | null;
    formats: number;
  }[];
  for (const row of rows) {
    const activity = result.get(row.job_id)!;
    activity.active = { queued: row.queued, running: row.running };
    activity.latest.push({
      runId: row.id,
      fileId: row.file_id,
      filename: row.filename,
      revision: row.revision,
      status: row.status,
      review:
        row.status === "completed"
          ? (row.decision ?? (row.formats === 3 ? "pending" : "summary_only"))
          : null,
    });
  }
  return result;
}
