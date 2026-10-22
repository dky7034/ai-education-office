import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { ColumnSelection } from "./store.ts";
export type RunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";
export interface SummaryRun {
  id: string;
  jobId: string;
  fileId: string;
  revision: number;
  sourceHash: string;
  status: RunStatus;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
interface InternalRun extends SummaryRun {
  accountId: string;
  selectionJson: string;
  requestKey: string;
}
export class RunError extends Error {
  status: 409 | 429;
  constructor(status: 409 | 429, message: string) {
    super(message);
    this.status = status;
  }
}
export const RUN_SCHEMA = `BEGIN IMMEDIATE;
CREATE TABLE summary_runs (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES users(id), job_id TEXT NOT NULL REFERENCES jobs(id), file_id TEXT NOT NULL REFERENCES attachments(id),
 request_key TEXT NOT NULL, revision INTEGER NOT NULL, source_hash TEXT NOT NULL, selection_json TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled')), error TEXT, result_json TEXT,
 created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, UNIQUE(account_id,request_key));
CREATE INDEX summary_runs_file ON summary_runs(account_id,file_id,created_at DESC,id DESC);
CREATE INDEX summary_runs_pending ON summary_runs(status,created_at,id);
CREATE TABLE summary_run_events (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES summary_runs(id),status TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE summary_queue_lease (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
INSERT INTO summary_queue_lease VALUES (1,'',0);
PRAGMA user_version=6; COMMIT;`;
const SELECT = `SELECT id, account_id AS accountId, job_id AS jobId, file_id AS fileId, request_key AS requestKey, revision, source_hash AS sourceHash, selection_json AS selectionJson, status, error, created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt FROM summary_runs`;
const publicRun = ({
  accountId: _a,
  selectionJson: _s,
  requestKey: _k,
  ...run
}: InternalRun): SummaryRun => run;
export function runRepository(db: DatabaseSync) {
  const internal = (id: string) =>
    db.prepare(SELECT + " WHERE id=?").get(id) as unknown as
      | InternalRun
      | undefined;
  const event = (id: string, status: RunStatus) =>
    db
      .prepare(
        "INSERT INTO summary_run_events(run_id,status,created_at) VALUES (?,?,?)",
      )
      .run(id, status, new Date().toISOString());
  const transaction = <T>(fn: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      db.exec("COMMIT");
      return value;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const current = (run: SummaryRun) => {
    const row = db
      .prepare(
        "SELECT revision,source_hash AS hash FROM column_selections WHERE file_id=?",
      )
      .get(run.fileId) as { revision: number; hash: string } | undefined;
    return row?.revision === run.revision && row.hash === run.sourceHash;
  };
  const ownsLease = (owner: string) =>
    !!db
      .prepare(
        "SELECT id FROM summary_queue_lease WHERE owner=? AND expires_at>?",
      )
      .get(owner, Date.now());
  const finish = (
    id: string,
    status: RunStatus,
    error: string | null,
    result: string | null,
  ) => {
    const changed = db
      .prepare(
        "UPDATE summary_runs SET status=?,error=?,result_json=?,finished_at=? WHERE id=? AND status='running'",
      )
      .run(status, error, result, new Date().toISOString(), id).changes;
    if (changed) event(id, status);
    return !!changed;
  };
  return {
    enqueueSummary(
      account: string,
      jobId: string,
      fileId: string,
      revision: number,
      key: string,
    ) {
      return transaction(() => {
        const previous = db
          .prepare(SELECT + " WHERE account_id=? AND request_key=?")
          .get(account, key) as unknown as InternalRun | undefined;
        if (previous) {
          if (
            previous.jobId !== jobId ||
            previous.fileId !== fileId ||
            previous.revision !== revision
          )
            throw new RunError(
              409,
              "같은 요청 식별자로 다른 집계를 접수할 수 없습니다.",
            );
          return { run: publicRun(previous), replayed: true };
        }
        const row = db
          .prepare(
            `SELECT s.sheet_id AS sheetId,s.header_row AS headerRow,s.columns_json AS columnsJson,s.questions_json AS questionsJson,s.source_hash AS sourceHash,s.revision,a.sha256 FROM column_selections s JOIN attachments a ON a.id=s.file_id JOIN jobs j ON j.id=a.job_id WHERE j.account_id=? AND j.id=? AND a.id=?`,
          )
          .get(account, jobId, fileId) as
          | {
              sheetId: string;
              headerRow: number;
              columnsJson: string;
              questionsJson: string;
              sourceHash: string;
              revision: number;
              sha256: string;
            }
          | undefined;
        if (!row || row.revision !== revision || row.sourceHash !== row.sha256)
          throw new RunError(
            409,
            "저장한 원본·선택 버전이 변경되었습니다. 저장 상태를 다시 불러와 주세요.",
          );
        const counts = db
          .prepare(
            "SELECT count(*) AS total, sum(CASE WHEN account_id=? THEN 1 ELSE 0 END) AS owned FROM summary_runs WHERE status IN ('queued','running')",
          )
          .get(account) as { total: number; owned: number | null };
        if (counts.total >= 20 || (counts.owned ?? 0) >= 5)
          throw new RunError(
            429,
            "대기·실행 중인 작업이 많습니다(전체 20개·계정당 5개). 완료 후 다시 접수해 주세요.",
          );
        const id = randomUUID();
        const selection = {
          sheetId: row.sheetId,
          headerRow: row.headerRow,
          columns: JSON.parse(row.columnsJson),
          questions: JSON.parse(row.questionsJson),
          sourceHash: row.sourceHash,
          revision,
        };
        db.prepare(
          `INSERT INTO summary_runs(id,account_id,job_id,file_id,request_key,revision,source_hash,selection_json,status,created_at) VALUES (?,?,?,?,?,?,?,?,'queued',?)`,
        ).run(
          id,
          account,
          jobId,
          fileId,
          key,
          revision,
          row.sourceHash,
          JSON.stringify(selection),
          new Date().toISOString(),
        );
        event(id, "queued");
        return { run: publicRun(internal(id)!), replayed: false };
      });
    },
    listSummaryRuns(
      account: string,
      jobId: string,
      fileId: string,
      limit: number,
      offset: number,
    ) {
      const runs = (
        db
          .prepare(
            SELECT +
              " WHERE account_id=? AND job_id=? AND file_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?",
          )
          .all(
            account,
            jobId,
            fileId,
            limit,
            offset,
          ) as unknown as InternalRun[]
      ).map(publicRun);
      const total = (
        db
          .prepare(
            "SELECT count(*) AS n FROM summary_runs WHERE account_id=? AND job_id=? AND file_id=?",
          )
          .get(account, jobId, fileId) as { n: number }
      ).n;
      return {
        runs,
        page: { total, limit, offset, hasMore: offset + runs.length < total },
      };
    },
    summaryRun(account: string, jobId: string, fileId: string, id: string) {
      const run = internal(id);
      if (
        !run ||
        run.accountId !== account ||
        run.jobId !== jobId ||
        run.fileId !== fileId
      )
        return null;
      return {
        run: publicRun(run),
        events: db
          .prepare(
            "SELECT status,created_at AS createdAt FROM summary_run_events WHERE run_id=? ORDER BY id",
          )
          .all(id),
      };
    },
    summaryRunResult(
      account: string,
      jobId: string,
      fileId: string,
      id: string,
    ) {
      const run = internal(id);
      if (
        !run ||
        run.accountId !== account ||
        run.jobId !== jobId ||
        run.fileId !== fileId
      )
        return null;
      if (run.status !== "completed")
        throw new RunError(409, "완료된 집계 결과가 없습니다.");
      return JSON.parse(
        (
          db
            .prepare(
              "SELECT result_json AS result FROM summary_runs WHERE id=?",
            )
            .get(id) as { result: string }
        ).result,
      );
    },
    cancelSummaryRun(
      account: string,
      jobId: string,
      fileId: string,
      id: string,
    ) {
      return transaction(() => {
        const run = internal(id);
        if (
          !run ||
          run.accountId !== account ||
          run.jobId !== jobId ||
          run.fileId !== fileId
        )
          return null;
        if (run.status === "queued" || run.status === "running") {
          db.prepare(
            "UPDATE summary_runs SET status='cancelled',result_json=NULL,error=NULL,finished_at=? WHERE id=?",
          ).run(new Date().toISOString(), id);
          event(id, "cancelled");
        }
        return publicRun(internal(id)!);
      });
    },
    acquireSummaryLease(owner: string, ttl = 10000) {
      return transaction(() => {
        const changed = db
          .prepare(
            "UPDATE summary_queue_lease SET owner=?,expires_at=? WHERE id=1 AND (expires_at<=? OR owner=?)",
          )
          .run(owner, Date.now() + ttl, Date.now(), owner).changes;
        if (!changed) return false;
        for (const row of db
          .prepare("SELECT id FROM summary_runs WHERE status='running'")
          .all() as { id: string }[])
          finish(
            row.id,
            "failed",
            "서버가 중단되어 집계가 종료되었습니다. 새 작업으로 접수해 주세요.",
            null,
          );
        return true;
      });
    },
    renewSummaryLease(owner: string, ttl = 10000) {
      return !!db
        .prepare(
          "UPDATE summary_queue_lease SET expires_at=? WHERE owner=? AND expires_at>?",
        )
        .run(Date.now() + ttl, owner, Date.now()).changes;
    },
    releaseSummaryLease(owner: string) {
      db.prepare(
        "UPDATE summary_queue_lease SET owner='',expires_at=0 WHERE owner=?",
      ).run(owner);
    },
    claimSummaryRun(owner: string) {
      return transaction(() => {
        if (!ownsLease(owner)) return null;
        const run = db
          .prepare(SELECT + " WHERE status='queued' ORDER BY rowid LIMIT 1")
          .get() as unknown as InternalRun | undefined;
        if (!run) return null;
        db.prepare(
          "UPDATE summary_runs SET status='running',started_at=? WHERE id=? AND status='queued'",
        ).run(new Date().toISOString(), run.id);
        event(run.id, "running");
        return {
          run: publicRun(internal(run.id)!),
          accountId: run.accountId,
          selection: JSON.parse(run.selectionJson) as ColumnSelection,
          settingsCurrent: current(run),
        };
      });
    },
    summaryRunStatus(id: string) {
      return internal(id)?.status ?? null;
    },
    finishSummaryRun(
      owner: string,
      id: string,
      result: unknown,
      error: string | null = null,
    ) {
      return transaction(() => {
        if (!ownsLease(owner)) return false;
        const run = internal(id);
        if (!run || run.status !== "running") return false;
        if (error) return finish(id, "failed", error, null);
        if (!current(run))
          return finish(
            id,
            "failed",
            "실행 중 원본·선택 버전이 변경되었습니다. 새 작업으로 접수해 주세요.",
            null,
          );
        const json = JSON.stringify(result);
        if (!json || Buffer.byteLength(json) > 5 * 1024 * 1024)
          return finish(
            id,
            "failed",
            "집계 결과가 저장 한도 5MiB를 초과했습니다.",
            null,
          );
        return finish(id, "completed", null, json);
      });
    },
  };
}
