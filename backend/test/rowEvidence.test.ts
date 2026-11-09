import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { rowEvidence } from "../src/rowEvidence.ts";
import { readXlsx } from "../src/attachments.ts";
import { createStore } from "../src/store.ts";
import { createApp } from "../src/app.ts";
import { fixture } from "./fixture.ts";
import { xlsxFixture } from "./xlsxFixture.ts";
const selection = {sheetId: "csv", headerRow: 1, columns: [0, 2], questions: [], revision: 1, sourceHash: "a".repeat(64), updatedAt: "2026-11-09T00:00:00.000Z"};

test("CSV evidence reads beyond the preview, preserves logical record rows, selected cells and literal formula-like text", () => {
  const csv = Buffer.from('A,B,C\n"가상\n두 줄",비선택,=1+1\n' + '앞,비선택,\n'.repeat(22) + '끝,비선택,  \n');
  const first = rowEvidence("csv", csv, null, selection, 2);
  assert.equal(first.cells[0].value, "가상\n두 줄"); assert.equal(first.cells[1].kind, "value"); assert.equal(first.cells[1].value, "=1+1");
  const last = rowEvidence("csv", csv, null, selection, 25);
  assert.equal(last.rowNumber, 25); assert.equal(last.cells[0].value, "끝"); assert.equal(last.cells[1].kind, "blank");
  assert.equal(JSON.stringify(last).includes("비선택"), false);
});

test("XLSX evidence distinguishes formula/error from lookalike strings and describes sparse rows and raw dates", async () => {
  const bytes = await xlsxFixture(), xml = await readXlsx(bytes), saved = {...selection, sheetId: "0", columns: [0, 1, 2]};
  const first = rowEvidence("xlsx", bytes, xml, saved, 2);
  assert.equal(first.cells[1].kind, "formula"); assert.equal(first.cells[1].value, "[수식: 계산하지 않음]");
  const blank = rowEvidence("xlsx", bytes, xml, saved, 3);
  assert.equal(blank.rowPresent, false); assert.ok(blank.cells.every((c) => c.kind === "blank"));
  const last = rowEvidence("xlsx", bytes, xml, saved, 4);
  assert.equal(last.cells[1].value, "45292"); assert.equal(last.cells[2].kind, "error");
});

test("evidence enforces whole-file limits and valid rows/columns, truncating by Unicode characters", () => {
  const data = Buffer.from("A,B,C\n" + "😀".repeat(2001) + ",,\n");
  const result = rowEvidence("csv", data, null, selection, 2);
  assert.equal(Array.from(result.cells[0].value).length, 2000); assert.equal(result.cells[0].truncated, true);
  assert.equal(result.cells[0].value.includes("\ufffd"), false);
  for (const row of [0, 1, 3, 20001]) assert.throws(() => rowEvidence("csv", data, null, selection, row));
  assert.throws(() => rowEvidence("csv", data, null, {...selection, columns: [99]}, 2));
  assert.throws(() => rowEvidence("csv", Buffer.from("A,B,C\n" + "1,,\n".repeat(20000)), null, selection, 2));

});

async function setup(t: {after: (fn: () => Promise<void>) => void}) {
  const f = await fixture(), a = await f.account(), b = await f.account();
  const job = (await (await f.post({kind: "monitor", title: "가상 자료 근거 확인", instructions: "판정 없이 원문 확인"}, a.cookie)).json()).job;
  const attachment = (await (await f.upload(job.id, "가상.csv", Buffer.from("A,B,C\n가상,비선택,자료\n"), a.cookie)).json()).attachment;
  const base = `/api/jobs/${job.id}/attachments/${attachment.id}`;
  assert.equal((await f.put(base + "/selection", {sheetId: "csv", headerRow: 1, columns: [0, 2], revision: 0}, a.cookie)).status, 200);
  const store = createStore(f.filename);
  t.after(async () => {store.close(); await f.cleanup();});
  return {f, a, b, job, attachment, store, base, path: base + "/evidence?revision=1&row=2"};
}

test("evidence GET is account-scoped, strict, readonly and rejects stale versions and mutated originals", async (t) => {
  const s = await setup(t);
  assert.equal((await s.f.get(s.path)).status, 401); assert.equal((await s.f.get(s.path, s.b.cookie)).status, 404);
  assert.equal((await fetch(s.f.url() + s.path, {headers: {cookie: s.a.cookie, "X-Office-Account": s.b.user.id}})).status, 401);
  for (const query of ["", "?row=2", "?revision=1&row=01", "?revision=1&row=2&row=3", "?revision=1&row=20001", "?revision=1&row=2&sheetId=csv"])
    assert.equal((await s.f.get(s.base + "/evidence" + query, s.a.cookie)).status, 400);
  assert.equal((await s.f.get(s.base + "/evidence?revision=1&row=1", s.a.cookie)).status, 422);
  const head = s.store.activityHead(s.a.user.id), before = s.store.selection(s.a.user.id, s.job.id, s.attachment.id);
  const response = await s.f.get(s.path, s.a.cookie), value = (await response.json()).evidence;
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store"); assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(value.sourceHash, s.attachment.sha256); assert.equal(value.fileId, s.attachment.id); assert.deepEqual(value.cells.map((c: any) => c.index), [0, 2]);
  assert.deepEqual(s.store.activityHead(s.a.user.id), head); assert.deepEqual(s.store.selection(s.a.user.id, s.job.id, s.attachment.id), before);
  await s.f.put(s.base + "/selection", {sheetId: "csv", headerRow: 1, revision: 1, columns: [0]}, s.a.cookie);
  assert.equal((await s.f.get(s.path, s.a.cookie)).status, 409);
  writeFileSync(s.store.attachmentPath(s.job.id, s.attachment.id), "tampered");
  assert.equal((await s.f.get(s.base + "/evidence?revision=2&row=2", s.a.cookie)).status, 409);
});

test("evidence rechecks selection ownership/version after the asynchronous original read", async (t) => {
  const s = await setup(t), store = createStore(s.f.filename), original = store.selection.bind(store); let reads = 0;
  store.selection = (...args) => {const value = original(...args); return value && ++reads > 1 ? {...value, revision: value.revision + 1} : value;};
  const server = createApp(store).listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => {await new Promise<void>((done) => server.close(() => done())); store.close();});
  const url = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  assert.equal((await fetch(url + s.path, {headers: {cookie: s.a.cookie}})).status, 409);
  assert.equal(reads, 2);
});
