import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { fixture } from "./fixture.ts";
import { createStore } from "../src/store.ts";
import { dropNoticeSchema } from "./migrationHelpers.ts";
import { normalizeNotice, noticeInstructions, noticeDraft, NoticeError } from "../src/noticeDraft.ts";
const notice = {format: "email", purpose: "가상 일정 안내", audience: "가상 과정 참여자", keyPoints: "첫 번째 안내\n두 번째 안내", notes: "검수 후 참고 메모 정리"};
const input = {kind: "notice", title: "가상 교육 안내", notice};

test("notice input is canonical, bounded and rejects ambiguous fields and controls", () => {
  assert.deepEqual(normalizeNotice({...notice, purpose: "  가상 일정 안내 ", keyPoints: "첫 번째 안내\r\n두 번째 안내"}), notice);
  assert.equal(normalizeNotice({...notice, notes: undefined}).notes, "");
  for (const change of [{format: "sms"}, {purpose: " "}, {purpose: "a\nBcc: bad"}, {audience: "a".repeat(301)},
    {keyPoints: "a".repeat(2001)}, {notes: "a".repeat(1001)}, {keyPoints: "bad\0"}, {purpose: "bad\u202e"}, {extra: true}])
    assert.throws(() => normalizeNotice({...notice, ...change}), NoticeError);
  assert.match(noticeInstructions(normalizeNotice(notice)), /목적: 가상 일정 안내/);
});

test("notice draft preserves supplied facts as plain text, sanitizes subject lines and never invents dates or recipients", () => {
  const meta = {id: randomUUID(), createdAt: "2026-11-03T00:00:00.000Z"};
  const bytes = noticeDraft("가상\r\nBcc: 본문", notice, meta), text = bytes.toString();
  assert.equal(text.charCodeAt(0), 0xfeff); assert.equal(/(?<!\r)\n/.test(text), false);
  assert.equal(text.includes("\r\nBcc:"), false); assert.match(text, /규칙 기반 메일 초안/);
  assert.match(text, /작성자 참고 메모 \(공유 전 삭제·반영 여부 확인\)/);
  assert.match(text, /첫 번째 안내\r\n두 번째 안내/);
  assert.match(text, /승인·발송 기록이 아닙니다/);
  assert.deepEqual(noticeDraft("가상\r\nBcc: 본문", notice, meta), bytes);
});

test("structured notice stores atomically and replays canonical requests after restart without breaking legacy jobs", async (t) => {
  const f = await fixture(); t.after(() => f.cleanup()); const a = await f.account();
  const responses = await Promise.all([f.post(input, a.cookie), f.post(input, a.cookie)]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 201]);
  const records = await Promise.all(responses.map((r) => r.json())); const job = records[0].job;
  assert.equal(records[1].job.id, job.id); assert.deepEqual(job.notice, notice);
  assert.match(job.instructions, /가상 일정 안내/); assert.equal(job.executionMode, "not_connected");
  assert.equal((await f.post({...input, notice: {...notice, purpose: "가상 다른 목적"}}, a.cookie)).status, 409);
  assert.equal((await f.post({...input, notice: {...notice, purpose: " 가상 일정 안내 "}}, a.cookie)).status, 200);
  await f.restart();
  assert.deepEqual((await (await f.get(`/api/jobs/${job.id}`, a.cookie)).json()).job.notice, notice);
  assert.equal((await (await f.get(`/api/jobs?q=${encodeURIComponent(notice.audience)}`, a.cookie)).json()).page.total, 1);
  const legacy = await (await f.post({kind: "notice", title: "기존 자유 요청", instructions: "기존 원문"}, a.cookie, "legacy-key")).json();
  assert.equal(legacy.job.notice, undefined);
  assert.equal((await f.get(`/api/jobs/${legacy.job.id}/notice-draft`, a.cookie)).status, 409);
});

test("notice API rejects invalid and mixed payloads before writing any jobs", async (t) => {
  const f = await fixture(); t.after(() => f.cleanup()); const a = await f.account();
  for (const value of [{...input, instructions: "중복 입력"}, {...input, kind: "survey"}, {...input, notice: null}, {...input, notice: {...notice, purpose: ""}},
    {...input, notice: {...notice, recipients: ["no"]}}]) assert.equal((await f.post(value, a.cookie, randomUUID())).status, 400);
  assert.equal((await (await f.get("/api/jobs", a.cookie)).json()).page.total, 0);
});

test("download is owned, read-only, repeatable and scoped by account header", async (t) => {
  const f = await fixture(); t.after(() => f.cleanup()); const a = await f.account(), b = await f.account();
  const job = (await (await f.post(input, a.cookie)).json()).job, path = `/api/jobs/${job.id}/notice-draft`;
  assert.equal((await f.get(path)).status, 401); assert.equal((await f.get(path, b.cookie)).status, 404);
  assert.equal((await f.get(path + "?to=any", a.cookie)).status, 400);
  assert.equal((await fetch(f.url() + path, {headers: {cookie: a.cookie, "X-Office-Account": b.user.id}})).status, 401);
  const store = createStore(f.filename); t.after(async () => store.close());
  const head = store.activityHead(a.user.id), detail = store.detail(a.user.id, job.id);
  const response = await f.get(path, a.cookie), bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, 200); assert.match(response.headers.get("content-type")!, /text\/plain/);
  assert.equal(response.headers.get("cache-control"), "no-store"); assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-disposition")!, /attachment;.*\.txt/);
  assert.deepEqual(Buffer.from(await (await f.get(path, a.cookie)).arrayBuffer()), bytes);
  assert.deepEqual(store.activityHead(a.user.id), head); assert.deepEqual(store.detail(a.user.id, job.id), detail);
});

test("v11 to v12 preserves jobs and cursors and rolls back a failed column migration", async (t) => {
  const f = await fixture(); t.after(() => f.cleanup()); const a = await f.account();
  const job = (await (await f.post({kind: "notice", title: "가상 이전 요청", instructions: "원문 유지"}, a.cookie)).json()).job;
  const db = new DatabaseSync(f.filename); t.after(async () => db.close());
  const before = JSON.stringify(db.prepare("SELECT * FROM jobs").all().map(({notice_json, ...row}) => row));
  dropNoticeSchema(db); db.exec("PRAGMA user_version=11");
  const migrated = createStore(f.filename); assert.equal(migrated.detail(a.user.id, job.id)!.job.instructions, "원문 유지"); migrated.close();
  assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 12);
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM jobs").all().map(({notice_json, ...row}) => row)), before);
  db.exec("PRAGMA user_version=11"); // Inject an already-present column to force ALTER TABLE failure.
  assert.throws(() => createStore(f.filename));
  assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 11);
  assert.equal(db.prepare("PRAGMA quick_check").get()!.quick_check, "ok");
  dropNoticeSchema(db); const retry = createStore(f.filename); retry.close();
});

test("failed job event insertion rolls back structured notice and activity cursor together", async (t) => {
  const f = await fixture(); t.after(() => f.cleanup()); const a = await f.account();
  const db = new DatabaseSync(f.filename), store = createStore(f.filename); t.after(async () => {store.close(); db.close();});
  const head = store.activityHead(a.user.id);
  db.exec("CREATE TRIGGER synthetic_notice_failure BEFORE INSERT ON job_events BEGIN SELECT RAISE(ABORT,'synthetic'); END;");
  assert.equal((await f.post(input, a.cookie)).status, 500);
  assert.equal(db.prepare("SELECT count(*) AS n FROM jobs").get()!.n, 0);
  assert.deepEqual(store.activityHead(a.user.id), head);
});
