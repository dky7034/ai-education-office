import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { copyFile, chmod, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fixture } from "./fixture.ts";
import { createStore } from "../src/store.ts";
import { AiError, type AiConfig } from "../src/aiStore.ts";
import { createAiQueue, codexAiRegistration, type AiRegistration } from "../src/aiQueue.ts";
import type { ExecutionResult } from "../src/codex/execution.ts";
import { dropAiSchema } from "./migrationHelpers.ts";
const config: AiConfig = { mode: "synthetic", model: "synthetic-model", policyId: "synthetic-v1" };
const input = { kind: "notice", title: "합성 AI 초안", instructions: "합성 안내문을 작성해 주세요." };
const output = (id: string, extra: Partial<ExecutionResult> = {}): ExecutionResult => ({
  jobId: id, threadId: "synthetic-thread", turnId: "synthetic-turn", status: "completed",
  code: null, remoteStatus: "completed", text: "합성 초안 <script>문자</script>", needsReview: true, ...extra,
});
async function setup(options: { aiConfig?: AiConfig } = { aiConfig: config }) {
  const f = await fixture(options), a = await f.account(), b = await f.account();
  const job = (await (await f.post(input, a.cookie, randomUUID())).json()).job;
  const other = (await (await f.post(input, b.cookie, randomUUID())).json()).job;
  const store = createStore(f.filename), db = new DatabaseSync(f.filename);
  const base = `/api/jobs/${job.id}/ai-runs`;
  return { f, a, b, job, other, store, db, base,
    enqueue: (key = "synthetic-request", body: unknown = {}, cookie = a.cookie, path = base) =>
      f.postJson(path, body, cookie, { "Idempotency-Key": key }),
    async cleanup() { store.close(); db.close(); await f.cleanup(); } };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 400; i++) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.fail("합성 큐 전환을 확인하지 못했습니다.");
}
function controlled() {
  let dispatches = 0, cancels = 0, closes = 0, id = "", text = "";
  let resolve!: (value: ExecutionResult) => void;
  const registration: AiRegistration = { config, create: () => ({
    run(runId, prompt) { dispatches++; id = runId; text = prompt; return new Promise((done) => { resolve = done; }); },
    cancel() { cancels++; resolve(output(id, { status: "cancelled", remoteStatus: "interrupted", text: null, needsReview: false })); },
    async close() { closes++; },
  }) };
  return { registration, counts: () => ({ dispatches, cancels, closes }), prompt: () => text,
    complete: (extra: Partial<ExecutionResult> = {}) => resolve(output(id, extra)) };
}

test("AI 기본 비활성·소유권·CSRF·고정 입력·조회 형식을 보호한다", async (t) => {
  const f = await setup({}); t.after(() => f.cleanup());
  assert.equal((await f.enqueue()).status, 503);
  assert.equal((await f.enqueue("synthetic-request", {}, f.b.cookie)).status, 404);
  assert.equal((await f.enqueue("synthetic-request", {}, "")).status, 401);
  for (const body of [{ prompt: "임의 지시" }, { apiKey: "synthetic" }, { model: "other" }, []])
    assert.equal((await f.enqueue("synthetic-request", body)).status, 400);
  assert.equal((await f.f.postJson(f.base, {}, f.a.cookie)).status, 400);
  assert.equal((await f.f.postJson(f.base, {}, f.a.cookie, { "Idempotency-Key": "synthetic-request", Origin: "https://else.invalid" })).status, 403);
  const list = await f.f.get(f.base, f.a.cookie);
  assert.equal(list.headers.get("cache-control"), "no-store");
  assert.deepEqual((await list.json()).capability, { configured: false, mode: "disabled" });
  for (const query of ["?limit=21", "?limit=1&limit=2", "?offset=-1", "?offset[]=0", "?q=any"])
    assert.equal((await f.f.get(f.base + query, f.a.cookie)).status, 400);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM ai_runs").get()!.n, 0);
});

