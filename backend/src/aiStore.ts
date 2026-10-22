import type { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import type { ExecutionResult } from "./codex/execution.ts";
import { record } from "./codex/protocol.ts";
import { textFits, validId } from "./codex/executionProtocol.ts";

export type AiStatus = "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled" | "timed_out" | "interrupted";
export type AiConfig = { mode: "synthetic" | "codex"; model: string; policyId: string };
export type AiRun = {
  id: string; jobId: string; status: AiStatus; mode: AiConfig["mode"]; model: string;
  code: string | null; remoteStatus: ExecutionResult["remoteStatus"];
  threadId: string | null; turnId: string | null;
  createdAt: string; startedAt: string | null; finishedAt: string | null;
};
type Row = AiRun & { accountId: string; requestKey: string; inputText: string; policyId: string };
export class AiError extends Error {
  status: 409 | 429 | 503;
  constructor(status: 409 | 429 | 503, message: string) { super(message); this.status = status; }
}
const statuses = "'queued','running','cancelling','completed','failed','cancelled','timed_out','interrupted'";
export const AI_SCHEMA = `BEGIN IMMEDIATE;
CREATE TABLE ai_runs (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES users(id), job_id TEXT NOT NULL REFERENCES jobs(id),
 request_key TEXT NOT NULL, input_text TEXT NOT NULL,
 mode TEXT NOT NULL CHECK(mode IN ('synthetic','codex')), model TEXT NOT NULL, policy_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN (${statuses})), code TEXT,
 remote_status TEXT NOT NULL DEFAULT 'unknown' CHECK(remote_status IN ('unknown','inProgress','completed','failed','interrupted')),
 thread_id TEXT, turn_id TEXT, result_text TEXT, result_hash TEXT,
 created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
 UNIQUE(account_id,request_key),
 CHECK((status='completed' AND result_text IS NOT NULL AND result_hash IS NOT NULL) OR (status!='completed' AND result_text IS NULL AND result_hash IS NULL)));
CREATE UNIQUE INDEX ai_active_job ON ai_runs(account_id,job_id) WHERE status IN ('queued','running','cancelling');
CREATE INDEX ai_job_runs ON ai_runs(account_id,job_id,created_at DESC,id DESC);
CREATE INDEX ai_pending ON ai_runs(status,created_at,id);
CREATE TABLE ai_run_events (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES ai_runs(id), status TEXT NOT NULL CHECK(status IN (${statuses})), created_at TEXT NOT NULL);
CREATE TABLE ai_queue_lease (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
INSERT INTO ai_queue_lease VALUES(1,'',0);
CREATE TRIGGER ai_identity BEFORE UPDATE OF id,account_id,job_id,request_key,input_text,mode,model,policy_id,created_at ON ai_runs BEGIN SELECT RAISE(ABORT,'Immutable AI input'); END;
CREATE TRIGGER ai_terminal BEFORE UPDATE ON ai_runs WHEN OLD.status NOT IN ('queued','running','cancelling') BEGIN SELECT RAISE(ABORT,'Immutable AI terminal'); END;
CREATE TRIGGER ai_event_update BEFORE UPDATE ON ai_run_events BEGIN SELECT RAISE(ABORT,'Immutable AI event'); END;
CREATE TRIGGER ai_event_delete BEFORE DELETE ON ai_run_events BEGIN SELECT RAISE(ABORT,'Immutable AI event'); END;
CREATE TRIGGER activity_ai_run AFTER INSERT ON ai_run_events BEGIN
 UPDATE activity_streams SET sequence=sequence+1 WHERE account_id=(SELECT account_id FROM ai_runs WHERE id=NEW.run_id);
 INSERT INTO activity_events(account_id,sequence,type,job_id,file_id,run_id,state,revision,created_at)
 SELECT r.account_id,s.sequence,'run.changed',r.job_id,NULL,r.id,'ai.'||NEW.status,NULL,NEW.created_at
 FROM ai_runs r JOIN activity_streams s ON s.account_id=r.account_id WHERE r.id=NEW.run_id;
END;
PRAGMA user_version=10; COMMIT;`;
const SELECT = `SELECT id,account_id AS accountId,job_id AS jobId,request_key AS requestKey,input_text AS inputText,
 mode,model,policy_id AS policyId,status,code,remote_status AS remoteStatus,thread_id AS threadId,turn_id AS turnId,
 created_at AS createdAt,started_at AS startedAt,finished_at AS finishedAt FROM ai_runs`;
const publicRun = ({ accountId: _a, requestKey: _k, inputText: _i, policyId: _p, ...run }: Row): AiRun => run;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const codes = new Set(["configuration", "version_mismatch", "launch_failed", "protocol_error", "remote_error", "timeout", "closed", "transport_error", "cleanup_failed", "run_timeout", "authentication_required", "policy_mismatch", "execution_error", "interrupt_unconfirmed", "event_limit", "invalid_event", "turn_mismatch", "turn_error", "invalid_item", "unsupported_item", "item_conflict", "item_limit", "invalid_completion", "turn_failed", "invalid_result", "approval_required"]);
export function validAiConfig(value: AiConfig): boolean {
  return !!value && ["synthetic", "codex"].includes(value.mode) && validId(value.policyId)
    && typeof value.model === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(value.model);
}
export function aiRepository(db: DatabaseSync) {
  const transaction = <T>(fn: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  const internal = (id: string) => db.prepare(SELECT + " WHERE id=?").get(id) as Row | undefined;
  const owned = (account: string, job: string, id: string) => db.prepare(SELECT + ` WHERE id=? AND account_id=? AND job_id=?
    AND EXISTS(SELECT 1 FROM jobs j WHERE j.id=ai_runs.job_id AND j.account_id=ai_runs.account_id)`).get(id, account, job) as Row | undefined;
  const ownsJob = (account: string, job: string) => !!db.prepare("SELECT id FROM jobs WHERE id=? AND account_id=?").get(job, account);
  const lease = (owner: string) => !!db.prepare("SELECT id FROM ai_queue_lease WHERE owner=? AND expires_at>?").get(owner, Date.now());
  const event = (id: string, status: AiStatus) => db.prepare("INSERT INTO ai_run_events(run_id,status,created_at) VALUES(?,?,?)").run(id, status, new Date().toISOString());
  const finish = (id: string, status: AiStatus, code: string | null, remote: ExecutionResult["remoteStatus"] = "unknown",
    text: string | null = null, thread: string | null = null, turn: string | null = null) => {
    const changed = db.prepare(`UPDATE ai_runs SET status=?,code=?,remote_status=?,result_text=?,result_hash=?,thread_id=?,turn_id=?,finished_at=?
      WHERE id=? AND status IN ('queued','running','cancelling')`).run(status, code, remote, text, text === null ? null : hash(text), thread, turn, new Date().toISOString(), id).changes;
    if (changed) event(id, status);
    return !!changed;
  };
  return {
    enqueueAi(account: string, job: string, key: string, config?: AiConfig) {
      return transaction(() => {
        if (!ownsJob(account, job)) return null;
        const previous = db.prepare(SELECT + " WHERE account_id=? AND request_key=?").get(account, key) as Row | undefined;
        if (previous) {
          if (previous.jobId !== job) throw new AiError(409, "같은 요청 식별자로 다른 AI 업무를 접수할 수 없습니다.");
          return { run: publicRun(previous), replayed: true };
        }
        if (!config) throw new AiError(503, "AI 실행이 설정되지 않았습니다. 현재 정량 집계와 오피스 시연은 계속 사용할 수 있습니다.");
        if (!validAiConfig(config)) throw new AiError(503, "AI 실행 서버 설정을 확인해 주세요.");
        if (db.prepare("SELECT id FROM ai_runs WHERE account_id=? AND job_id=? AND status IN ('queued','running','cancelling')").get(account, job))
          throw new AiError(409, "이 업무에 대기 또는 실행 중인 AI 작업이 있습니다.");
        const counts = db.prepare("SELECT count(*) AS total,coalesce(sum(account_id=?),0) AS owned FROM ai_runs WHERE status IN ('queued','running','cancelling')").get(account) as { total: number; owned: number };
        if (counts.total >= 20 || counts.owned >= 5) throw new AiError(429, "AI 대기·실행 작업이 많습니다(전체 20개·계정당 5개). 완료 후 다시 접수해 주세요.");
        const input = db.prepare("SELECT kind,title,instructions FROM jobs WHERE id=? AND account_id=?").get(job, account) as {kind: string; title: string; instructions: string};
        const prompt = `다음 업무의 텍스트 초안을 작성하세요. 파일 처리·명령 실행·외부 발송은 하지 마세요.\n업무 종류: ${input.kind}\n제목: ${input.title}\n요청 내용:\n${input.instructions}`;
        if (!textFits(prompt)) throw new AiError(409, "AI 입력은 제목과 안내문을 포함해 UTF-8 16KiB 이하이어야 합니다. 요청 내용을 줄여 새 업무로 접수해 주세요.");
        const id = randomUUID();
        db.prepare("INSERT INTO ai_runs(id,account_id,job_id,request_key,input_text,mode,model,policy_id,status,created_at) VALUES(?,?,?,?,?,?,?,?,'queued',?)")
          .run(id, account, job, key, prompt, config.mode, config.model, config.policyId, new Date().toISOString());
        event(id, "queued");
        return { run: publicRun(internal(id)!), replayed: false };
      });
    },
    listAiRuns(account: string, job: string, limit: number, offset: number) {
      if (!ownsJob(account, job)) return null;
      const runs = (db.prepare(SELECT + " WHERE account_id=? AND job_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?").all(account, job, limit, offset) as Row[]).map(publicRun);
      const total = (db.prepare("SELECT count(*) AS n FROM ai_runs WHERE account_id=? AND job_id=?").get(account, job) as {n: number}).n;
      return { runs, page: { total, limit, offset, hasMore: offset + runs.length < total } };
    },
    aiRun(account: string, job: string, id: string) {
      const run = owned(account, job, id);
      return run ? { run: publicRun(run), events: db.prepare("SELECT status,created_at AS createdAt FROM ai_run_events WHERE run_id=? ORDER BY id").all(id) } : null;
    },
    aiResult(account: string, job: string, id: string) {
      const run = owned(account, job, id);
      if (!run) return null;
      if (run.status !== "completed") throw new AiError(409, "완료된 AI 초안이 없습니다.");
      const saved = db.prepare("SELECT result_text AS text,result_hash AS sha256 FROM ai_runs WHERE id=?").get(id) as {text: string; sha256: string};
      if (!textFits(saved.text) || hash(saved.text) !== saved.sha256) throw new AiError(409, "보관된 AI 결과의 무결성을 확인하지 못했습니다.");
      return { ...saved, needsReview: true, mode: run.mode };
    },
    cancelAi(account: string, job: string, id: string) {
      return transaction(() => {
        const run = owned(account, job, id);
        if (!run) return null;
        if (run.status === "queued") finish(id, "cancelled", null);
        else if (run.status === "running") {
          db.prepare("UPDATE ai_runs SET status='cancelling' WHERE id=? AND status='running'").run(id);
          event(id, "cancelling");
        }
        return publicRun(internal(id)!);
      });
    },
    acquireAiLease(owner: string, ttl = 10_000) {
      return transaction(() => {
        if (!db.prepare("UPDATE ai_queue_lease SET owner=?,expires_at=? WHERE id=1 AND (expires_at<=? OR owner=?)").run(owner, Date.now() + ttl, Date.now(), owner).changes) return false;
        for (const { id } of db.prepare("SELECT id FROM ai_runs WHERE status IN ('running','cancelling')").all() as {id: string}[])
          finish(id, "interrupted", "restart_interrupted");
        return true;
      });
    },
    interruptAi(owner: string, id: string) {
      return transaction(() => lease(owner) && ["running", "cancelling"].includes(internal(id)?.status ?? "")
        ? finish(id, "interrupted", "server_stopped") : false);
    },
    renewAiLease(owner: string, ttl = 10_000) { return !!db.prepare("UPDATE ai_queue_lease SET expires_at=? WHERE owner=? AND expires_at>?").run(Date.now() + ttl, owner, Date.now()).changes; },
    releaseAiLease(owner: string) { db.prepare("UPDATE ai_queue_lease SET owner='',expires_at=0 WHERE owner=?").run(owner); },
    claimAi(owner: string, config: AiConfig) {
      return transaction(() => {
        if (!lease(owner)) return null;
        const row = db.prepare(SELECT + " WHERE status='queued' ORDER BY rowid LIMIT 1").get() as Row | undefined;
        if (!row) return null;
        if (!ownsJob(row.accountId, row.jobId)) { finish(row.id, "failed", "ownership_changed"); return null; }
        if (row.mode !== config.mode || row.model !== config.model || row.policyId !== config.policyId) { finish(row.id, "failed", "configuration_changed"); return null; }
        db.prepare("UPDATE ai_runs SET status='running',started_at=? WHERE id=? AND status='queued'").run(new Date().toISOString(), row.id);
        event(row.id, "running");
        return { id: row.id, input: row.inputText };
      });
    },
    aiStatus(id: string) { return internal(id)?.status ?? null; },
    finishAi(owner: string, id: string, value: unknown) {
      return transaction(() => {
        const row = internal(id);
        if (!lease(owner) || !row || !["running", "cancelling"].includes(row.status)) return false;
        if (!ownsJob(row.accountId, row.jobId)) return finish(id, "failed", "ownership_changed");
        if (!record(value) || value.jobId !== id || (typeof value.status !== "string" || !["completed", "failed", "cancelled", "timed_out"].includes(value.status))
          || (typeof value.remoteStatus !== "string" || !["unknown", "inProgress", "completed", "failed", "interrupted"].includes(value.remoteStatus))
          || !(value.threadId === null || validId(value.threadId)) || !(value.turnId === null || validId(value.turnId)))
          return finish(id, "failed", "invalid_result");
        const result = value as unknown as ExecutionResult;
        const code = result.code === null ? null : codes.has(result.code) ? result.code : "execution_error";
        if (row.status === "cancelling") return finish(id, "cancelled", result.code === "cleanup_failed" ? "cleanup_failed" : result.remoteStatus === "interrupted" ? null : "interrupt_unconfirmed", result.remoteStatus, null, result.threadId, result.turnId);
        if (result.status === "completed" && (!textFits(result.text) || result.remoteStatus !== "completed" || result.needsReview !== true || result.code !== null || !validId(result.threadId) || !validId(result.turnId))) return finish(id, "failed", "invalid_result");
        return finish(id, result.status, code, result.remoteStatus, result.status === "completed" ? result.text : null, result.threadId, result.turnId);
      });
    },
  };
}
