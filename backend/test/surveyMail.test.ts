import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fixture } from "./fixture.ts";
import { createStore } from "../src/store.ts";
import { createSummaryQueue } from "../src/summaryQueue.ts";
import { summarize } from "../src/summary.ts";
import { surveyMail } from "../src/surveyMail.ts";
import type { SummaryRun } from "../src/runStore.ts";
const selection = { sheetId: "csv", headerRow: 1, columns: [0, 1], questions: [
  { index: 0, min: 1, max: 5, required: true }, { index: 1, min: 1, max: 5, required: false },
] };
const source = Buffer.from('만족도,선택\n1,5\n5,\n3,합성개별응답_복사금지\n,\n');
const run: SummaryRun = { id: randomUUID(), jobId: randomUUID(), fileId: randomUUID(), status: "completed", revision: 1,
  sourceHash: "a".repeat(64), error: null, createdAt: "2026-11-03T00:00:00.000Z", startedAt: null, finishedAt: "2026-11-03T00:00:01.000Z" };
const summary = (bytes = source) => ({ ...summarize("csv", bytes, null, selection), revision: 1, sourceHash: run.sourceHash, calculatedAt: run.finishedAt });

test("survey mail uses question denominators, stored metadata and deterministic plain UTF-8 text", () => {
  const result = summary(), before = JSON.stringify(result);
  const bytes = surveyMail(result, run), text = bytes.toString("utf8");
  assert.equal(text.charCodeAt(0), 0xfeff);
  assert.match(text, /전체 4행 중 집계 포함 3행.*제외 1행/);
  assert.match(text, /유효 응답 2행, 기준 미충족 1행/);
  assert.match(text, /유효값 합계 9 · 평균 3 · 최솟값 1 · 최댓값 5/); // Includes a value on an invalid whole row.
  assert.match(text, /평균은 각 문항의 모든 유효값 기준/);
  assert.match(text, /AI 생성 아님 · 자동 발송 없음/);
  assert.match(text, /고유 응답자 수가 아닙니다/);
  assert.equal(text.includes("합성개별응답_복사금지"), false); // Never copy individual response/frequency text.
  assert.deepEqual(surveyMail(result, run), bytes);
  assert.equal(JSON.stringify(result), before);
  assert.equal(/(?<!\r)\n/.test(text), false);
});

test("empty data, no valid values, negative scales and rounded means retain exact stored values", () => {
  const empty = surveyMail(summary(Buffer.from("A,B\n,\n")), run).toString("utf8");
  assert.match(empty, /집계 포함 0행/); assert.match(empty, /유효값 없음/);
  const value = { ...summarize("csv", Buffer.from("A,B\n-1,\n-1,\n0,\n"), null,
    { ...selection, questions: [{ index: 0, min: -5, max: 0, required: true }] }), revision: 1, sourceHash: run.sourceHash, calculatedAt: run.finishedAt };
  assert.match(surveyMail(value, run).toString("utf8"), /합계 -2 · 평균 -0.666667/);
});

test("source labels cannot add lines, controls or mail headers; malformed or oversized snapshots are rejected", () => {
  const s = summary(); s.survey!.questions[0].label = '원문\r\nBcc: 가상\u202e' + "😀".repeat(200);
  s.sheetName = "시트\nSubject: 가상";
  const text = surveyMail(s, run).toString("utf8");
  assert.equal(/\r\nBcc:|\r\nSubject:|\u202e|\ufffd/.test(text), false);
  assert.match(text, /표시 생략/);
  for (const change of [{ survey: null }, { includedRows: 9 }, { sourceHash: "b".repeat(64) }, { revision: 2 }, { calculatedAt: "bad-date" }])
    assert.throws(() => surveyMail({ ...summary(), ...change }, run), { status: 409 });
  const damaged = summary(); damaged.survey!.questions[0].validCount = 100;
  assert.throws(() => surveyMail(damaged, run), { status: 409 });
  assert.throws(() => surveyMail(summary(), run, 20), { status: 409 });
});

