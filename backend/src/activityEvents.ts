import type { DatabaseSync } from "node:sqlite";

export const EVENT_TYPES = [
  "job.created",
  "job.imported",
  "attachment.added",
  "selection.saved",
  "run.changed",
  "review.decided",
] as const;
export interface ActivityEvent {
  sequence: number;
  type: (typeof EVENT_TYPES)[number];
  jobId: string;
  fileId: string | null;
  runId: string | null;
  state: string | null;
  revision: number | null;
  createdAt: string;
}
export interface ActivityCursor {
  streamId: string;
  sequence: number;
}
export const cursorText = (cursor: ActivityCursor) =>
  `${cursor.streamId}:${cursor.sequence}`;
export function parseCursor(value: string): ActivityCursor | null {
  const match = /^([a-f0-9]{32}):(0|[1-9][0-9]{0,15})$/.exec(value);
  if (!match || !Number.isSafeInteger(Number(match[2]))) return null;
  return { streamId: match[1]!, sequence: Number(match[2]) };
}
const record = (
  account: string,
  type: ActivityEvent["type"],
  job: string,
  file = "NULL",
  run = "NULL",
  state = "NULL",
  revision = "NULL",
  time = "strftime('%Y-%m-%dT%H:%M:%fZ','now')",
) => `
  UPDATE activity_streams SET sequence=sequence+1 WHERE account_id=${account};
  INSERT INTO activity_events(account_id,sequence,type,job_id,file_id,run_id,state,revision,created_at)
  SELECT account_id,sequence,'${type}',${job},${file},${run},${state},${revision},${time}
  FROM activity_streams WHERE account_id=${account};`;
const jobAccount = "(SELECT account_id FROM jobs WHERE id=NEW.job_id)";
const fileJob = "(SELECT job_id FROM attachments WHERE id=NEW.file_id)";
const fileAccount = `(SELECT j.account_id FROM attachments a JOIN jobs j ON j.id=a.job_id WHERE a.id=NEW.file_id)`;
const runField = (field: string) =>
  `(SELECT ${field} FROM summary_runs WHERE id=NEW.run_id)`;

// Triggers publish inside the business transaction, including writes from the
// independent queue/store connection. Never copy free text, credentials or files.
export const ACTIVITY_SCHEMA = `BEGIN IMMEDIATE;
CREATE TABLE activity_streams (
 account_id TEXT PRIMARY KEY REFERENCES users(id),
 stream_id TEXT NOT NULL UNIQUE DEFAULT(lower(hex(randomblob(16)))),
 sequence INTEGER NOT NULL DEFAULT 0 CHECK(sequence BETWEEN 0 AND 9007199254740991));
CREATE TABLE activity_events (
 account_id TEXT NOT NULL REFERENCES activity_streams(account_id),
 sequence INTEGER NOT NULL CHECK(sequence > 0),
 type TEXT NOT NULL CHECK(type IN (${EVENT_TYPES.map((type) => `'${type}'`).join(",")})),
 job_id TEXT NOT NULL, file_id TEXT, run_id TEXT, state TEXT, revision INTEGER, created_at TEXT NOT NULL,
 PRIMARY KEY(account_id,sequence));
INSERT INTO activity_streams(account_id) SELECT id FROM users;
CREATE TRIGGER activity_user AFTER INSERT ON users BEGIN
 INSERT INTO activity_streams(account_id) VALUES(NEW.id); END;
CREATE TRIGGER activity_job AFTER INSERT ON jobs WHEN NEW.account_id IS NOT NULL BEGIN
 ${record("NEW.account_id", "job.created", "NEW.id", "NULL", "NULL", "NEW.status", "NULL", "NEW.created_at")} END;
CREATE TRIGGER activity_import AFTER UPDATE OF account_id ON jobs
 WHEN OLD.account_id IS NULL AND NEW.account_id IS NOT NULL BEGIN
 ${record("NEW.account_id", "job.imported", "NEW.id", "NULL", "NULL", "NEW.status")} END;
CREATE TRIGGER activity_attachment AFTER INSERT ON attachments WHEN ${jobAccount} IS NOT NULL BEGIN
 ${record(jobAccount, "attachment.added", "NEW.job_id", "NEW.id", "NULL", "NULL", "NULL", "NEW.created_at")} END;
CREATE TRIGGER activity_selection_insert AFTER INSERT ON column_selections WHEN ${fileAccount} IS NOT NULL BEGIN
 ${record(fileAccount, "selection.saved", fileJob, "NEW.file_id", "NULL", "NULL", "NEW.revision", "NEW.updated_at")} END;
CREATE TRIGGER activity_selection_update AFTER UPDATE ON column_selections
 WHEN NEW.revision != OLD.revision AND ${fileAccount} IS NOT NULL BEGIN
 ${record(fileAccount, "selection.saved", fileJob, "NEW.file_id", "NULL", "NULL", "NEW.revision", "NEW.updated_at")} END;
CREATE TRIGGER activity_run AFTER INSERT ON summary_run_events BEGIN
 ${record(runField("account_id"), "run.changed", runField("job_id"), runField("file_id"), "NEW.run_id", "NEW.status", runField("revision"), "NEW.created_at")} END;
CREATE TRIGGER activity_review AFTER INSERT ON summary_run_reviews BEGIN
 ${record("NEW.account_id", "review.decided", runField("job_id"), runField("file_id"), "NEW.run_id", "NEW.decision", "NULL", "NEW.decided_at")} END;
CREATE TRIGGER activity_immutable_update BEFORE UPDATE ON activity_events BEGIN SELECT RAISE(ABORT,'Immutable activity event'); END;
CREATE TRIGGER activity_immutable_delete BEFORE DELETE ON activity_events BEGIN SELECT RAISE(ABORT,'Immutable activity event'); END;
PRAGMA user_version=9; COMMIT;`;

export function activityRepository(db: DatabaseSync) {
  const head = db.prepare(
    "SELECT stream_id AS streamId,sequence FROM activity_streams WHERE account_id=?",
  );
  const events =
    db.prepare(`SELECT sequence,type,job_id AS jobId,file_id AS fileId,run_id AS runId,state,revision,created_at AS createdAt
    FROM activity_events WHERE account_id=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT 100`);
  return {
    activityHead(account: string): ActivityCursor {
      const cursor = head.get(account) as ActivityCursor | undefined;
      if (!cursor) throw new Error("계정 변경 이력을 찾을 수 없습니다.");
      return cursor;
    },
    activityAfter(
      account: string,
      after: number,
      through: number,
    ): ActivityEvent[] {
      if (
        !Number.isSafeInteger(after) ||
        after < 0 ||
        !Number.isSafeInteger(through) ||
        through < after
      )
        throw new Error("변경 이력 범위가 올바르지 않습니다.");
      return events.all(account, after, through) as unknown as ActivityEvent[];
    },
  };
}
