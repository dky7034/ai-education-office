import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { monitorMappings } from "../src/monitoring.ts";
import { fixture } from "./fixture.ts";
import { createStore } from "../src/store.ts";
import { createSummaryQueue } from "../src/summaryQueue.ts";
import { dropMonitoringSchema } from "./migrationHelpers.ts";
const mappings = [{index: 0, metric: "attendance", label: "가상 출석 기록", unit: "%"}, {index: 1, metric: "reference", label: "가상 참고", unit: ""}];
const settings = {sheetId: "csv", headerRow: 1, columns: [0, 1], revision: 0};
async function setup(t: {after: (fn: () => Promise<void>) => void}) {
  const f = await fixture(), a = await f.account(), b = await f.account();
  const job = (await (await f.post({kind: "monitor", title: "가상 지표 연결", instructions: "판정 없이 자료 확인"}, a.cookie)).json()).job;
  const file = (await (await f.upload(job.id, "가상.csv", Buffer.from("기록,참고\n90,가상 문구\n80,다음 문구\n"), a.cookie)).json()).attachment;
  const base = `/api/jobs/${job.id}/attachments/${file.id}`, store = createStore(f.filename), db = new DatabaseSync(f.filename);
  t.after(async () => {store.close(); db.close(); await f.cleanup();});
  const save = (value: unknown, cookie = a.cookie) => f.put(base + "/selection", value, cookie);
  return {f, a, b, job, file, base, store, db, save};
}

test("mapping validates selected columns, labels, units and maximum count without accepting scoring rules", () => {
  assert.deepEqual(monitorMappings([{...mappings[1]}, {...mappings[0], label: " 가상 출석 기록 "}], [0, 1]), mappings);
  for (const value of [[{...mappings[0], index: 9}], [mappings[0], mappings[0]], [{...mappings[0], metric: "risk"}], [{...mappings[0], label: ""}],
    [{...mappings[0], label: "a".repeat(61)}], [{...mappings[0], unit: "a".repeat(21)}], [{...mappings[0], label: "a\nb"}],
    [{...mappings[0], threshold: 80}], Array.from({length: 11}, (_, index) => ({...mappings[0], index}))]) assert.throws(() => monitorMappings(value, [0, 1]));
});

test("mapping is persisted by version and linked to raw row cells without numeric conversion or decisions", async (t) => {
  const s = await setup(t);
  const saved = await s.save({...settings, monitoring: mappings}); assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).selection.monitoring, mappings);
  await s.f.restart();
  const preview = await (await s.f.get(s.base + "/preview", s.a.cookie)).json();
  assert.deepEqual(preview.selection.monitoring, mappings);
  const response = await s.f.get(s.base + "/evidence?revision=1&row=2", s.a.cookie), result = (await response.json()).evidence;
  assert.equal(response.status, 200); assert.equal(result.cells[0].value, "90"); assert.deepEqual(result.cells[0].mapping, mappings[0]);
  assert.equal(result.cells[0].kind, "value"); assert.equal("judgment" in result, false); assert.equal("score" in result, false);
});

test("omitted mappings preserve compatible scope, column removal filters, explicit empty clears, header change resets", async (t) => {
  const s = await setup(t); await s.save({...settings, monitoring: mappings});
  let r = await s.save({...settings, revision: 1}); assert.deepEqual((await r.json()).selection.monitoring, mappings);
  r = await s.save({...settings, revision: 2, columns: [1]}); assert.deepEqual((await r.json()).selection.monitoring, [mappings[1]]);
  r = await s.save({...settings, revision: 3, columns: [1], monitoring: []}); assert.deepEqual((await r.json()).selection.monitoring, []);
  await s.save({...settings, revision: 4, monitoring: mappings});
  r = await s.save({...settings, revision: 5, headerRow: 2}); assert.deepEqual((await r.json()).selection.monitoring, []);
});