test("AI 동시 재접수·활성 업무 중복·다른 업무 키 재사용을 막고 서버 재시작 후 재생한다", async (t) => {
  const options: { aiConfig?: AiConfig } = { aiConfig: config }, f = await setup(options);
  t.after(() => f.cleanup());
  const responses = await Promise.all([f.enqueue(), f.enqueue()]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 202]);
  const runs = await Promise.all(responses.map((r) => r.json()));
  const id = runs[0].run.id; assert.equal(runs[1].run.id, id);
  assert.equal((await f.enqueue("different-active-key")).status, 409);
  assert.equal((await f.enqueue("synthetic-request", {}, f.b.cookie, `/api/jobs/${f.other.id}/ai-runs`)).status, 202);
  const second = (await (await f.f.post(input, f.a.cookie, randomUUID())).json()).job;
  assert.equal((await f.enqueue("synthetic-request", {}, f.a.cookie, `/api/jobs/${second.id}/ai-runs`)).status, 409);
  const head = f.store.activityHead(f.a.user.id);
  options.aiConfig = undefined; await f.f.restart();
  const replay = await f.enqueue(); assert.equal(replay.status, 200); assert.equal((await replay.json()).run.id, id);
  assert.deepEqual(f.store.activityHead(f.a.user.id), head);
  const metadata = await (await f.f.get(f.base + "/" + id, f.a.cookie)).json();
  assert.equal(metadata.events.length, 1); assert.equal(metadata.run.status, "queued");
  for (const field of ["inputText", "requestKey", "accountId", "policyId"]) assert.equal(field in metadata.run, false);
  assert.equal((await f.f.get(f.base + "/" + id + "/result", f.a.cookie)).status, 409);
  assert.equal((await f.f.get(f.base + "/" + id, f.b.cookie)).status, 404);
  assert.equal((await f.f.get(`/api/jobs/${second.id}/ai-runs/${id}`, f.a.cookie)).status, 404);
  assert.equal((await f.enqueue("new-key-disabled")).status, 503);
  assert.equal((await f.f.postJson(f.base + "/" + id + "/cancel", {}, f.a.cookie)).status, 200);
  const cursor = f.store.activityHead(f.a.user.id);
  await f.f.postJson(f.base + "/" + id + "/cancel", {}, f.a.cookie);
  assert.deepEqual(f.store.activityHead(f.a.user.id), cursor);
});

test("AI 계정당 5개 제한과 작업별 페이지를 전체 DB 범위에서 적용한다", async (t) => {
  const f = await setup(); t.after(() => f.cleanup());
  for (let i = 0; i < 5; i++) {
    const job = i ? (await (await f.f.post(input, f.a.cookie, randomUUID())).json()).job : f.job;
    assert.ok(f.store.enqueueAi(f.a.user.id, job.id, "quota-key-" + i, config));
  }
  const sixth = (await (await f.f.post(input, f.a.cookie, randomUUID())).json()).job;
  assert.throws(() => f.store.enqueueAi(f.a.user.id, sixth.id, "quota-over-limit", config), (e: unknown) => e instanceof AiError && e.status === 429);
  const first = f.store.listAiRuns(f.a.user.id, f.job.id, 20, 0)!.runs[0];
  f.store.cancelAi(f.a.user.id, f.job.id, first.id);
  f.store.enqueueAi(f.a.user.id, f.job.id, "after-cancel-key", config);
  const page = await (await f.f.get(f.base + "?limit=1", f.a.cookie)).json();
  assert.equal(page.page.total, 2); assert.equal(page.runs.length, 1); assert.equal(page.page.hasMore, true);
  const next = await (await f.f.get(f.base + "?limit=1&offset=1", f.a.cookie)).json();
  assert.notEqual(next.runs[0].id, page.runs[0].id);
});