async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const f = await fixture(), a = await f.account(), b = await f.account();
  const job = (await (await f.post({ kind: "survey", title: "가상 메일 초안", instructions: "가상 통계" }, a.cookie)).json()).job;
  const attachment = (await (await f.upload(job.id, "가상.csv", source, a.cookie)).json()).attachment;
  const base = `/api/jobs/${job.id}/attachments/${attachment.id}`;
  assert.equal((await f.put(base + "/selection", { ...selection, revision: 0 }, a.cookie)).status, 200);
  const store = createStore(f.filename), db = new DatabaseSync(f.filename), queue = createSummaryQueue(store, {pollMs: 10});
  t.after(async () => { await queue.stop(); store.close(); db.close(); await f.cleanup(); });
  const result = await (await f.postJson(base + "/runs", {revision: 1}, a.cookie, {"Idempotency-Key": randomUUID()})).json();
  const id = result.run.id, path = `${base}/runs/${id}/mail-draft`;
  const complete = async () => {
    queue.start();
    for (let n = 0; n < 400; n++) { if (store.summaryRun(a.user.id, job.id, attachment.id, id)!.run.status === "completed") return;
      await new Promise((done) => setTimeout(done, 20)); }
    throw new Error("합성 집계 완료 시간 초과");
  };
  return { f, a, b, job, attachment, store, db, queue, base, id, path, complete };
}

test("mail download enforces ownership, completed survey and query constraints without changing events, artifacts or review", async (t) => {
  const s = await setup(t);
  assert.equal((await s.f.get(s.path, s.a.cookie)).status, 409);
  assert.equal((await s.f.get(s.path)).status, 401);
  assert.equal((await s.f.get(s.path, s.b.cookie)).status, 404);
  assert.equal((await s.f.get(s.path + "?recipient=any", s.a.cookie)).status, 400);
  await s.complete();
  const head = s.store.activityHead(s.a.user.id), before = JSON.stringify(s.store.reviewContext(s.a.user.id, s.job.id, s.attachment.id, s.id));
  assert.equal((await s.f.get(s.path.replace(s.id, randomUUID()), s.a.cookie)).status, 404);
  const other = (await (await s.f.upload(s.job.id, "다른 가상.csv", source, s.a.cookie, randomUUID())).json()).attachment;
  assert.equal((await s.f.get(s.path.replace(s.attachment.id, other.id), s.a.cookie)).status, 404);
  const headBeforeDownload = s.store.activityHead(s.a.user.id);
  const download = await s.f.get(s.path, s.a.cookie), bytes = Buffer.from(await download.arrayBuffer());
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-type")!, /text\/plain/);
  assert.equal(download.headers.get("cache-control"), "no-store");
  assert.equal(download.headers.get("x-content-type-options"), "nosniff");
  assert.match(download.headers.get("content-disposition")!, /attachment;.*\.txt/);
  assert.deepEqual(s.store.activityHead(s.a.user.id), headBeforeDownload);
  await s.f.put(s.base + "/selection", { ...selection, revision: 1, questions: [] }, s.a.cookie);
  const headAfterSelection = s.store.activityHead(s.a.user.id);
  const old = await s.f.get(s.path, s.a.cookie);
  assert.deepEqual(Buffer.from(await old.arrayBuffer()), bytes);
  assert.equal(JSON.stringify(s.store.reviewContext(s.a.user.id, s.job.id, s.attachment.id, s.id)), before);
  assert.deepEqual(s.store.activityHead(s.a.user.id), headAfterSelection);
  assert.equal(s.db.prepare("SELECT count(*) AS n FROM summary_run_artifacts WHERE run_id=?").get(s.id)!.n, 3);
  assert.ok(head.sequence <= headAfterSelection.sequence);
});

test("corrupted JSON and snapshots without survey are conflicts and never partial downloads", async (t) => {
  const s = await setup(t); await s.complete();
  const update = s.db.prepare("UPDATE summary_runs SET result_json=? WHERE id=?");
  const original = s.db.prepare("SELECT result_json AS json FROM summary_runs WHERE id=?").get(s.id)!.json as string;
  for (const value of ["{bad", "null", JSON.stringify({ ...JSON.parse(original), survey: null }), JSON.stringify({ ...JSON.parse(original), revision: 99 })]) {
    update.run(value, s.id);
    const response = await s.f.get(s.path, s.a.cookie);
    assert.equal(response.status, 409); assert.match(response.headers.get("content-type")!, /application\/json/);
  }
});
