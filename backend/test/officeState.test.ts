import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { fixture } from "./fixture.ts";
import { createStore } from "../src/store.ts";
async function setup() {
  const f = await fixture(),
    a = await f.account(),
    b = await f.account(),
    s = createStore(f.filename),
    db = new DatabaseSync(f.filename);
  let sequence = 0;
  async function job(account = a) {
    return (
      await (
        await f.post(
          {
            kind: "notice",
            title: "합성 서버 오피스",
            instructions: "노출하지 않을 합성 지시",
          },
          account.cookie,
          randomUUID(),
        )
      ).json()
    ).job;
  }
  async function run(
    jobId: string,
    status: string,
    review: string | null = null,
    fileId?: string,
    account = a,
    artifacts = true,
  ) {
    if (!fileId) {
      fileId = (
        await (
          await f.upload(
            jobId,
            "합성.csv",
            Buffer.from("A\n1\n"),
            account.cookie,
            randomUUID(),
          )
        ).json()
      ).attachment.id;
      s.saveSelection(account.user.id, jobId, fileId!, 0, {
        sheetId: "csv",
        headerRow: 1,
        columns: [0],
      });
    }
    const { run } = s.enqueueSummary(
      account.user.id,
      jobId,
      fileId!,
      1,
      randomUUID(),
    );
    db.prepare("UPDATE summary_runs SET status=?,created_at=? WHERE id=?").run(
      status,
      new Date(1800000000000 + ++sequence * 1000).toISOString(),
      run.id,
    );
    if (status === "completed" && artifacts)
      for (const format of ["csv", "html", "xlsx"])
        db.prepare("INSERT INTO summary_run_artifacts VALUES(?,?,?,?,?)").run(
          run.id,
          format,
          1,
          "a".repeat(64),
          new Date().toISOString(),
        );
    if (review)
      db.prepare(
        "INSERT INTO summary_run_reviews VALUES(?,?,?,?,?,?,?,?,?)",
      ).run(
        randomUUID(),
        run.id,
        account.user.id,
        randomUUID(),
        "a".repeat(64),
        "{}",
        review,
        "노출하지 않을 합성 의견",
        new Date().toISOString(),
      );
    return { ...run, fileId: fileId! };
  }
  return {
    f,
    a,
    b,
    s,
    db,
    job,
    run,
    view: async (account = a) =>
      await (await f.get("/api/jobs/office", account.cookie)).json(),
    close: async () => {
      s.close();
      db.close();
      await f.cleanup();
    },
  };
}
test("오피스는 계정 전체의 진행 중 실행과 첨부별 최근 검토 기록을 구분한다", async (t) => {
  const f = await setup();
  t.after(f.close);
  const job = await f.job();
  const old = await f.run(job.id, "running");
  await f.run(job.id, "cancelled", null, old.fileId);
  await f.run(job.id, "queued");
  await f.run(job.id, "completed");
  await f.run(job.id, "completed", "approved");
  await f.run(job.id, "completed", "rejected");
  const extra = await f.job();
  await f.run(extra.id, "failed");
  await f.run(extra.id, "completed", null, undefined, f.a, false);
  const other = await f.job(f.b);
  await f.run(other.id, "running", null, undefined, f.b);
  for (let i = 0; i < 24; i++) await f.job();
  const view = await f.view();
  assert.equal(view.executionMode, "quantitative_summary");
  assert.equal(view.aiConnected, false);
  assert.deepEqual(view.totals, {
    jobs: 26,
    queued: 1,
    running: 1,
    latestRuns: 7,
    completed: 4,
    failed: 1,
    cancelled: 1,
    reviewPending: 1,
    approved: 1,
    rejected: 1,
    summaryOnly: 1,
  });
  assert.equal(view.focus.runId, old.id);
  assert.equal(view.focus.status, "running");
  assert.equal(view.recent.length, 5);
  assert.ok(!JSON.stringify(view).includes("노출하지 않을"));
  const page = await (
    await f.f.get("/api/jobs?status=none&q=찾을수없는합성", f.a.cookie)
  ).json();
  assert.equal(page.page.total, 0);
  assert.deepEqual(await f.view(), view);
  assert.equal((await f.view(f.b)).totals.running, 1);
  assert.equal((await f.view(f.b)).totals.jobs, 1);
});
test("대표 실행은 실행 중·대기·검토 대기·최근 종료 순이고 오래된 승인 뒤 새 실행을 표시한다", async (t) => {
  const f = await setup();
  t.after(f.close);
  const job = await f.job();
  const approved = await f.run(job.id, "completed", "approved");
  const newer = await f.run(job.id, "queued", null, approved.fileId);
  assert.equal((await f.view()).focus.runId, newer.id);
  assert.equal((await f.view()).totals.approved, 0);
  const running = await f.run(job.id, "running");
  assert.equal((await f.view()).focus.runId, running.id);
  f.db
    .prepare("UPDATE summary_runs SET status='failed' WHERE id IN (?,?)")
    .run(newer.id, running.id);
  const pending = await f.run(job.id, "completed");
  await f.run(job.id, "cancelled");
  assert.equal((await f.view()).focus.runId, pending.id);
  f.db
    .prepare("INSERT INTO summary_run_reviews VALUES(?,?,?,?,?,?,?,?,?)")
    .run(
      randomUUID(),
      pending.id,
      f.a.user.id,
      randomUUID(),
      "a".repeat(64),
      "{}",
      "approved",
      "",
      new Date().toISOString(),
    );
  assert.equal((await f.view()).focus.status, "cancelled");
});
test("오피스 조회는 파일/결과 본문을 읽거나 DB를 쓰지 않고 재시작 후 같은 현황을 반환한다", async (t) => {
  const f = await setup();
  t.after(f.close);
  const job = await f.job();
  const run = await f.run(job.id, "completed", "approved");
  const before = await f.view(),
    cursor = f.s.activityHead(f.a.user.id);
  rmSync(f.s.attachmentPath(job.id, run.fileId));
  f.db
    .prepare("UPDATE summary_runs SET result_json='not-json' WHERE id=?")
    .run(run.id);
  assert.deepEqual(await f.view(), before);
  assert.deepEqual(f.s.activityHead(f.a.user.id), cursor);
  await f.f.restart();
  assert.deepEqual(await f.view(), before);
  assert.equal(f.db.prepare("PRAGMA user_version").get()!.user_version, 9);
  assert.equal(f.db.prepare("PRAGMA foreign_key_check").all().length, 0);
});
test("오피스 API의 로그인·계정 변경·쿼리 검증과 빈 현황을 확인한다", async (t) => {
  const f = await setup();
  t.after(f.close);
  assert.equal((await f.f.get("/api/jobs/office")).status, 401);
  const mismatch = await fetch(f.f.url() + "/api/jobs/office", {
    headers: { cookie: f.a.cookie, "X-Office-Account": f.b.user.id },
  });
  assert.equal(mismatch.status, 401);
  for (const query of ["?q=x", "?status=running", "?account=x", "?limit=20"])
    assert.equal(
      (await f.f.get("/api/jobs/office" + query, f.a.cookie)).status,
      400,
    );
  const response = await f.f.get("/api/jobs/office", f.a.cookie);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const view = await response.json();
  assert.equal(view.focus, null);
  assert.deepEqual(view.recent, []);
  assert.ok(Object.values(view.totals).every((value) => value === 0));
});