test("AI lease 인수는 실행/취소 중 작업을 미확정 종료하고 대기만 이어 처리한다", async (t) => {
  const f = await setup(); t.after(() => f.cleanup());
  const first = (await (await f.enqueue()).json()).run;
  const secondJob = (await (await f.f.post(input, f.a.cookie, randomUUID())).json()).job;
  const second = f.store.enqueueAi(f.a.user.id, secondJob.id, "queued-second-key", config)!.run;
  assert.equal(f.store.acquireAiLease("owner-a"), true);
  assert.equal(f.store.acquireAiLease("owner-b"), false);
  assert.equal(f.store.claimAi("owner-a", config)!.id, first.id);
  f.store.cancelAi(f.a.user.id, f.job.id, first.id);
  f.db.prepare("UPDATE ai_queue_lease SET expires_at=0").run();
  assert.equal(f.store.renewAiLease("owner-a"), false);
  assert.equal(f.store.acquireAiLease("owner-b"), true);
  const recovered = f.store.aiRun(f.a.user.id, f.job.id, first.id)!.run;
  assert.equal(recovered.status, "interrupted"); assert.equal(recovered.remoteStatus, "unknown");
  assert.equal(recovered.code, "restart_interrupted");
  assert.equal(f.store.finishAi("owner-a", first.id, output(first.id)), false);
  assert.equal(f.store.claimAi("owner-b", config)!.id, second.id);
  assert.equal(f.store.claimAi("owner-a", config), null);
  assert.equal(f.store.finishAi("owner-b", first.id, output(first.id)), false);
  assert.throws(() => f.db.prepare("UPDATE ai_runs SET status='queued' WHERE id=?").run(first.id));
});

test("AI 입력·상태·영구 이벤트를 같은 트랜잭션으로 기록하고 실패 시 롤백한다", async (t) => {
  const f = await setup(); t.after(() => f.cleanup());
  const head = f.store.activityHead(f.a.user.id);
  f.db.exec("CREATE TRIGGER synthetic_ai_failure BEFORE INSERT ON activity_events WHEN NEW.state LIKE 'ai.%' BEGIN SELECT RAISE(ABORT,'synthetic'); END;");
  assert.throws(() => f.store.enqueueAi(f.a.user.id, f.job.id, "synthetic-request", config));
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM ai_runs").get()!.n, 0);
  assert.deepEqual(f.store.activityHead(f.a.user.id), head);
  f.db.exec("DROP TRIGGER synthetic_ai_failure");
  const id = f.store.enqueueAi(f.a.user.id, f.job.id, "synthetic-request", config)!.run.id;
  f.store.acquireAiLease("owner"); f.store.claimAi("owner", config);
  const before = f.store.activityHead(f.a.user.id);
  f.db.exec("CREATE TRIGGER synthetic_ai_failure BEFORE INSERT ON activity_events WHEN NEW.state LIKE 'ai.%' BEGIN SELECT RAISE(ABORT,'synthetic'); END;");
  assert.throws(() => f.store.finishAi("owner", id, output(id)));
  assert.throws(() => f.store.cancelAi(f.a.user.id, f.job.id, id));
  assert.equal(f.store.aiStatus(id), "running"); assert.deepEqual(f.store.activityHead(f.a.user.id), before);
  assert.equal(f.db.prepare("SELECT result_text FROM ai_runs WHERE id=?").get(id)!.result_text, null);
});

test("AI 큐는 snapshot으로 한 번 실행하고 검수 필요 결과·해시를 재시작 후 보존한다", async (t) => {
  const f = await setup(); t.after(() => f.cleanup());
  const id = (await (await f.enqueue()).json()).run.id, executor = controlled();
  f.db.prepare("UPDATE jobs SET instructions=? WHERE id=?").run("접수 뒤 바뀐 합성 지시", f.job.id);
  assert.throws(() => f.db.prepare("UPDATE ai_runs SET input_text='changed' WHERE id=?").run(id));
  const queue = createAiQueue(f.store, executor.registration, { pollMs: 10 });
  t.after(() => queue.stop()); queue.start();
  await until(() => executor.counts().dispatches === 1);
  assert.match(executor.prompt(), /합성 안내문/);
  assert.equal(executor.prompt().includes("접수 뒤 바뀐"), false);
  const other = createAiQueue(f.store, executor.registration, { pollMs: 10 });
  t.after(() => other.stop()); other.start();
  executor.complete();
  await until(() => f.store.aiStatus(id) === "completed");
  await queue.stop(); await other.stop();
  assert.equal(executor.counts().dispatches, 1);
  const result = await (await f.f.get(f.base + "/" + id + "/result", f.a.cookie)).json();
  assert.equal(result.needsReview, true); assert.equal(result.mode, "synthetic"); assert.match(result.text, /<script>/);
  await f.f.restart();
  assert.deepEqual(await (await f.f.get(f.base + "/" + id + "/result", f.a.cookie)).json(), result);
  const events = f.store.activityAfter(f.a.user.id, 0, f.store.activityHead(f.a.user.id).sequence);
  assert.deepEqual(events.filter((e) => e.runId === id).map((e) => e.state), ["ai.queued", "ai.running", "ai.completed"]);
  assert.equal(events.some((e) => e.runId === id && e.fileId !== null), false);
  assert.throws(() => f.db.prepare("UPDATE ai_run_events SET status='queued' WHERE run_id=?").run(id));
  assert.throws(() => f.db.prepare("UPDATE ai_runs SET input_text='changed' WHERE id=?").run(id));
});

