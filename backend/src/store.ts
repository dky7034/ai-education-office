import { aiActivities, aiOfficeRepository } from "./aiActivity.ts";
import { AI_REVIEW_SCHEMA, aiReviewRepository } from "./aiReviewStore.ts";
import { AI_SCHEMA, aiRepository } from "./aiStore.ts";
import { officeRepository } from "./officeState.ts";
import { ACTIVITY_SCHEMA, activityRepository } from "./activityEvents.ts";
import { jobWhere, type JobSearch } from "./jobSearch.ts";
import { jobActivities } from "./jobActivity.ts";
import { REVIEW_SCHEMA, reviewRepository } from "./reviewStore.ts";
import { ARTIFACT_SCHEMA } from "./runArtifacts.ts";
import { runRepository, RUN_SCHEMA } from "./runStore.ts";
import type { SurveyQuestion } from "./survey.ts";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const ASSIGNEES = {
  survey: "analyst",
  notice: "writer",
  monitor: "learner",
  excel: "analyst",
  slides: "designer",
  schedule: "coordinator",
} as const;
export type Kind = keyof typeof ASSIGNEES;
export interface RequestInput {
  kind: Kind;
  title: string;
  instructions: string;
}
export interface Job extends RequestInput {
  id: string;
  assignedStaff: string;
  status: "received";
  executionMode: "not_connected";
  createdAt: string;
  updatedAt: string;
}
interface JobRow extends Job {
  owner_id: string;
  request_key: string;
  payload_hash: string;
}
export interface JobEvent {
  id: string;
  jobId: string;
  type: "request_received";
  message: string;
  createdAt: string;
}
export class ConflictError extends Error {}
export interface Attachment {
  id: string;
  jobId: string;
  name: string;
  size: number;
  sha256: string;
  format: "csv" | "xlsx";
  createdAt: string;
}
export interface ColumnSelection {
  questions: SurveyQuestion[];
  sheetId: string;
  headerRow: number;
  columns: number[];
  sourceHash: string;
  revision: number;
  updatedAt: string;
}
export class AttachmentLimitError extends Error {}
export interface Account {
  id: string;
  username: string;
  createdAt: string;
}
export interface AccountRecord extends Account {
  passwordHash: string;
  recoveryHash: string;
}
const publicJob = (row: JobRow): Job => ({
  id: row.id,
  kind: row.kind,
  title: row.title,
  instructions: row.instructions,
  assignedStaff: row.assignedStaff,
  status: row.status,
  executionMode: row.executionMode,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});
const selectJob = `SELECT id, owner_id, request_key, payload_hash, kind, title, instructions, assigned_staff AS assignedStaff, status, execution_mode AS executionMode, created_at AS createdAt, updated_at AS updatedAt FROM jobs`;