test("mapping changes enforce ownership, optimistic concurrency and invalid-input rollback", async (t) => {
  const s = await setup(t); await s.save(settings);
  assert.equal((await s.save({...settings, revision: 1, monitoring: mappings}, s.b.cookie)).status, 404);
  const responses = await Promise.all([s.save({...settings, revision: 1, monitoring: mappings}), s.save({...settings, revision: 1, monitoring: []})]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  const head = s.store.activityHead(s.a.user.id), before = s.store.selection(s.a.user.id, s.job.id, s.file.id);
  assert.equal((await s.save({...settings, revision: 2, monitoring: [{...mappings[0], index: 99}]})).status, 422);
  assert.deepEqual(s.store.selection(s.a.user.id, s.job.id, s.file.id), before); assert.deepEqual(s.store.activityHead(s.a.user.id), head);
  assert.equal((await s.f.get(s.base + "/evidence?revision=1&row=2", s.a.cookie)).status, 409);
});

test("mapping updates leave stored quantitative results, artifacts and review targets unchanged", async (t) => {
  const s = await setup(t); await s.save(settings);
  const run = (await (await s.f.postJson(s.base + "/runs", {revision: 1}, s.a.cookie, {"Idempotency-Key": randomUUID()})).json()).run;
  const queue = createSummaryQueue(s.store, {pollMs: 10}); t.after(() => queue.stop()); queue.start();
  let completed = false;
  for (let n = 0; n < 400; n++) {if (s.store.summaryRun(s.a.user.id, s.job.id, s.file.id, run.id)!.run.status === "completed") {completed = true; break;} await new Promise((done) => setTimeout(done, 20));}
  assert.equal(completed, true); await queue.stop();
  const before = JSON.stringify(s.store.reviewContext(s.a.user.id, s.job.id, s.file.id, run.id));
  const result = JSON.stringify(s.store.summaryRunResult(s.a.user.id, s.job.id, s.file.id, run.id));
  assert.equal((await s.save({...settings, revision: 1, monitoring: mappings})).status, 200);
  assert.equal(JSON.stringify(s.store.reviewContext(s.a.user.id, s.job.id, s.file.id, run.id)), before);
  assert.equal(JSON.stringify(s.store.summaryRunResult(s.a.user.id, s.job.id, s.file.id, run.id)), result);
  const active = s.store.enqueueSummary(s.a.user.id, s.job.id, s.file.id, 2, "mapping-active-run").run;
  assert.equal(s.store.acquireSummaryLease("mapping-owner"), true);
  assert.equal(s.store.claimSummaryRun("mapping-owner")!.settingsCurrent, true);
  await s.save({...settings, revision: 2, monitoring: []});
  s.store.finishSummaryRun("mapping-owner", active.id, JSON.parse(result), null, s.store.summaryRunArtifacts(s.a.user.id, s.job.id, s.file.id, run.id)!);
  const ended = s.store.summaryRun(s.a.user.id, s.job.id, s.file.id, active.id)!.run;
  assert.equal(ended.status, "failed"); assert.match(ended.error!, /선택 버전이 변경/);
  s.store.releaseSummaryLease("mapping-owner");
});

test("v12 to v13 adds empty mappings without rewriting old columns and rolls back failed migrations", async (t) => {
  const s = await setup(t); await s.save(settings);
  const rows = () => JSON.stringify(s.db.prepare("SELECT * FROM column_selections").all().map(({monitoring_json, ...row}) => row));
  const before = rows(); dropMonitoringSchema(s.db); s.db.exec("PRAGMA user_version=12");
  const upgraded = createStore(s.f.filename); assert.deepEqual(upgraded.selection(s.a.user.id, s.job.id, s.file.id)!.monitoring, []); upgraded.close();
  assert.equal(rows(), before); assert.equal(s.db.prepare("PRAGMA user_version").get()!.user_version, 13);
  s.db.exec("PRAGMA user_version=12"); assert.throws(() => createStore(s.f.filename)); assert.equal(s.db.prepare("PRAGMA user_version").get()!.user_version, 12);
  dropMonitoringSchema(s.db); const retry = createStore(s.f.filename); retry.close();
  assert.equal(s.db.prepare("PRAGMA quick_check").get()!.quick_check, "ok"); assert.equal(s.db.prepare("PRAGMA foreign_key_check").all().length, 0);
});

test("event failure rolls mapping and revision back in the same transaction", async (t) => {
  const s = await setup(t); await s.save(settings); const head = s.store.activityHead(s.a.user.id);
  s.db.exec("CREATE TRIGGER synthetic_mapping_failure BEFORE INSERT ON activity_events WHEN NEW.type='selection.saved' BEGIN SELECT RAISE(ABORT,'synthetic'); END;");
  assert.equal((await s.save({...settings, revision: 1, monitoring: mappings})).status, 500);
  assert.equal(s.store.selection(s.a.user.id, s.job.id, s.file.id)!.revision, 1); assert.deepEqual(s.store.selection(s.a.user.id, s.job.id, s.file.id)!.monitoring, []);
  assert.deepEqual(s.store.activityHead(s.a.user.id), head);
});