test("AI 실행 중 취소는 cancelling을 유지하고 완료와 경합해도 결과를 저장하지 않는다", async (t) => {
  const f = await setup(); t.after(() => f.cleanup());
  const id = (await (await f.enqueue()).json()).run.id, executor = controlled();
  const queue = createAiQueue(f.store, executor.registration, { pollMs: 10 }); t.after(() => queue.stop()); queue.start();
  await until(() => executor.counts().dispatches === 1);
  const response = await f.f.postJson(f.base + "/" + id + "/cancel", {}, f.a.cookie);
  assert.equal(response.status, 202);
  assert.equal((await response.json()).run.status, "cancelling");
  executor.complete(); // remote completion races with the durable cancellation request.
  await until(() => f.store.aiStatus(id) === "cancelled");
  assert.equal(f.store.aiRun(f.a.user.id, f.job.id, id)!.run.remoteStatus, "completed");
  assert.throws(() => f.store.aiResult(f.a.user.id, f.job.id, id));
  await queue.stop();
});

test("AI 큐 취소·시간 초과·정상 종료는 executor 정리 후 확정하며 재시작 때 재전송하지 않는다", async (t) => {
  for (const action of ["cancel", "timeout", "stop"] as const) {
    const f = await setup();
    try {
      const id = (await (await f.enqueue()).json()).run.id, executor = controlled();
      const queue = createAiQueue(f.store, executor.registration, { pollMs: 10, timeoutMs: action === "timeout" ? 100 : 5000 });
      queue.start();
      await until(() => executor.counts().dispatches === 1);
      if (action === "cancel") f.store.cancelAi(f.a.user.id, f.job.id, id);
      else if (action === "stop") await queue.stop();
      await until(() => !["queued", "running", "cancelling"].includes(f.store.aiStatus(id)!));
      await queue.stop();
      assert.equal(f.store.aiStatus(id), action === "cancel" ? "cancelled" : action === "stop" ? "interrupted" : "timed_out");
      assert.equal(executor.counts().closes, 1);
      if (action === "cancel") assert.equal(executor.counts().cancels, 1);
      const restart = createAiQueue(f.store, executor.registration, { pollMs: 10 }); restart.start(); await restart.stop();
      assert.equal(executor.counts().dispatches, 1);
    } finally { await f.cleanup(); }
  }
});

test("AI 잘못된 결과·등록 설정 변경·실행 오류는 본문 유출 없이 실패로 기록한다", async (t) => {
  const f = await setup(); t.after(() => f.cleanup());
  let id = (await (await f.enqueue()).json()).run.id;
  f.store.acquireAiLease("owner"); f.store.claimAi("owner", config);
  f.store.finishAi("owner", id, output(id, { text: "" }));
  assert.equal(f.store.aiStatus(id), "failed");
  id = f.store.enqueueAi(f.a.user.id, f.job.id, "unsafe-code-key", config)!.run.id;
  f.store.claimAi("owner", config);
  f.store.finishAi("owner", id, output(id, { status: "failed", text: null, code: "synthetic-private-marker", needsReview: false }));
  assert.equal(f.store.aiRun(f.a.user.id, f.job.id, id)!.run.code, "execution_error");
  id = f.store.enqueueAi(f.a.user.id, f.job.id, "new-config-key", config)!.run.id;
  assert.equal(f.store.claimAi("owner", { ...config, policyId: "changed" }), null);
  assert.equal(f.store.aiRun(f.a.user.id, f.job.id, id)!.run.code, "configuration_changed");
});

