import { REVIEW_STATE_SQL } from "./jobActivity.ts";
export const JOB_FILTERS = [
  "all",
  "none",
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "review_pending",
  "approved",
  "rejected",
  "summary_only",
] as const;
export type JobFilter = (typeof JOB_FILTERS)[number];
export interface JobSearch {
  q?: string;
  status?: JobFilter;
}
export function jobWhere(account: string, search: JobSearch) {
  const q = search.q?.trim() ?? "",
    status = search.status ?? "all";
  const clauses = ["j.account_id=?"],
    params: string[] = [account];
  if (q) {
    clauses.push(
      "(instr(lower(j.title),lower(?))>0 OR instr(lower(j.instructions),lower(?))>0)",
    );
    params.push(q, q);
  }
  const scope = "r.job_id=j.id AND r.account_id=j.account_id";
  if (status === "none")
    clauses.push(`NOT EXISTS (SELECT 1 FROM summary_runs r WHERE ${scope})`);
  else if (status === "queued" || status === "running") {
    clauses.push(
      `EXISTS (SELECT 1 FROM summary_runs r WHERE ${scope} AND r.status=?)`,
    );
    params.push(status);
  } else if (status !== "all") {
    const latest = `NOT EXISTS (SELECT 1 FROM summary_runs newer WHERE newer.account_id=r.account_id AND newer.file_id=r.file_id AND (newer.created_at>r.created_at OR (newer.created_at=r.created_at AND newer.id>r.id)))`;
    const state = ["completed", "failed", "cancelled"].includes(status)
      ? "r.status"
      : REVIEW_STATE_SQL;
    clauses.push(
      `EXISTS (SELECT 1 FROM summary_runs r LEFT JOIN summary_run_reviews v ON v.run_id=r.id AND v.account_id=r.account_id WHERE ${scope} AND ${latest} AND (${state})=?)`,
    );
    params.push(status === "review_pending" ? "pending" : status);
  }
  return { where: clauses.join(" AND "), params, q, status };
}
