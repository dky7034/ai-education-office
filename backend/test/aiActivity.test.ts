import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fixture } from "./fixture.ts";
import { createStore } from "../src/store.ts";
async function setup() {
  const f = await fixture(), a = await f.account(), b = await f.account(), s = createStore(f.filename), db = new DatabaseSync(f.filename);
  let clock = 0;
  const job = async (account = a) => (await (await f.post({ kind: "notice", title: "합성 AI 현황 업무", instructions: "PRIVATE_INPUT_NOT_FOR_METADATA" }, account.cookie, randomUUID())).json()).job;
  const seed = (jobId: string, status: string, review: string | null = null, mode = "synthetic", account = a) => {
    const id = randomUUID(), time = new Date(Date.parse("2026-10-26T01:00:00Z") + clock++ * 1000).toISOString();
    db.prepare(`INSERT INTO ai_runs(id,account_id,job_id,request_key,input_text,mode,model,policy_id,status,remote_status,result_text,result_hash,created_at,started_at,finished_at)
      VALUES(?,?,?,?,?,?,'synthetic-model','synthetic-policy',?,'unknown',?,?,?,?,?)`).run(id, account.user.id, jobId, randomUUID(), "PRIVATE_INPUT_NOT_FOR_METADATA", mode, status,
      status === "completed" ? Buffer.from("PRIVATE_RESULT_NOT_FOR_METADATA") : null, status === "completed" ? "a".repeat(64) : null,
      time, status === "queued" ? null : time, ["queued","running","cancelling"].includes(status) ? null : time);
    if (review) db.prepare("INSERT INTO ai_run_reviews(id,run_id,account_id,request_key,target_hash,manifest_json,decision,comment,decided_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(randomUUID(), id, account.user.id, randomUUID(), "a".repeat(64), "NOT_JSON", review, "PRIVATE_COMMENT_NOT_FOR_METADATA", time);
    return id;
  };
  return { f, a, b, s, db, job, seed, async cleanup() { db.close(); s.close(); await f.cleanup(); } };
}
test("AI 업무별 최근 기록과 전체 진행 건수를 구분하고 페이지/계정 범위에 맞춰 조회한다", async (t) => {
  const f = await setup(); t.after(() => f.cleanup());
  const jobs = [];
  for (let i=0;i<26;i++) { const job=await f.job(); jobs.push(job); f.seed(job.id, "completed", i%2 ? "approved" : null); }
  const running = f.seed(jobs[0].id, "running", null, "codex");
  const latest = f.seed(jobs[0].id, "completed", "rejected");
  const other = await f.job(f.b); f.seed(other.id, "running", null, "codex", f.b);
  const page = f.s.list(f.a.user.id,20,0);
  assert.equal(page.jobs.length,20); assert.ok(page.jobs.every((j) => j.aiActivity.latest?.jobId===j.id));
  const detail = f.s.detail(f.a.user.id,jobs[0].id)!;
  assert.equal(detail.job.aiActivity.active.running,1); assert.equal(detail.job.aiActivity.latest!.runId,latest);
  const office = f.s.aiOfficeState(f.a.user.id);
  assert.equal(office.totals.latestRuns,26); assert.equal(office.totals.running,1);
  assert.equal(office.focus!.runId,running); assert.equal(office.recent.length,5);
  assert.equal(office.totals.codexLatest,0); assert.equal(office.totals.syntheticLatest,26);
  assert.equal(f.s.aiOfficeState(f.b.user.id).totals.latestRuns,1);
  const filtered = f.s.list(f.a.user.id,20,0,{q:"없는합성조건"}); assert.equal(filtered.jobs.length,0);
  assert.equal(f.s.aiOfficeState(f.a.user.id).totals.latestRuns,26);
});
test("AI 읽기 현황은 본문/의견/원본을 읽거나 검토 유효성을 주장하거나 이력을 변경하지 않는다", async (t) => {
  const f=await setup();t.after(()=>f.cleanup());const job=await f.job();f.seed(job.id,"completed","approved");
  const before=f.s.activityHead(f.a.user.id), quantitative=f.s.officeState(f.a.user.id);
  const value=f.s.aiOfficeState(f.a.user.id);
  assert.equal(value.totals.approved,1);assert.equal(value.connectionVerified,false);
  const json=JSON.stringify(value);for(const secret of ["PRIVATE_","NOT_JSON","resultHash","targetHash","inputText"])assert.equal(json.includes(secret),false);
  assert.deepEqual(f.s.officeState(f.a.user.id),quantitative);assert.deepEqual(f.s.activityHead(f.a.user.id),before);
  assert.equal(f.db.prepare("PRAGMA user_version").get()!.user_version,11);
  assert.equal(f.db.prepare("PRAGMA foreign_key_check").all().length,0);
});
test("AI 대표 기록은 실행·중단·대기·검토를 우선하고 새 실행 뒤 과거 승인은 숨긴다", async (t) => {
  const f=await setup();t.after(()=>f.cleanup());const a=await f.job(),b=await f.job(),c=await f.job();
  f.seed(a.id,"completed","approved");const queued=f.seed(a.id,"queued");
  f.seed(b.id,"completed"); const cancelling=f.seed(c.id,"cancelling");
  assert.equal(f.s.aiOfficeState(f.a.user.id).focus!.runId,cancelling);
  assert.equal(f.s.aiOfficeState(f.a.user.id).totals.approved,0);
  f.db.prepare("UPDATE ai_runs SET status='cancelled',finished_at=? WHERE id=?").run(new Date().toISOString(),cancelling);
  assert.equal(f.s.aiOfficeState(f.a.user.id).focus!.runId,queued);
  f.s.cancelAi(f.a.user.id,a.id,queued);
  assert.equal(f.s.aiOfficeState(f.a.user.id).focus!.review,"pending");
});
test("AI 현황 API는 인증·계정 헤더·쿼리·빈 응답을 검증하고 노출 범위를 고정한다", async (t) => {
  const f=await setup();t.after(()=>f.cleanup());
  assert.equal((await f.f.get("/api/jobs/ai-office")).status,401);
  for(const suffix of ["?q=x","?offset=0","?account=x&account=y"])assert.equal((await f.f.get("/api/jobs/ai-office"+suffix,f.a.cookie)).status,400);
  const response=await f.f.get("/api/jobs/ai-office",f.a.cookie);assert.equal(response.headers.get("cache-control"),"no-store");
  const body=await response.json();assert.equal(body.focus,null);assert.deepEqual(body.recent,[]);assert.equal(body.totals.latestRuns,0);
  const mismatched=await fetch(f.f.url()+"/api/jobs/ai-office",{headers:{cookie:f.a.cookie,"X-Office-Account":f.b.user.id}});assert.equal(mismatched.status,401);
});