test("v9→v10 마이그레이션은 기존 이력을 보존하고 실패한 추가 스키마 전체를 롤백한다", async (t) => {
  const f = await setup(); t.after(() => f.cleanup());
  const before = f.store.activityHead(f.a.user.id), job = f.store.detail(f.a.user.id, f.job.id);
  dropAiSchema(f.db); f.db.exec("PRAGMA user_version=9; CREATE TABLE ai_queue_lease(synthetic INTEGER);");
  assert.throws(() => createStore(f.f.filename));
  assert.equal(f.db.prepare("PRAGMA user_version").get()!.user_version, 9);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='ai_runs'").get()!.n, 0);
  f.db.exec("DROP TABLE ai_queue_lease");
  const migrated = createStore(f.f.filename); t.after(() => migrated.close());
  assert.deepEqual(migrated.detail(f.a.user.id, f.job.id), job);
  assert.deepEqual(migrated.activityHead(f.a.user.id), before);
  assert.equal(f.db.prepare("PRAGMA user_version").get()!.user_version, 10);
  assert.equal(f.db.prepare("PRAGMA quick_check").get()!.quick_check, "ok");
  assert.equal(f.db.prepare("PRAGMA foreign_key_check").all().length, 0);
});

test("합성 Codex stdio → AI 큐 → 영구 결과의 계약을 실제 모델 호출 없이 확인한다", async (t) => {
  const f = await setup(); t.after(() => f.cleanup());
  const root = dirname(f.f.filename), path = join(root, "codex-server.mjs");
  for (const filename of ["codex-server.mjs", "codex-execution.mjs"])
    await copyFile(new URL("./fixtures/" + filename, import.meta.url), join(root, filename));
  await writeFile(path, `#!${process.execPath}\n${await readFile(path, "utf8")}`); await chmod(path, 0o700);
  await writeFile(join(root, "config.mjs"), `export const config=${JSON.stringify({ mode: "exec-ok", observations: join(root, "synthetic-observations") })};`);
  const registration = codexAiRegistration({ executable: path, serviceApiKey: "synthetic-service-key", policy: {
    allowPaidCalls: true, allowDataTransfer: true, executionIsolationReviewed: true, model: config.model, maxRunMs: 5000,
  } }, config.policyId);
  // Keep the externally visible source truthful: this peer is synthetic.
  registration.config.mode = "synthetic";
  const id = (await (await f.enqueue()).json()).run.id;
  const queue = createAiQueue(f.store, registration, { pollMs: 10 }); t.after(() => queue.stop()); queue.start();
  await until(() => f.store.aiStatus(id) === "completed");
  await queue.stop();
  assert.equal(f.store.aiResult(f.a.user.id, f.job.id, id)!.text, "합성 설문 요약 초안");
  assert.equal(f.store.aiRun(f.a.user.id, f.job.id, id)!.run.mode, "synthetic");
});


test("AI 전체 20개 제한은 다른 계정의 대기를 포함하되 결과는 계정별로 격리한다", async (t) => {
  const f = await setup(); t.after(() => f.cleanup());
  const accounts = [f.a, f.b, await f.f.account(), await f.f.account()];
  for (const account of accounts) for (let i = 0; i < 5; i++) {
    const job = (await (await f.f.post(input, account.cookie, randomUUID())).json()).job;
    f.store.enqueueAi(account.user.id, job.id, randomUUID(), config);
  }
  const newAccount = await f.f.account();
  const job = (await (await f.f.post(input, newAccount.cookie, randomUUID())).json()).job;
  assert.throws(() => f.store.enqueueAi(newAccount.user.id, job.id, randomUUID(), config), (e: unknown) => e instanceof AiError && e.status === 429);
});

test("AI lease를 잃은 실행기는 닫히고 늦은 결과는 새 소유자의 복구 상태를 덮어쓰지 않는다", async (t) => {
  const f = await setup(); t.after(() => f.cleanup());
  const id = (await (await f.enqueue()).json()).run.id, executor = controlled();
  const queue = createAiQueue(f.store, executor.registration, { pollMs: 10 }); queue.start();
  try {
    await until(() => executor.counts().dispatches === 1);
    f.db.prepare("UPDATE ai_queue_lease SET owner='replacement',expires_at=?").run(Date.now() + 10000);
    await until(() => executor.counts().closes === 1);
    f.db.exec("UPDATE ai_queue_lease SET expires_at=0");
    assert.equal(f.store.acquireAiLease("replacement"), true);
    executor.complete();
    await queue.stop();
    assert.equal(f.store.aiStatus(id), "interrupted");
    assert.equal(executor.counts().dispatches, 1);
    assert.equal(f.store.finishAi("stale-owner", id, output(id)), false);
  } finally { await queue.stop(); }
});

