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
    assert.equal(t.db.prepare("PRAGMA user_version").get()!.user_version, 10);
  } finally {
    await t.cleanup();
  }
});

test("제목·요청 내용 포함 검색은 한글·ASCII 대소문자·공백·SQL 특수 문자를 문자 그대로 처리한다", async () => {
  const t = await setup();
  try {
    const one = await t.job(),
      two = await t.job(),
      three = await t.job(),
      other = await t.job(t.b);
    t.db
      .prepare("UPDATE jobs SET title=?,instructions=? WHERE id=?")
      .run("합성 Alpha 100%_검토", "연수 😀 대상", one.id);
    t.db
      .prepare("UPDATE jobs SET title=?,instructions=? WHERE id=?")
      .run("합성 두 번째", "ALPHA 요청 원문 ' OR 1=1 --", two.id);
    t.db
      .prepare("UPDATE jobs SET title=? WHERE id=?")
      .run("합성 Alpha 100xy검토", three.id);
    t.db
      .prepare("UPDATE jobs SET title=? WHERE id=?")
      .run("합성 Alpha 100%_검토", other.id);
    const search = (q: string) =>
      t.list(t.a, "/api/jobs?q=" + encodeURIComponent(q));
    assert.deepEqual(
      new Set((await search("  alpha  ")).jobs.map((j: any) => j.id)),
      new Set([one.id, two.id, three.id]),
    );
    for (const q of ["100%_", "😀", "연수"]) {
      assert.deepEqual(
        (await search(q)).jobs.map((j: any) => j.id),
        [one.id],
      );
    }
    assert.deepEqual(
      (await search("' OR 1=1 --")).jobs.map((j: any) => j.id),
      [two.id],
    );
    assert.equal((await search("없는문구")).page.total, 0);
    assert.deepEqual((await search(" alpha ")).filters, {
      q: "alpha",
      status: "all",
    });
    assert.equal((await t.list(t.b, "/api/jobs?q=alpha")).page.total, 1);
  } finally {
    await t.cleanup();
  }
});
test("서버 상태 필터는 전체 진행 중과 첨부별 최근 실행·검토 기록을 같은 기준으로 판별한다", async () => {
  const t = await setup();
  try {
    const empty = await t.job(),
      queued = await t.job(),
      running = await t.job(),
      pending = await t.job(),
      legacy = await t.job(),
      mixed = await t.job(),
      failed = await t.job();
    const qf = await t.file(queued.id),
      rf = await t.file(running.id),
      pf = await t.file(pending.id),
      lf = await t.file(legacy.id),
      mf1 = await t.file(mixed.id),
      mf2 = await t.file(mixed.id),
      ff = await t.file(failed.id);
    t.run(queued.id, qf.id, "completed", "approved");
    t.run(queued.id, qf.id, "queued");
    t.run(running.id, rf.id, "running");
    t.run(running.id, rf.id, "cancelled");
    t.run(pending.id, pf.id, "completed");
    t.run(legacy.id, lf.id, "completed", null, false);
    t.run(mixed.id, mf1.id, "completed", "approved");
    t.run(mixed.id, mf2.id, "completed", "rejected");
    t.run(failed.id, ff.id, "failed");
    const expected: Record<string, string[]> = {
      all: [
        empty.id,
        queued.id,
        running.id,
        pending.id,
        legacy.id,
        mixed.id,
        failed.id,
      ],
      none: [empty.id],
      queued: [queued.id],
      running: [running.id],
      completed: [pending.id, legacy.id, mixed.id],
      failed: [failed.id],
      cancelled: [running.id],
      review_pending: [pending.id],
      approved: [mixed.id],
      rejected: [mixed.id],
      summary_only: [legacy.id],
    };
    for (const [status, ids] of Object.entries(expected)) {
      const result = await t.list(t.a, "/api/jobs?status=" + status);
      assert.equal(result.page.total, ids.length, status);
      assert.deepEqual(
        new Set(result.jobs.map((j: any) => j.id)),
        new Set(ids),
        status,
      );
    }
    t.db
      .prepare("UPDATE jobs SET title='합성 복합 검색' WHERE id=?")
      .run(mixed.id);
    assert.equal(
      (
        await t.list(
          t.a,
          "/api/jobs?q=" + encodeURIComponent("복합") + "&status=approved",
        )
      ).page.total,
      1,
    );
    assert.equal(
      (
        await t.list(
          t.a,
          "/api/jobs?q=" +
            encodeURIComponent("복합") +
            "&status=review_pending",
        )
      ).page.total,
      0,
    );
    const next = t.run(mixed.id, mf1.id, "failed");
    assert.equal(
      (await t.list(t.a, "/api/jobs?status=approved")).page.total,
      0,
    );
    t.db
      .prepare(
        "UPDATE summary_runs SET created_at='2030-01-01T00:00:00.000Z' WHERE file_id=?",
      )
      .run(mf1.id);
    const latest = t.db
      .prepare(
        "SELECT id,status FROM summary_runs WHERE file_id=? ORDER BY created_at DESC,id DESC LIMIT 1",
      )
      .get(mf1.id)!;
    const activity = (await t.list()).jobs
      .find((j: any) => j.id === mixed.id)
      .activity.latest.find((r: any) => r.fileId === mf1.id);
    assert.equal(activity.runId, latest.id);
    assert.equal(activity.status, latest.status);
    const approved = await t.list(t.a, "/api/jobs?status=approved");
    assert.equal(approved.page.total, latest.id === next.id ? 0 : 1);
  } finally {
    await t.cleanup();
  }
});
test("검색·상태 조건을 페이지보다 먼저 적용하고 총건수·더 보기·빈 페이지·재시작을 유지한다", async () => {
  const t = await setup();
  try {
    const matches: string[] = [];
    for (let i = 0; i < 31; i++) {
      const job = await t.job();
      t.db
        .prepare("UPDATE jobs SET title=? WHERE id=?")
        .run(i < 23 ? `합성 검색대상 ${i}` : `합성 제외 ${i}`, job.id);
      if (i < 23) matches.push(job.id);
    }
    const base =
      "/api/jobs?q=" + encodeURIComponent("검색대상") + "&status=none&limit=7";
    const all: string[] = [];
    for (const offset of [0, 7, 14, 21]) {
      const result = await t.list(t.a, base + "&offset=" + offset);
      assert.equal(result.page.total, 23);
      assert.equal(result.page.hasMore, offset < 21);
      all.push(...result.jobs.map((j: any) => j.id));
    }
    assert.equal(new Set(all).size, 23);
    assert.deepEqual(new Set(all), new Set(matches));
    const beyond = await t.list(t.a, base + "&offset=50");
    assert.deepEqual(beyond.jobs, []);
    assert.equal(beyond.page.total, 23);
    assert.equal(beyond.page.hasMore, false);
    const before = await t.list(t.a, base);
    await t.f.restart();
    assert.deepEqual(await t.list(t.a, base), before);
    const empty = await t.list(
      t.a,
      base.replace("status=none", "status=approved"),
    );
    assert.equal(empty.page.total, 0);
    assert.deepEqual(empty.jobs, []);
  } finally {
    await t.cleanup();
  }
});
test("검색 쿼리·상태·중복/객체 매개변수·페이지 오류를 거부하고 기본 목록과 계정 범위를 보존한다", async () => {
  const t = await setup();
  try {
    await t.job();
    await t.job(t.b);
    const invalid = [
      "q=" + encodeURIComponent("x".repeat(101)),
      "q=%00",
      "q=%0A",
      "q=a&q=b",
      "q[x]=a",
      "q[]=a",
      "status=bad",
      "status=",
      "status=all&status=approved",
      "status[x]=all",
      "limit=1&limit=2",
      "limit[x]=2",
      "offset[x]=2",
      "extra=1",
      "offset=-1",
    ];
    for (const query of invalid)
      assert.equal(
        (await t.f.get("/api/jobs?" + query, t.a.cookie)).status,
        400,
        query,
      );
    assert.equal(
      (await t.f.get("/api/jobs?q=" + "x".repeat(100), t.a.cookie)).status,
      200,
    );
    const all = await t.list(),
      blank = await t.list(t.a, "/api/jobs?q=%20%20&status=all");
    assert.deepEqual(blank, all);
    assert.equal(
      (
        await t.f.get(
          "/api/jobs?q=" + encodeURIComponent("합성") + "&status=none",
        )
      ).status,
      401,
    );
    assert.equal(all.page.total, 1);
    assert.equal(all.jobs.length, 1);
    assert.equal(t.db.prepare("PRAGMA user_version").get()!.user_version, 10);
  } finally {
    await t.cleanup();
  }
});