export function createStore(
  filename: string,
  attachmentRoot = join(dirname(filename), "attachments"),
  outputRoot = join(dirname(filename), "results"),
) {
  if (filename !== ":memory:")
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  if (filename !== ":memory:") chmodSync(filename, 0o600);
  db.exec(
    "PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;",
  );
  const version = (
    db.prepare("PRAGMA user_version").get() as { user_version: number }
  ).user_version;
  if (version > 11) {
    db.close();
    throw new Error("현재 코드가 지원하는 버전보다 최신 데이터베이스입니다.");
  }
  if (version === 0)
    db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE sessions (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES sessions(id),
      request_key TEXT NOT NULL, payload_hash TEXT NOT NULL, kind TEXT NOT NULL,
      title TEXT NOT NULL, instructions TEXT NOT NULL, assigned_staff TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status = 'received'),
      execution_mode TEXT NOT NULL CHECK(execution_mode = 'not_connected'),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(owner_id, request_key)
    );
    CREATE INDEX jobs_owner_created ON jobs(owner_id, created_at DESC, id DESC);
    CREATE TABLE job_events (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id),
      type TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX events_job_created ON job_events(job_id, created_at, id);
    PRAGMA user_version = 1;
    COMMIT;
  `);
  if (version < 2)
    db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, recovery_hash TEXT NOT NULL, created_at TEXT NOT NULL
    );
    ALTER TABLE sessions ADD COLUMN user_id TEXT REFERENCES users(id);
    ALTER TABLE jobs ADD COLUMN account_id TEXT REFERENCES users(id);
    CREATE UNIQUE INDEX jobs_account_request ON jobs(account_id, request_key) WHERE account_id IS NOT NULL;
    CREATE INDEX jobs_account_created ON jobs(account_id, created_at DESC, id DESC);
    PRAGMA user_version = 2;
    COMMIT;
  `);
  if (version < 3)
    db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id),
      request_key TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL,
      sha256 TEXT NOT NULL, format TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(job_id, request_key)
    );
    PRAGMA user_version = 3;
    COMMIT;
  `);
  if (version < 4)
    db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE column_selections (
      file_id TEXT PRIMARY KEY REFERENCES attachments(id),
      sheet_id TEXT NOT NULL, header_row INTEGER NOT NULL,
      columns_json TEXT NOT NULL, source_hash TEXT NOT NULL,
      revision INTEGER NOT NULL, updated_at TEXT NOT NULL
    );
    PRAGMA user_version = 4;
    COMMIT;
  `);
  if (version < 5)
    db.exec(`
    BEGIN IMMEDIATE;
    ALTER TABLE column_selections ADD COLUMN questions_json TEXT NOT NULL DEFAULT '[]';
    PRAGMA user_version = 5;
    COMMIT;
  `);
  if (version < 6) db.exec(RUN_SCHEMA);
  if (version < 7) db.exec(ARTIFACT_SCHEMA);
  if (version < 8) db.exec(REVIEW_SCHEMA);
  if (version < 9) {
    try {
      db.exec(ACTIVITY_SCHEMA);
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      db.close();
      throw error;
    }
  }
  if (version < 10) {
    try { db.exec(AI_SCHEMA); }
    catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); db.close(); throw error; }
  }
  if (version < 11) {
    try { db.exec(AI_REVIEW_SCHEMA); }
    catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); db.close(); throw error; }
  }
  const selectAttachment = `SELECT id, job_id AS jobId, name, size, sha256, format, created_at AS createdAt FROM attachments`;
  return {
    ...runRepository(db),
    ...aiRepository(db),
    ...aiReviewRepository(db),
    ...reviewRepository(db),
    ...activityRepository(db),
    ...officeRepository(db),
    ...aiOfficeRepository(db),
    outputRoot,
    selection(
      account: string,
      jobId: string,
      fileId: string,
    ): ColumnSelection | null {
      const row = db
        .prepare(
          `SELECT s.sheet_id AS sheetId, s.header_row AS headerRow, s.columns_json AS columnsJson, s.questions_json AS questionsJson, s.source_hash AS sourceHash, s.revision, s.updated_at AS updatedAt FROM column_selections s JOIN attachments a ON a.id = s.file_id JOIN jobs j ON j.id = a.job_id WHERE j.account_id = ? AND j.id = ? AND a.id = ?`,
        )
        .get(account, jobId, fileId) as
        | {
            sheetId: string;
            headerRow: number;
            columnsJson: string;
            questionsJson: string;
            sourceHash: string;
            revision: number;
            updatedAt: string;
          }
        | undefined;
      if (!row) return null;
      const { columnsJson, questionsJson, ...rest } = row;
      return {
        ...rest,
        columns: JSON.parse(columnsJson) as number[],
        questions: JSON.parse(questionsJson) as SurveyQuestion[],
      };
    },
    saveSelection(
      account: string,
      jobId: string,
      fileId: string,
      expectedRevision: number,
      input: {
        sheetId: string;
        headerRow: number;
        columns: number[];
        questions?: SurveyQuestion[];
      },
    ) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const source = db
          .prepare(
            "SELECT a.sha256 FROM attachments a JOIN jobs j ON j.id = a.job_id WHERE j.account_id = ? AND j.id = ? AND a.id = ?",
          )
          .get(account, jobId, fileId) as { sha256: string } | undefined;
        if (!source) throw new Error("첨부 권한 없음");
        const previous = db
          .prepare("SELECT revision FROM column_selections WHERE file_id = ?")
          .get(fileId) as { revision: number } | undefined;
        const revision = previous?.revision ?? 0;
        if (revision !== expectedRevision) throw new ConflictError();
        const updatedAt = new Date().toISOString(),
          columns = [...input.columns].sort((a, b) => a - b);
        db.prepare(
          `INSERT INTO column_selections (file_id, sheet_id, header_row, columns_json, source_hash, revision, updated_at, questions_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(file_id) DO UPDATE SET sheet_id=excluded.sheet_id, header_row=excluded.header_row, columns_json=excluded.columns_json, source_hash=excluded.source_hash, revision=excluded.revision, updated_at=excluded.updated_at, questions_json=excluded.questions_json`,
        ).run(
          fileId,
          input.sheetId,
          input.headerRow,
          JSON.stringify(columns),
          source.sha256,
          revision + 1,
          updatedAt,
          JSON.stringify(input.questions ?? []),
        );
        db.exec("COMMIT");
        return {
          ...input,
          questions: input.questions ?? [],
          columns,
          sourceHash: source.sha256,
          revision: revision + 1,
          updatedAt,
        };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    attachmentPath(jobId: string, id: string) {
      return join(attachmentRoot, jobId, id);
    },
    attachments(account: string, jobId: string) {
      if (
        !db
          .prepare("SELECT id FROM jobs WHERE id = ? AND account_id = ?")
          .get(jobId, account)
      )
        return null;
      return db
        .prepare(`${selectAttachment} WHERE job_id = ? ORDER BY created_at, id`)
        .all(jobId) as unknown as Attachment[];
    },
    saveAttachment(
      account: string,
      jobId: string,
      key: string,
      name: string,
      format: "csv" | "xlsx",
      data: Buffer,
    ) {
      const sha256 = createHash("sha256").update(data).digest("hex");
      let written: string | null = null;
      db.exec("BEGIN IMMEDIATE");
      try {
        if (
          !db
            .prepare("SELECT id FROM jobs WHERE id = ? AND account_id = ?")
            .get(jobId, account)
        )
          throw new Error("업무 권한 없음");
        const existing = db
          .prepare(`${selectAttachment} WHERE job_id = ? AND request_key = ?`)
          .get(jobId, key) as unknown as Attachment | undefined;
        if (existing) {
          if (existing.sha256 !== sha256 || existing.name !== name)
            throw new ConflictError();
          db.exec("COMMIT");
          return { attachment: existing, replayed: true };
        }
        const count = db
          .prepare("SELECT count(*) AS n FROM attachments WHERE job_id = ?")
          .get(jobId) as { n: number };
        if (count.n >= 5) throw new AttachmentLimitError();
        const id = randomUUID(),
          createdAt = new Date().toISOString();
        const folder = join(attachmentRoot, jobId);
        mkdirSync(folder, { recursive: true, mode: 0o700 });
        const path = join(folder, id);
        const fd = openSync(path, "wx", 0o600);
        written = path;
        try {
          writeFileSync(fd, data);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        db.prepare(
          "INSERT INTO attachments VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(id, jobId, key, name, data.length, sha256, format, createdAt);
        db.exec("COMMIT");
        return {
          attachment: {
            id,
            jobId,
            name,
            size: data.length,
            sha256,
            format,
            createdAt,
          },
          replayed: false,
        };
      } catch (error) {
        db.exec("ROLLBACK");
        if (written) unlinkSync(written);
        throw error;
      }
    },
    close: () => db.close(),
    validSession(id: string) {
      return !!db
        .prepare("SELECT id FROM sessions WHERE id = ? AND expires_at > ?")
        .get(id, Date.now());
    },
    addSession(id: string, expires: number) {
      db.prepare("INSERT INTO sessions(id, expires_at) VALUES(?, ?)").run(
        id,
        expires,
      );
    },
    account(username: string) {
      return db
        .prepare(
          "SELECT id, username, password_hash AS passwordHash, recovery_hash AS recoveryHash, created_at AS createdAt FROM users WHERE username = ?",
        )
        .get(username) as unknown as AccountRecord | undefined;
    },
    register(
      username: string,
      passwordHash: string,
      recoveryHash: string,
    ): Account | null {
      const id = randomUUID(),
        now = new Date().toISOString();
      const result = db
        .prepare(
          "INSERT INTO users VALUES (?, ?, ?, ?, ?) ON CONFLICT(username) DO NOTHING",
        )
        .run(id, username, passwordHash, recoveryHash, now);
      return result.changes ? { id, username, createdAt: now } : null;
    },
    addAuthSession(id: string, user: string, expires: number) {
      db.prepare(
        "INSERT INTO sessions(id, expires_at, user_id) VALUES (?, ?, ?)",
      ).run(id, expires, user);
    },
    authSession(id: string): Account | null {
      return (
        (db
          .prepare(
            "SELECT u.id, u.username, u.created_at AS createdAt FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?",
          )
          .get(id, Date.now()) as unknown as Account | undefined) ?? null
      );
    },
    revokeSession(id: string) {
      db.prepare("UPDATE sessions SET expires_at = 0 WHERE id = ?").run(id);
    },
    resetRecovery(user: string, passwordHash: string, recoveryHash: string) {
      return !!db
        .prepare(
          "UPDATE users SET recovery_hash = ? WHERE id = ? AND password_hash = ?",
        )
        .run(recoveryHash, user, passwordHash).changes;
    },
    resetPassword(
      username: string,
      previousRecoveryHash: string,
      passwordHash: string,
      recoveryHash: string,
    ) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = db
          .prepare(
            "UPDATE users SET password_hash = ?, recovery_hash = ? WHERE username = ? AND recovery_hash = ?",
          )
          .run(passwordHash, recoveryHash, username, previousRecoveryHash);
        if (result.changes)
          db.prepare(
            "UPDATE sessions SET expires_at = 0 WHERE user_id = (SELECT id FROM users WHERE username = ?)",
          ).run(username);
        db.exec("COMMIT");
        return !!result.changes;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    legacyCount(owner: string) {
      return (
        db
          .prepare(
            "SELECT count(*) AS n FROM jobs j JOIN sessions s ON s.id = j.owner_id WHERE j.owner_id = ? AND j.account_id IS NULL AND s.user_id IS NULL AND s.expires_at > ?",
          )
          .get(owner, Date.now()) as { n: number }
      ).n;
    },
    importLegacy(owner: string, account: string) {
      // Reserved key namespace cannot collide with client-supplied request keys.
      return Number(
        db
          .prepare(
            `UPDATE jobs SET account_id = ?, request_key = 'legacy:' || id WHERE owner_id = ? AND account_id IS NULL AND EXISTS(SELECT 1 FROM sessions WHERE id = ? AND user_id IS NULL AND expires_at > ?)`,
          )
          .run(account, owner, owner, Date.now()).changes,
      );
    },
    create(
      owner: string,
      key: string,
      input: RequestInput,
      account: string | null = null,
    ) {
      const hash = createHash("sha256")
        .update(JSON.stringify(input))
        .digest("hex");
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = db
          .prepare(
            `${selectJob} WHERE ${account ? "account_id" : "owner_id"} = ? AND request_key = ?`,
          )
          .get(account ?? owner, key) as unknown as JobRow | undefined;
        if (existing) {
          if (existing.payload_hash !== hash) throw new ConflictError();
          db.exec("COMMIT");
          return { job: publicJob(existing), replayed: true };
        }
        const id = randomUUID(),
          now = new Date().toISOString();
        db.prepare(
          `INSERT INTO jobs (id, owner_id, request_key, payload_hash, kind, title, instructions, assigned_staff, status, execution_mode, created_at, updated_at, account_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'received', 'not_connected', ?, ?, ?)`,
        ).run(
          id,
          owner,
          key,
          hash,
          input.kind,
          input.title,
          input.instructions,
          ASSIGNEES[input.kind],
          now,
          now,
          account,
        );
        db.prepare("INSERT INTO job_events VALUES (?, ?, ?, ?, ?)").run(
          randomUUID(),
          id,
          "request_received",
          "업무 요청이 저장되었습니다. 자동 실행은 아직 연결되지 않았습니다.",
          now,
        );
        const row = db
          .prepare(`${selectJob} WHERE id = ? AND owner_id = ?`)
          .get(id, owner) as unknown as JobRow;
        db.exec("COMMIT");
        return { job: publicJob(row), replayed: false };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    list(
      account: string,
      limit: number,
      offset: number,
      search: JobSearch = {},
    ) {
      const filter = jobWhere(account, search);
      const total = (
        db
          .prepare(`SELECT count(*) AS n FROM jobs AS j WHERE ${filter.where}`)
          .get(...filter.params) as { n: number }
      ).n;
      const jobs = db
        .prepare(
          `${selectJob} AS j WHERE ${filter.where} ORDER BY j.created_at DESC, j.id DESC LIMIT ? OFFSET ?`,
        )
        .all(...filter.params, limit, offset) as unknown as JobRow[];
      const activities = jobActivities(
        db,
        account,
        jobs.map((job) => job.id),
      );
      const ai = aiActivities(db, account, jobs.map((job) => job.id));
      return {
        jobs: jobs.map((job) => ({
          ...publicJob(job),
          activity: activities.get(job.id)!,
          aiActivity: ai.get(job.id)!,
        })),
        page: { total, limit, offset, hasMore: offset + jobs.length < total },
        filters: { q: filter.q, status: filter.status },
      };
    },
    detail(account: string, id: string) {
      const row = db
        .prepare(`${selectJob} WHERE account_id = ? AND id = ?`)
        .get(account, id) as unknown as JobRow | undefined;
      if (!row) return null;
      const events = db
        .prepare(
          "SELECT id, job_id AS jobId, type, message, created_at AS createdAt FROM job_events WHERE job_id = ? ORDER BY created_at, id",
        )
        .all(id) as unknown as JobEvent[];
      return {
        job: {
          ...publicJob(row),
          activity: jobActivities(db, account, [id]).get(id)!,
          aiActivity: aiActivities(db, account, [id]).get(id)!,
        },
        events,
      };
    },
  };
}
export type Store = ReturnType<typeof createStore>;