test("AI 비활성 큐는 미확정 실행만 복구하고 대기를 디스패치하지 않는다", async (t) => {
  const f = await setup(); t.after(() => f.cleanup());
  const id = (await (await f.enqueue()).json()).run.id;
  f.store.acquireAiLease("old"); f.store.claimAi("old", config);
  f.db.exec("UPDATE ai_queue_lease SET expires_at=0");
  const job = (await (await f.f.post(input, f.a.cookie, randomUUID())).json()).job;
  const queued = f.store.enqueueAi(f.a.user.id, job.id, "waiting-after-restart", config)!.run.id;
  const queue = createAiQueue(f.store); queue.start(); await queue.stop();
  assert.equal(f.store.aiStatus(id), "interrupted"); assert.equal(f.store.aiStatus(queued), "queued");
});

test("AI 실행기 시작 실패는 재시도 없이 실패를 확정하고 보관 텍스트 변조를 검출한다", async (t) => {
  const f = await setup(); t.after(() => f.cleanup());
  let id = (await (await f.enqueue()).json()).run.id, creates = 0;
  const queue = createAiQueue(f.store, { config, create() { creates++; throw new Error("synthetic-private-marker"); } }, { pollMs: 10 });
  queue.start();
  await until(() => f.store.aiStatus(id) === "failed"); await queue.stop();
  assert.equal(creates, 1); assert.equal(f.store.aiRun(f.a.user.id, f.job.id, id)!.run.code, "configuration");
  id = f.store.enqueueAi(f.a.user.id, f.job.id, "saved-result-key", config)!.run.id;
  f.store.acquireAiLease("verify"); f.store.claimAi("verify", config); f.store.finishAi("verify", id, output(id));
  f.db.exec("DROP TRIGGER ai_terminal");
  f.db.prepare("UPDATE ai_runs SET result_text='changed' WHERE id=?").run(id);
  assert.equal((await f.f.get(f.base + "/" + id + "/result", f.a.cookie)).status, 409);
});


test("AI 실행기 정리 실패 후에는 다음 대기 작업을 자동 실행하지 않는다", async (t) => {
  const f = await setup(); t.after(() => f.cleanup());
  const id = (await (await f.enqueue()).json()).run.id;
  const job = (await (await f.f.post(input, f.a.cookie, randomUUID())).json()).job;
  const waiting = f.store.enqueueAi(f.a.user.id, job.id, "waiting-after-close-error", config)!.run.id;
  let calls = 0;
  const queue = createAiQueue(f.store, { config, create: () => ({
    async run(id) { calls++; return output(id); }, cancel() {}, async close() { throw new Error("synthetic-private-marker"); },
  }) }, { pollMs: 10 });
  queue.start();
  await until(() => f.store.aiStatus(id) === "failed");
  await new Promise((resolve) => setTimeout(resolve, 40));
  await queue.stop();
  assert.equal(calls, 1); assert.equal(f.store.aiStatus(waiting), "queued");
  assert.equal(f.store.aiRun(f.a.user.id, f.job.id, id)!.run.code, "cleanup_failed");
});

test("AI 소유권이 바뀐 업무는 실행 전과 결과 확정 때 다시 차단한다", async (t) => {
  const f = await setup(); t.after(() => f.cleanup());
  const id = (await (await f.enqueue()).json()).run.id;
  f.store.acquireAiLease("owner"); f.store.claimAi("owner", config);
  f.db.prepare("UPDATE jobs SET account_id=? WHERE id=?").run(f.b.user.id, f.job.id);
  f.store.finishAi("owner", id, output(id));
  assert.equal(f.store.aiStatus(id), "failed");
  assert.equal(f.store.aiRun(f.a.user.id, f.job.id, id), null);
  assert.equal(f.store.aiRun(f.b.user.id, f.job.id, id), null);
  assert.equal(f.db.prepare("SELECT result_text FROM ai_runs WHERE id=?").get(id)!.result_text, null);
});
