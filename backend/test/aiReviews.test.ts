import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { fixture } from "./fixture.ts";
import { createStore } from "../src/store.ts";
import { dropAiReviewSchema } from "./migrationHelpers.ts";
async function setup() {
  const f = await fixture(), a = await f.account(), b = await f.account(), s = createStore(f.filename), db = new DatabaseSync(f.filename);
  const job = (await (await f.post({ kind: "notice", title: "합성 AI 검토", instructions: "합성 초안 검토" }, a.cookie, randomUUID())).json()).job;
  const config = { mode: "synthetic" as const, model: "synthetic-model", policyId: "synthetic-review-v1" };
  s.acquireAiLease("review-fixture");
  const run = () => {
    const r = s.enqueueAi(a.user.id, job.id, randomUUID(), config)!.run;
    s.claimAi("review-fixture", config);
    s.finishAi("review-fixture", r.id, { jobId: r.id, status: "completed", remoteStatus: "completed", code: null,
      threadId: "synthetic-thread", turnId: "synthetic-turn", text: "합성 <script>초안</script>", needsReview: true });
    return r.id;
  };
  const id = run(), base = `/api/jobs/${job.id}/ai-runs/${id}`;
  const payload = () => ({ targetHash: s.aiReviewState(a.user.id, job.id, id)!.targetHash!, decision: "approved", comment: "합성 의견 <script>문자</script>" });
  return { f, a, b, s, db, job, id, base, run, payload,
    decide: (value: unknown = payload(), key = "synthetic-review-key", cookie = a.cookie, path = base) => f.postJson(path + "/review", value, cookie, { "Idempotency-Key": key }),
    async cleanup() { db.close(); s.close(); await f.cleanup(); } };
}
test("AI 완료 초안에 승인·대상 해시·계정 알림을 원자적으로 기록하고 재시작 뒤 보존한다", async (t) => {
  const f = await setup(); t.after(() => f.cleanup());
  const state = await (await f.f.get(f.base + "/review", f.a.cookie)).json();
  assert.equal(state.reviewable, true); assert.equal(state.decision, null);
  const result = await (await f.f.get(f.base + "/result", f.a.cookie)).json();
  assert.equal(result.reviewTargetHash, state.targetHash); assert.equal(result.sha256, state.resultHash);
  const office = f.s.officeState(f.a.user.id).totals;
  const head = f.s.activityHead(f.a.user.id), response = await f.decide();
  assert.equal(response.status, 201);
  const saved = (await response.json()).decision;
  assert.equal(saved.valid, true); assert.equal(saved.reviewerId, f.a.user.id);
  assert.equal("requestKey" in saved, false); assert.equal(saved.comment, f.payload().comment);
  const events = f.s.activityAfter(f.a.user.id, head.sequence, f.s.activityHead(f.a.user.id).sequence);
  assert.equal(events.length, 1); assert.equal(events[0].type, "review.decided"); assert.equal(events[0].state, "ai.approved");
  assert.equal(events[0].fileId, null); assert.equal(JSON.stringify(events).includes(saved.comment), false);
  await f.f.restart();
  assert.deepEqual((await (await f.f.get(f.base + "/review", f.a.cookie)).json()).decision, saved);
  assert.equal(f.s.aiStatus(f.id), "completed");
  assert.deepEqual(f.s.officeState(f.a.user.id).totals, office);
});
test("AI 검토의 소유권·본문·요청 키·반려 사유·쿼리를 검증한다", async (t) => {
  const f = await setup(); t.after(() => f.cleanup());
  assert.equal((await f.decide(f.payload(), "synthetic-key", "")).status, 401);
  assert.equal((await f.decide(f.payload(), "synthetic-key", f.b.cookie)).status, 404);
  assert.equal((await f.f.get(f.base + "/review", f.b.cookie)).status, 404);
  for (const value of [[], {}, { ...f.payload(), decision: "other" }, { ...f.payload(), comment: " x " },
    { ...f.payload(), comment: "x".repeat(2001) }, { ...f.payload(), decision: "rejected", comment: "" },
    { ...f.payload(), targetHash: "bad" }, { ...f.payload(), extra: true }]) assert.equal((await f.decide(value)).status, 400);
  assert.equal((await f.f.postJson(f.base + "/review", f.payload(), f.a.cookie)).status, 400);
  assert.equal((await f.f.get(f.base + "/review?x=1", f.a.cookie)).status, 400);
  assert.equal((await f.f.postJson(f.base + "/review?x=1", f.payload(), f.a.cookie, { "Idempotency-Key": "synthetic-key" })).status, 400);
  assert.equal((await f.f.postJson(f.base + "/review", f.payload(), f.a.cookie, { "Idempotency-Key": "synthetic-key", Origin: "https://else.invalid" })).status, 403);
  assert.equal((await f.decide({ ...f.payload(), targetHash: "a".repeat(64) })).status, 409);
  assert.equal((await f.decide({ ...f.payload(), decision: "rejected", comment: "합성 수정 사유" })).status, 201);
});
test("AI 검토 동시 재전송은 한 결정이며 키·대상·내용 충돌은 재확정하지 않는다", async (t) => {
  const f = await setup(); t.after(() => f.cleanup());
  const head = f.s.activityHead(f.a.user.id), data = f.payload();
  const responses = await Promise.all([f.decide(data), f.decide(data)]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 201]);
  const values = await Promise.all(responses.map((r) => r.json())); assert.equal(values[0].decision.id, values[1].decision.id);
  assert.equal(f.s.activityHead(f.a.user.id).sequence, head.sequence + 1);
  assert.equal((await f.decide(data, "other-request-key")).status, 409);
  assert.equal((await f.decide({ ...data, decision: "rejected", comment: "다름" })).status, 409);
  const otherId = f.run(), other = `/api/jobs/${f.job.id}/ai-runs/${otherId}`;
  assert.equal((await f.decide({ ...data, targetHash: f.s.aiReviewState(f.a.user.id, f.job.id, otherId)!.targetHash }, "synthetic-review-key", f.a.cookie, other)).status, 409);
  const target = f.s.aiReviewState(f.a.user.id, f.job.id, otherId)!.targetHash;
  const conflict = await Promise.all([
    f.decide({ ...data, targetHash: target }, "concurrent-review-a", f.a.cookie, other),
    f.decide({ ...data, targetHash: target, decision: "rejected", comment: "합성 동시 반려" }, "concurrent-review-b", f.a.cookie, other),
  ]);
  assert.deepEqual(conflict.map((r) => r.status).sort(), [201, 409]);
  assert.throws(() => f.db.prepare("UPDATE ai_run_reviews SET comment='changed' WHERE run_id=?").run(f.id));
  assert.throws(() => f.db.prepare("DELETE FROM ai_run_reviews WHERE run_id=?").run(f.id));
});
test("AI 보관 결과 손상·변경 뒤에는 당시 결정만 보존하고 같은 요청 재생도 유효성을 꾸미지 않는다", async (t) => {
  const f = await setup(); t.after(() => f.cleanup()); const data = f.payload();
  await f.decide(data); const head = f.s.activityHead(f.a.user.id);
  f.db.exec("DROP TRIGGER ai_terminal"); f.db.prepare("UPDATE ai_runs SET result_text='변경된 합성 초안' WHERE id=?").run(f.id);
  let state = await (await f.f.get(f.base + "/review", f.a.cookie)).json();
  assert.equal(state.reviewable, false); assert.equal(state.decision.valid, false);
  assert.equal((await f.f.get(f.base + "/result", f.a.cookie)).status, 409);
  const replay = await f.decide(data); assert.equal(replay.status, 200); assert.equal((await replay.json()).decision.valid, false);
  assert.deepEqual(f.s.activityHead(f.a.user.id), head);
  f.db.prepare("UPDATE ai_runs SET result_hash=? WHERE id=?").run(createHash("sha256").update("변경된 합성 초안").digest("hex"), f.id);
  state = await (await f.f.get(f.base + "/review", f.a.cookie)).json();
  assert.equal(state.reviewable, true); assert.notEqual(state.targetHash, data.targetHash); assert.equal(state.decision.valid, false);
  assert.equal((await f.decide({ ...data, targetHash: state.targetHash }, "new-review-key")).status, 409);
});
test("AI 검토 이벤트 기록 실패는 결정과 커서를 함께 롤백하며 미완료 초안은 결정하지 않는다", async (t) => {
  const f = await setup(); t.after(() => f.cleanup()); const head = f.s.activityHead(f.a.user.id);
  f.db.exec("CREATE TRIGGER synthetic_review_failure BEFORE INSERT ON activity_events WHEN NEW.state='ai.approved' BEGIN SELECT RAISE(ABORT,'synthetic'); END;");
  assert.throws(() => f.s.decideAiReview(f.a.user.id, f.job.id, f.id, "synthetic-key", { ...f.payload(), decision: "approved" }));
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM ai_run_reviews").get()!.n, 0);
  assert.deepEqual(f.s.activityHead(f.a.user.id), head);
  f.db.exec("DROP TRIGGER synthetic_review_failure");
  const job = (await (await f.f.post({ kind: "notice", title: "합성 대기 검토", instructions: "합성" }, f.a.cookie, randomUUID())).json()).job;
  const queued = f.s.enqueueAi(f.a.user.id, job.id, randomUUID(), { mode: "synthetic", model: "synthetic-model", policyId: "synthetic-policy" })!.run;
  const path = `/api/jobs/${job.id}/ai-runs/${queued.id}`;
  assert.equal((await (await f.f.get(path + "/review", f.a.cookie)).json()).reviewable, false);
  assert.equal((await f.decide(f.payload(), "queued-review-key", f.a.cookie, path)).status, 409);
});
test("AI 검토 직전 업무 소유권이 바뀌면 이전 계정과 새 계정 모두 기존 결과 접근을 차단한다", async (t) => {
  const f = await setup(); t.after(() => f.cleanup());
  const data = f.payload();
  f.db.prepare("UPDATE jobs SET account_id=? WHERE id=?").run(f.b.user.id, f.job.id);
  assert.equal((await f.decide(data)).status, 404);
  assert.equal((await f.f.get(f.base + "/review", f.b.cookie)).status, 404);
});
test("v10→v11 추가 마이그레이션은 이력을 보존하고 실패 시 검토 스키마 전체를 롤백한다", async (t) => {
  const f = await setup(); t.after(() => f.cleanup());
  const head = f.s.activityHead(f.a.user.id), previous = f.s.aiRun(f.a.user.id, f.job.id, f.id);
  dropAiReviewSchema(f.db); f.db.exec("PRAGMA user_version=10; CREATE TRIGGER activity_ai_review AFTER INSERT ON jobs BEGIN SELECT 1; END;");
  assert.throws(() => createStore(f.f.filename));
  assert.equal(f.db.prepare("PRAGMA user_version").get()!.user_version, 10);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='ai_run_reviews'").get()!.n, 0);
  f.db.exec("DROP TRIGGER activity_ai_review"); const migrated = createStore(f.f.filename);
  try { assert.deepEqual(migrated.aiRun(f.a.user.id, f.job.id, f.id), previous); assert.deepEqual(migrated.activityHead(f.a.user.id), head); }
  finally { migrated.close(); }
  assert.equal(f.db.prepare("PRAGMA user_version").get()!.user_version, 11);
  assert.equal(f.db.prepare("PRAGMA foreign_key_check").all().length, 0);
});
