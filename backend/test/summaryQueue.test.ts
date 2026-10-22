import { dropActivitySchema } from "./migrationHelpers.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fixture } from "./fixture.ts";
import { createStore } from "../src/store.ts";
import { createSummaryQueue } from "../src/summaryQueue.ts";
const selection = {
  sheetId: "csv",
  headerRow: 1,
  columns: [0, 1],
  questions: [{ index: 0, min: 1, max: 5, required: true }],
};
const bytes = Buffer.from("A,B\n1,0.1\n5,0.2\n6,문자\n,\n");
async function setup() {
  const f = await fixture(),
    a = await f.account(),
    b = await f.account();
  const { job } = await (
    await f.post(
      {
        kind: "survey",
        title: "합성 큐 작업",
        instructions: "가상 자료만 집계",
      },
      a.cookie,
    )
  ).json();
  const { attachment } = await (
    await f.upload(job.id, "합성.csv", bytes, a.cookie)
  ).json();
  const base = `/api/jobs/${job.id}/attachments/${attachment.id}`;
  await f.put(base + "/selection", { ...selection, revision: 0 }, a.cookie);
  const enqueue = (
    key = "queue-request-key",
    revision = 1,
    cookie = a.cookie,
    headers: Record<string, string> = {},
  ) =>
    f.postJson(base + "/runs", { revision }, cookie, {
      "Idempotency-Key": key,
      ...headers,
    });
  return { f, a, b, job, attachment, base, enqueue };
}
async function terminal(
  f: Awaited<ReturnType<typeof fixture>>,
  base: string,
  id: string,
  cookie: string,
) {
  const until = Date.now() + 6000;
  while (Date.now() < until) {
    const r = await (await f.get(base + "/runs/" + id, cookie)).json();
    if (!["queued", "running"].includes(r.run.status)) return r;
    await wait(20);
  }
  throw Error("테스트 집계 완료 시간 초과");
}
test("큐 API 접수·응답 유실 재전송·충돌·취소·페이지와 계정/첨부 권한을 검사한다", async () => {
  const { f, a, b, base, enqueue } = await setup();
  try {
    assert.equal((await enqueue("bad")).status, 400);
    assert.equal((await enqueue("queue-anon", 1, "")).status, 401);
    assert.equal((await enqueue("queue-other", 1, b.cookie)).status, 404);
    assert.equal(
      (
        await enqueue("queue-origin", 1, a.cookie, {
          Origin: "https://external.invalid",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await enqueue("queue-account", 1, a.cookie, {
          "X-Office-Account": b.user.id,
        })
      ).status,
      401,
    );
    const first = await enqueue();
    assert.equal(first.status, 202);
    const { run } = await first.json();
    assert.equal(run.status, "queued");
    const replay = await enqueue();
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).run.id, run.id);
    assert.equal((await enqueue("queue-request-key", 2)).status, 409);
    assert.equal((await f.get(base + "/runs/" + run.id, b.cookie)).status, 404);
    assert.equal(
      (await f.get(base + "/runs/" + run.id + "/result", a.cookie)).status,
      409,
    );
    assert.equal(
      (await f.postJson(base + "/runs/" + run.id + "/cancel", {}, b.cookie))
        .status,
      404,
    );
    assert.equal(
      (await f.postJson(base + "/runs/" + run.id + "/cancel", {}, a.cookie))
        .status,
      200,
    );
    await f.postJson(base + "/runs/" + run.id + "/cancel", {}, a.cookie);
    const detail = await (
      await f.get(base + "/runs/" + run.id, a.cookie)
    ).json();
    assert.deepEqual(
      detail.events.map((e: { status: string }) => e.status),
      ["queued", "cancelled"],
    );
    for (let i = 0; i < 21; i++) {
      const { run: r } = await (await enqueue("queue-history-" + i)).json();
      await f.postJson(base + "/runs/" + r.id + "/cancel", {}, a.cookie);
    }
    const list = await f.get(base + "/runs", a.cookie);
    assert.equal(list.headers.get("cache-control"), "no-store");
    const page = await list.json();
    assert.equal(page.runs.length, 20);
    assert.equal(page.page.total, 22);
    assert.equal(page.page.hasMore, true);
    assert.equal(
      (await (await f.get(base + "/runs?offset=20&limit=20", a.cookie)).json())
        .runs.length,
      2,
    );
    assert.equal((await f.get(base + "/runs?limit=21", a.cookie)).status, 400);
  } finally {
    await f.cleanup();
  }
});
test("동시 접수도 하나만 저장하고 계정당 대기/실행 한도를 적용한다", async () => {
  const { f, a, enqueue } = await setup();
  try {
    const responses = await Promise.all([enqueue(), enqueue()]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 202]);
    for (let i = 0; i < 4; i++)
      assert.equal((await enqueue("queue-quota-" + i)).status, 202);
    assert.equal((await enqueue("queue-over-quota")).status, 429);
    assert.equal((await enqueue()).status, 200); // Replay still succeeds at capacity.
  } finally {
    await f.cleanup();
  }
});
test("실제 워커가 CSV 집계·설문·정확한 소수 결과를 저장하고 재시작/설정 변경 후 이력을 복원한다", async () => {
  const { f, a, job, attachment, base, enqueue } = await setup();
  let runner: ReturnType<typeof createSummaryQueue> | null = null,
    store: ReturnType<typeof createStore> | null = null;
  try {
    const { run } = await (await enqueue()).json();
    await f.restart();
    store = createStore(f.filename);
    runner = createSummaryQueue(store, { pollMs: 10 });
    runner.start();
    const detail = await terminal(f, base, run.id, a.cookie);
    assert.equal(detail.run.status, "completed");
    assert.deepEqual(
      detail.events.map((e: { status: string }) => e.status),
      ["queued", "running", "completed"],
    );
    const response = await f.get(
      base + "/runs/" + run.id + "/result",
      a.cookie,
    );
    assert.equal(response.status, 200);
    const { summary } = await response.json();
    assert.deepEqual(
      [summary.totalRows, summary.includedRows, summary.excludedRows],
      [4, 3, 1],
    );
    assert.equal(summary.columns[1].numeric.sum, "0.3");
    assert.equal(summary.survey.validRows, 2);
    assert.equal(summary.revision, 1);
    assert.equal(summary.sourceHash, attachment.sha256);
    await f.put(base + "/selection", { ...selection, revision: 1 }, a.cookie);
    assert.equal(
      (await f.get(base + "/runs/" + run.id + "/result", a.cookie)).status,
      200,
    );
    assert.equal((await enqueue()).status, 200); // Restores the original accepted request after revision changes.
    await runner.stop();
    store.close();
    runner = null;
    store = null;
    await f.restart();
    assert.equal(
      (await (await f.get(base + "/runs/" + run.id, a.cookie)).json()).run
        .status,
      "completed",
    );
    const cancelled = await f.postJson(
      base + "/runs/" + run.id + "/cancel",
      {},
      a.cookie,
    );
    assert.equal((await cancelled.json()).run.status, "completed");
    assert.deepEqual(
      readFileSync(
        join(dirname(f.filename), "attachments", job.id, attachment.id),
      ),
      bytes,
    );
  } finally {
    if (runner) await runner.stop();
    store?.close();
    await f.cleanup();
  }
});
test("대기 중 설정 변경·원본 변조는 실패로 남고 결과를 저장하지 않는다", async () => {
  const { f, a, job, attachment, base, enqueue } = await setup();
  const store = createStore(f.filename);
  let queue: ReturnType<typeof createSummaryQueue> | null = null;
  try {
    const first = (await (await enqueue()).json()).run;
    await f.put(base + "/selection", { ...selection, revision: 1 }, a.cookie);
    queue = createSummaryQueue(store, { pollMs: 10 });
    queue.start();
    assert.equal(
      (await terminal(f, base, first.id, a.cookie)).run.status,
      "failed",
    );
    await queue.stop();
    const second = (await (await enqueue("queue-tamper", 2)).json()).run;
    writeFileSync(
      join(dirname(f.filename), "attachments", job.id, attachment.id),
      "tampered",
    );
    queue = createSummaryQueue(store, { pollMs: 10 });
    queue.start();
    assert.equal(
      (await terminal(f, base, second.id, a.cookie)).run.status,
      "failed",
    );
    assert.equal(
      (await f.get(base + "/runs/" + second.id + "/result", a.cookie)).status,
      409,
    );
  } finally {
    if (queue) await queue.stop();
    store.close();
    await f.cleanup();
  }
});
test("실행 중 취소·시간 제한·정상 서버 종료에서 워커를 중단하고 결과를 폐기한다", async () => {
  const { f, a, base, enqueue } = await setup();
  const store = createStore(f.filename);
  let queue: ReturnType<typeof createSummaryQueue> | null = null;
  const workerUrl = new URL("./queueIdleWorker.ts", import.meta.url);
  try {
    let run = (await (await enqueue()).json()).run;
    queue = createSummaryQueue(store, { pollMs: 10, workerUrl });
    queue.start();
    assert.equal(store.summaryRunStatus(run.id), "running");
    await f.postJson(base + "/runs/" + run.id + "/cancel", {}, a.cookie);
    await queue.stop();
    assert.equal(store.summaryRunStatus(run.id), "cancelled");
    assert.equal(
      (await f.get(base + "/runs/" + run.id + "/result", a.cookie)).status,
      409,
    );
    run = (await (await enqueue("queue-timeout")).json()).run;
    queue = createSummaryQueue(store, {
      pollMs: 10,
      timeoutMs: 100,
      workerUrl,
    });
    queue.start();
    assert.equal(
      (await terminal(f, base, run.id, a.cookie)).run.status,
      "failed",
    );
    await queue.stop();
    run = (await (await enqueue("queue-shutdown")).json()).run;
    queue = createSummaryQueue(store, { pollMs: 10, workerUrl });
    queue.start();
    assert.equal(store.summaryRunStatus(run.id), "running");
    await queue.stop();
    assert.equal(store.summaryRunStatus(run.id), "failed");
  } finally {
    if (queue) await queue.stop();
    store.close();
    await f.cleanup();
  }
});
test("실행 중 설정 충돌·취소·lease 만료는 이전 워커의 완료 저장을 차단한다", async () => {
  const { f, a, base, enqueue } = await setup();
  const store = createStore(f.filename);
  try {
    let run = (await (await enqueue()).json()).run;
    assert.equal(store.acquireSummaryLease("owner-one"), true);
    assert.equal(store.acquireSummaryLease("owner-two"), false);
    assert.equal(store.claimSummaryRun("owner-two"), null);
    store.claimSummaryRun("owner-one");
    await f.put(base + "/selection", { ...selection, revision: 1 }, a.cookie);
    assert.equal(
      store.finishSummaryRun("owner-one", run.id, { summary: "stale" }),
      true,
    );
    assert.equal(store.summaryRunStatus(run.id), "failed");
    run = (await (await enqueue("queue-cancel-fence", 2)).json()).run;
    store.claimSummaryRun("owner-one");
    await f.postJson(base + "/runs/" + run.id + "/cancel", {}, a.cookie);
    assert.equal(
      store.finishSummaryRun("owner-one", run.id, { summary: "discard" }),
      false,
    );
    assert.equal(store.summaryRunStatus(run.id), "cancelled");
    run = (await (await enqueue("queue-lease-fence", 2)).json()).run;
    store.claimSummaryRun("owner-one");
    const db = new DatabaseSync(f.filename);
    db.prepare("UPDATE summary_queue_lease SET expires_at=0").run();
    db.close();
    assert.equal(store.acquireSummaryLease("owner-two"), true);
    assert.equal(store.summaryRunStatus(run.id), "failed");
    assert.equal(
      store.finishSummaryRun("owner-one", run.id, { summary: "old-owner" }),
      false,
    );
    store.releaseSummaryLease("owner-two");
  } finally {
    store.close();
    await f.cleanup();
  }
});
test("v5 데이터·설정·원본을 보존하며 v6 실행 테이블을 추가한다", async () => {
  let account = "",
    jobId = "",
    fileId = "";
  const f = await fixture({
    seed(filename) {
      const s = createStore(filename);
      const user = s.register(
        "queue_migration",
        "synthetic-unused-hash",
        "synthetic-unused-recovery",
      )!;
      account = user.id;
      s.addAuthSession("synthetic-session", account, Date.now() + 60000);
      const { job } = s.create(
        "synthetic-session",
        "migration-key",
        { kind: "survey", title: "합성 큐 이전", instructions: "보존 검사" },
        account,
      );
      jobId = job.id;
      fileId = s.saveAttachment(
        account,
        jobId,
        "migration-file",
        "합성.csv",
        "csv",
        bytes,
      ).attachment.id;
      s.saveSelection(account, jobId, fileId, 0, selection);
      s.close();
      const db = new DatabaseSync(filename);
      dropActivitySchema(db);
      db.exec(
        "DROP TABLE summary_run_reviews; DROP TABLE summary_run_artifacts; DROP TABLE summary_run_events; DROP TABLE summary_runs; DROP TABLE summary_queue_lease; PRAGMA user_version=5;",
      );
      db.close();
    },
  });
  try {
    const s = createStore(f.filename);
    try {
      assert.equal(s.selection(account, jobId, fileId)!.revision, 1);
      assert.deepEqual(
        s.selection(account, jobId, fileId)!.questions,
        selection.questions,
      );
      assert.equal(s.detail(account, jobId)!.events.length, 1);
      assert.equal(
        s.listSummaryRuns(account, jobId, fileId, 20, 0).page.total,
        0,
      );
    } finally {
      s.close();
    }
    const db = new DatabaseSync(f.filename, { readOnly: true });
    try {
      assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 10);
      assert.equal(db.prepare("PRAGMA quick_check").get()!.quick_check, "ok");
      assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
    } finally {
      db.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("전체 대기/실행 20개 한도는 계정이 달라도 적용한다", async () => {
  const f = await fixture();
  try {
    for (let accountIndex = 0; accountIndex < 5; accountIndex++) {
      const a = await f.account();
      const { job } = await (
        await f.post(
          {
            kind: "survey",
            title: "합성 전체 한도",
            instructions: "동시 작업 한도 확인",
          },
          a.cookie,
        )
      ).json();
      const { attachment } = await (
        await f.upload(job.id, "합성.csv", bytes, a.cookie)
      ).json();
      const base = `/api/jobs/${job.id}/attachments/${attachment.id}`;
      await f.put(base + "/selection", { ...selection, revision: 0 }, a.cookie);
      for (let i = 0; i < (accountIndex < 4 ? 5 : 1); i++) {
        const r = await f.postJson(base + "/runs", { revision: 1 }, a.cookie, {
          "Idempotency-Key": "global-quota-" + i,
        });
        assert.equal(r.status, accountIndex < 4 ? 202 : 429);
      }
    }
  } finally {
    await f.cleanup();
  }
});
test("실제 XLSX 워커는 수식/오류를 제외하며 워커 비정상 종료·결과 한도를 실패로 기록한다", async () => {
  const { xlsxFixture } = await import("./xlsxFixture.ts");
  const { f, a, job, base, enqueue } = await setup();
  const store = createStore(f.filename);
  let queue: ReturnType<typeof createSummaryQueue> | null = null;
  try {
    const { attachment } = await (
      await f.upload(
        job.id,
        "합성.xlsx",
        await xlsxFixture(),
        a.cookie,
        "queue-xlsx-file",
      )
    ).json();
    const xb = `/api/jobs/${job.id}/attachments/${attachment.id}`;
    await f.put(
      xb + "/selection",
      { sheetId: "0", headerRow: 1, columns: [0, 1, 2], revision: 0 },
      a.cookie,
    );
    const { run } = await (
      await f.postJson(xb + "/runs", { revision: 1 }, a.cookie, {
        "Idempotency-Key": "queue-xlsx-request",
      })
    ).json();
    queue = createSummaryQueue(store, { pollMs: 10 });
    queue.start();
    assert.equal(
      (await terminal(f, xb, run.id, a.cookie)).run.status,
      "completed",
    );
    const { summary } = await (
      await f.get(xb + "/runs/" + run.id + "/result", a.cookie)
    ).json();
    assert.equal(summary.columns[1].formulaCount, 1);
    assert.equal(summary.columns[2].errorCount, 1);
    await queue.stop();
    const fail = (await (await enqueue("queue-worker-crash")).json()).run;
    queue = createSummaryQueue(store, {
      pollMs: 10,
      workerUrl: new URL("./missing-worker.ts", import.meta.url),
    });
    queue.start();
    assert.equal(
      (await terminal(f, base, fail.id, a.cookie)).run.status,
      "failed",
    );
    await queue.stop();
    const oversized = (await (await enqueue("queue-result-size")).json()).run;
    assert.equal(store.acquireSummaryLease("size-test-owner"), true);
    store.claimSummaryRun("size-test-owner");
    store.finishSummaryRun("size-test-owner", oversized.id, {
      value: "x".repeat(5 * 1024 * 1024 + 1),
    });
    assert.equal(store.summaryRunStatus(oversized.id), "failed");
    assert.equal(
      (await f.get(base + "/runs/" + oversized.id + "/result", a.cookie))
        .status,
      409,
    );
    store.releaseSummaryLease("size-test-owner");
  } finally {
    if (queue) await queue.stop();
    store.close();
    await f.cleanup();
  }
});

test("접수 후 로그아웃해도 처리하고 재로그인한 소유자만 결과를 복원한다", async () => {
  const { cookie } = await import("./fixture.ts");
  const { f, a, b, base, enqueue } = await setup();
  const store = createStore(f.filename);
  const queue = createSummaryQueue(store, { pollMs: 10 });
  try {
    const { run } = await (await enqueue("queue-after-logout")).json();
    await f.auth("logout", {}, a.cookie);
    queue.start();
    const login = await f.auth("login", {
      username: a.username,
      password: a.password,
    });
    assert.equal(login.status, 200);
    const fresh = cookie(login);
    assert.equal(
      (await f.get(base + "/runs/" + run.id + "/result", a.cookie)).status,
      401,
    );
    assert.equal(
      (await terminal(f, base, run.id, fresh)).run.status,
      "completed",
    );
    assert.equal(
      (await f.get(base + "/runs/" + run.id + "/result", fresh)).status,
      200,
    );
    assert.equal(
      (await f.get(base + "/runs/" + run.id + "/result", b.cookie)).status,
      404,
    );
  } finally {
    await queue.stop();
    store.close();
    await f.cleanup();
  }
});
