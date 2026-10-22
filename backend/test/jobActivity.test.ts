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
    store = createStore(f.filename),
    db = new DatabaseSync(f.filename);
  let time = 0;
  async function job(account = a) {
    return (
      await (
        await f.post(
          {
            kind: "survey",
            title: "합성 현황 업무",
            instructions: "가상 실행 상태",
          },
          account.cookie,
          randomUUID(),
        )
      ).json()
    ).job;
  }
  async function file(jobId: string, account = a) {
    const { attachment } = await (
      await f.upload(
        jobId,
        "합성.csv",
        Buffer.from("A\n1\n"),
        account.cookie,
        randomUUID(),
      )
    ).json();
    await f.put(
      `/api/jobs/${jobId}/attachments/${attachment.id}/selection`,
      { sheetId: "csv", headerRow: 1, columns: [0], revision: 0 },
      account.cookie,
    );
    return attachment;
  }
  function run(
    jobId: string,
    fileId: string,
    status: string,
    decision: string | null = null,
    formats = true,
    account = a,
  ) {
    const { run } = store.enqueueSummary(
      account.user.id,
      jobId,
      fileId,
      1,
      randomUUID(),
    );
    db.prepare(
      "UPDATE summary_runs SET status=?,result_json='{}',created_at=? WHERE id=?",
    ).run(
      status,
      new Date(1800000000000 + ++time * 1000).toISOString(),
      run.id,
    );
    if (status === "completed" && formats)
      for (const format of ["csv", "html", "xlsx"])
        db.prepare("INSERT INTO summary_run_artifacts VALUES (?,?,?,?,?)").run(
          run.id,
          format,
          5,
          "a".repeat(64),
          new Date().toISOString(),
        );
    if (decision)
      db.prepare(
        "INSERT INTO summary_run_reviews VALUES (?,?,?,?,?,?,?,?,?)",
      ).run(
        randomUUID(),
        run.id,
        account.user.id,
        randomUUID(),
        "a".repeat(64),
        "{}",
        decision,
        "합성 검토",
        new Date().toISOString(),
      );
    return run;
  }
  return {
    f,
    a,
    b,
    store,
    db,
    job,
    file,
    run,
    async list(account = a, path = "/api/jobs") {
      return await (await f.get(path, account.cookie)).json();
    },
    async cleanup() {
      db.close();
      store.close();
      await f.cleanup();
    },
  };
}
test("업무 목록·상세는 첨부별 최근 실행과 전체 진행 중 건수를 구분하며 모든 검토 기록을 표시한다", async () => {
  const t = await setup();
  try {
    const job = await t.job(),
      files = await Promise.all(
        Array.from({ length: 5 }, () => t.file(job.id)),
      );
    const old = t.run(job.id, files[0].id, "running");
    const cancelled = t.run(job.id, files[0].id, "cancelled");
    const approved = t.run(job.id, files[1].id, "completed", "approved");
    const rejected = t.run(job.id, files[2].id, "completed", "rejected");
    const pending = t.run(job.id, files[3].id, "completed");
    const legacy = t.run(job.id, files[4].id, "completed", null, false);
    const list = await t.list(),
      activity = list.jobs[0].activity;
    assert.deepEqual(activity.active, { queued: 0, running: 1 });
    assert.equal(activity.latest.length, 5);
    assert.deepEqual(
      activity.latest.map((r: any) => r.runId),
      [legacy.id, pending.id, rejected.id, approved.id, cancelled.id],
    );
    assert.ok(!activity.latest.some((r: any) => r.runId === old.id));
    assert.deepEqual(
      activity.latest.map((r: any) => r.review),
      ["summary_only", "pending", "rejected", "approved", null],
    );
    const detail = await t.list(t.a, "/api/jobs/" + job.id);
    assert.deepEqual(detail.job.activity, activity);
    assert.equal(detail.job.status, "received");
    assert.equal(detail.job.executionMode, "not_connected");
    for (const row of activity.latest) {
      assert.equal(row.filename, "합성.csv");
      assert.equal("comment" in row, false);
      assert.equal("result_json" in row, false);
      assert.equal("source_hash" in row, false);
    }
  } finally {
    await t.cleanup();
  }
});
test("과거 승인 뒤 새 집계를 접수하면 최신 대기·실패·검토 대기를 표시하며 동률은 ID로 정렬한다", async () => {
  const t = await setup();
  try {
    const job = await t.job(),
      file = await t.file(job.id);
    t.run(job.id, file.id, "completed", "approved");
    const queued = t.run(job.id, file.id, "queued");
    let activity = (await t.list()).jobs[0].activity;
    assert.deepEqual(activity.active, { queued: 1, running: 0 });
    assert.equal(activity.latest[0].runId, queued.id);
    assert.equal(activity.latest[0].review, null);
    t.db
      .prepare("UPDATE summary_runs SET status='failed' WHERE id=?")
      .run(queued.id);
    activity = (await t.list()).jobs[0].activity;
    assert.equal(activity.latest[0].status, "failed");
    assert.deepEqual(activity.active, { queued: 0, running: 0 });
    const next = t.run(job.id, file.id, "completed");
    activity = (await t.list()).jobs[0].activity;
    assert.equal(activity.latest[0].review, "pending");
    t.db
      .prepare(
        "UPDATE summary_runs SET created_at='2030-01-01T00:00:00.000Z' WHERE job_id=?",
      )
      .run(job.id);
    const expected = t.db
      .prepare(
        "SELECT id FROM summary_runs WHERE job_id=? ORDER BY created_at DESC,id DESC LIMIT 1",
      )
      .get(job.id)!.id;
    assert.equal((await t.list()).jobs[0].activity.latest[0].runId, expected);
  } finally {
    await t.cleanup();
  }
});
test("현황 정보는 계정·페이지·업무 범위를 벗어나지 않으며 실행 없는 업무는 빈 현황이다", async () => {
  const t = await setup();
  try {
    const empty = await t.job(),
      withRuns = await t.job(),
      other = await t.job(t.b),
      file = await t.file(withRuns.id),
      otherFile = await t.file(other.id, t.b);
    t.run(withRuns.id, file.id, "running");
    t.run(other.id, otherFile.id, "queued", null, true, t.b);
    const own = await t.list();
    assert.equal(own.jobs.length, 2);
    assert.ok(own.jobs.every((j: any) => j.id !== other.id));
    assert.deepEqual(own.jobs.find((j: any) => j.id === empty.id).activity, {
      active: { queued: 0, running: 0 },
      latest: [],
    });
    const page1 = await t.list(t.a, "/api/jobs?limit=1"),
      page2 = await t.list(t.a, "/api/jobs?limit=1&offset=1");
    assert.equal(page1.jobs.length, 1);
    assert.equal(page2.jobs.length, 1);
    assert.notEqual(page1.jobs[0].id, page2.jobs[0].id);
    assert.equal(page1.page.total, 2);
    const theirs = await t.list(t.b);
    assert.equal(theirs.jobs.length, 1);
    assert.deepEqual(theirs.jobs[0].activity.active, { queued: 1, running: 0 });
    assert.equal(
      (await t.f.get("/api/jobs/" + withRuns.id, t.b.cookie)).status,
      404,
    );
    assert.equal((await t.f.get("/api/jobs")).status, 401);
  } finally {
    await t.cleanup();
  }
});
test("현황 조회는 파일을 읽지 않고 재시작 후 동일한 기록을 보존하며 신규 결정을 반영한다", async () => {
  const t = await setup();
  try {
    const job = await t.job(),
      file = await t.file(job.id),
      run = t.run(job.id, file.id, "completed");
    rmSync(t.store.attachmentPath(job.id, file.id));
    let activity = (await t.list()).jobs[0].activity;
    assert.equal(activity.latest[0].review, "pending");
    t.db
      .prepare("INSERT INTO summary_run_reviews VALUES (?,?,?,?,?,?,?,?,?)")
      .run(
        randomUUID(),
        run.id,
        t.a.user.id,
        randomUUID(),
        "b".repeat(64),
        "{}",
        "approved",
        "합성 의견",
        new Date().toISOString(),
      );
    activity = (await t.list()).jobs[0].activity;
    assert.equal(activity.latest[0].review, "approved");
    await t.f.restart();
    assert.deepEqual((await t.list()).jobs[0].activity, activity);
    assert.equal(t.db.prepare("PRAGMA user_version").get()!.user_version, 8);
  } finally {
    await t.cleanup();
  }
});
