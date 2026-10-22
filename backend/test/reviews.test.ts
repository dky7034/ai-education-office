import { dropActivitySchema } from "./migrationHelpers.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { fixture } from "./fixture.ts";
import { createStore } from "../src/store.ts";
import { createSummaryQueue } from "../src/summaryQueue.ts";
import { outputFile } from "../src/runArtifacts.ts";
const selection = { sheetId: "csv", headerRow: 1, columns: [0], questions: [] };
async function setup() {
  const f = await fixture(),
    a = await f.account(),
    b = await f.account();
  const { job } = await (
    await f.post(
      {
        kind: "survey",
        title: "합성 검토",
        instructions: "가상 정량 결과 검토",
      },
      a.cookie,
    )
  ).json();
  const { attachment } = await (
    await f.upload(job.id, "합성.csv", Buffer.from("A\n1\n3\n"), a.cookie)
  ).json();
  const base = `/api/jobs/${job.id}/attachments/${attachment.id}`;
  await f.put(base + "/selection", { ...selection, revision: 0 }, a.cookie);
  const store = createStore(f.filename),
    queue = createSummaryQueue(store, { pollMs: 10 });
  async function enqueue(revision = 1) {
    return (
      await (
        await f.postJson(base + "/runs", { revision }, a.cookie, {
          "Idempotency-Key": randomUUID(),
        })
      ).json()
    ).run;
  }
  async function completed(revision = 1) {
    const run = await enqueue(revision);
    queue.start();
    for (let i = 0; i < 300; i++) {
      const r = await (await f.get(base + "/runs/" + run.id, a.cookie)).json();
      if (r.run.status === "completed") return run;
      if (r.run.status === "failed") throw Error(r.run.error);
      await wait(20);
    }
    throw Error("집계 대기 시간 초과");
  }
  const url = (id: string) => base + "/runs/" + id + "/review";
  const state = async (id: string) =>
    await (await f.get(url(id), a.cookie)).json();
  const decide = (
    id: string,
    body: unknown,
    key = randomUUID(),
    cookie = a.cookie,
    headers = {},
  ) =>
    f.postJson(url(id), body, cookie, { "Idempotency-Key": key, ...headers });
  return {
    f,
    a,
    b,
    job,
    attachment,
    base,
    store,
    queue,
    enqueue,
    completed,
    url,
    state,
    decide,
    async cleanup() {
      await queue.stop();
      store.close();
      await f.cleanup();
    },
  };
}
test("완료 파일 3종·요약·실행에 승인을 연결하고 설정 변경·재시작 후에도 당시 결정을 복원한다", async () => {
  const t = await setup();
  try {
    const run = await t.completed(),
      before = await t.state(run.id);
    assert.equal(before.reviewable, true);
    assert.equal(before.decision, null);
    const body = {
      targetHash: before.targetHash,
      decision: "approved",
      comment: "합성 값과 파일 3종 확인",
    };
    const response = await t.decide(run.id, body);
    assert.equal(response.status, 201);
    const receipt = await response.json();
    assert.equal(receipt.decision.reviewerId, t.a.user.id);
    assert.equal(receipt.decision.requestKey, undefined);
    const reviewed = await t.state(run.id);
    assert.equal(reviewed.decision.valid, true);
    assert.equal(reviewed.decision.targetHash, before.targetHash);
    await t.queue.stop();
    assert.equal(
      (
        await t.f.put(
          t.base + "/selection",
          { ...selection, headerRow: 2, revision: 1 },
          t.a.cookie,
        )
      ).status,
      200,
    );
    await t.f.restart();
    assert.deepEqual((await t.state(run.id)).decision, reviewed.decision);
    const detail = await (
      await t.f.get("/api/jobs/" + t.job.id, t.a.cookie)
    ).json();
    assert.equal(detail.job.status, "received");
    assert.equal(detail.job.executionMode, "not_connected");
    const db = new DatabaseSync(t.f.filename);
    const row = db
      .prepare("SELECT manifest_json FROM summary_run_reviews WHERE run_id=?")
      .get(run.id)!;
    const manifest = JSON.parse(String(row.manifest_json));
    assert.equal(manifest.runId, run.id);
    assert.equal(manifest.artifacts.length, 3);
    assert.match(manifest.summaryHash, /^[a-f0-9]{64}$/);
    db.close();
  } finally {
    await t.cleanup();
  }
});
test("반려는 사유가 필수이고 본문·길이·결정·해시·식별자를 검증한다", async () => {
  const t = await setup();
  try {
    const run = await t.completed(),
      s = await t.state(run.id),
      body = {
        targetHash: s.targetHash,
        decision: "rejected",
        comment: "<script>합성</script> 다시 확인",
      };
    for (const bad of [
      null,
      [],
      {},
      { ...body, comment: "" },
      { ...body, comment: " " },
      { ...body, comment: "x".repeat(2001) },
      { ...body, decision: "pending" },
      { ...body, targetHash: "bad" },
      { ...body, confirmed: true },
      { ...body, comment: 4 },
    ])
      assert.equal((await t.decide(run.id, bad)).status, 400);
    assert.equal((await t.decide(run.id, body, "short")).status, 400);
    assert.equal((await t.decide(run.id, body)).status, 201);
    const reviewed = await t.state(run.id);
    assert.equal(reviewed.decision.decision, "rejected");
    assert.equal(reviewed.decision.comment, body.comment);
    assert.equal(reviewed.decision.valid, true);
    assert.equal(
      (await t.decide(run.id, { ...body, decision: "approved" })).status,
      409,
    );
  } finally {
    await t.cleanup();
  }
});
test("동시 동일 요청·응답 유실 재전송은 한 결정이며 다른 결정·요청 키 재사용은 충돌한다", async () => {
  const t = await setup();
  try {
    const run = await t.completed(),
      s = await t.state(run.id),
      key = randomUUID(),
      body = {
        targetHash: s.targetHash,
        decision: "approved",
        comment: "확인",
      };
    const responses = await Promise.all([
      t.decide(run.id, body, key),
      t.decide(run.id, body, key),
    ]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 201]);
    const receipts = await Promise.all(responses.map((r) => r.json()));
    assert.equal(receipts[0].decision.id, receipts[1].decision.id);
    assert.equal(
      (await t.decide(run.id, { ...body, comment: "변경" }, key)).status,
      409,
    );
    assert.equal((await t.decide(run.id, body)).status, 409);
    const next = await t.completed(),
      nextState = await t.state(next.id);
    assert.equal(nextState.decision, null);
    assert.notEqual(s.targetHash, nextState.targetHash);
    assert.equal(
      (
        await t.decide(
          next.id,
          { ...body, targetHash: nextState.targetHash },
          key,
        )
      ).status,
      409,
    );
    const race = await Promise.all([
      t.decide(next.id, { ...body, targetHash: nextState.targetHash }),
      t.decide(next.id, {
        ...body,
        targetHash: nextState.targetHash,
        decision: "rejected",
      }),
    ]);
    assert.deepEqual(race.map((r) => r.status).sort(), [201, 409]);
    const db = new DatabaseSync(t.f.filename);
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM summary_run_reviews").get()!.n,
      2,
    );
    db.close();
  } finally {
    await t.cleanup();
  }
});
test("검토 조회·결정은 비로그인·다른 계정·계정 전환·Origin·잘못된 실행/첨부를 차단한다", async () => {
  const t = await setup();
  try {
    const run = await t.completed(),
      s = await t.state(run.id),
      body = { targetHash: s.targetHash, decision: "approved", comment: "" };
    for (const [cookie, status] of [
      ["", 401],
      [t.b.cookie, 404],
    ] as const) {
      assert.equal((await t.f.get(t.url(run.id), cookie)).status, status);
      assert.equal(
        (await t.decide(run.id, body, randomUUID(), cookie)).status,
        status,
      );
    }
    assert.equal(
      (
        await t.decide(run.id, body, randomUUID(), t.a.cookie, {
          "X-Office-Account": t.b.user.id,
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await t.decide(run.id, body, randomUUID(), t.a.cookie, {
          Origin: "https://other.invalid",
        })
      ).status,
      403,
    );
    for (const path of [
      t.url(randomUUID()),
      t.url("bad"),
      t.url(run.id).replace(t.attachment.id, randomUUID()),
    ]) {
      assert.equal((await t.f.get(path, t.a.cookie)).status, 404);
      assert.equal(
        (
          await t.f.postJson(path, body, t.a.cookie, {
            "Idempotency-Key": randomUUID(),
          })
        ).status,
        404,
      );
    }
    const response = await t.f.get(t.url(run.id), t.a.cookie);
    assert.match(response.headers.get("cache-control")!, /no-store/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  } finally {
    await t.cleanup();
  }
});
test("바뀐 대상 해시·손상 파일은 확정을 막고 확정 후 변경은 당시 기록을 보존하며 유효성만 무효로 표시한다", async () => {
  const t = await setup();
  try {
    const run = await t.completed(),
      s = await t.state(run.id),
      body = { targetHash: s.targetHash, decision: "approved", comment: "" };
    assert.equal(
      (await t.decide(run.id, { ...body, targetHash: "0".repeat(64) })).status,
      409,
    );
    const path = outputFile(t.store.outputRoot, run.id, "csv"),
      saved = readFileSync(path);
    writeFileSync(path, "changed");
    assert.equal((await t.state(run.id)).reviewable, false);
    assert.equal((await t.decide(run.id, body)).status, 409);
    writeFileSync(path, saved);
    const key = randomUUID();
    assert.equal((await t.decide(run.id, body, key)).status, 201);
    rmSync(path);
    let state = await t.state(run.id);
    assert.equal(state.decision.valid, false);
    assert.equal(state.decision.decision, "approved");
    assert.equal((await t.decide(run.id, body, key)).status, 200); // Same receipt despite later file loss.
    writeFileSync(path, saved);
    assert.equal((await t.state(run.id)).decision.valid, true);
    const db = new DatabaseSync(t.f.filename);
    const raw = db
      .prepare("SELECT result_json FROM summary_runs WHERE id=?")
      .get(run.id)!;
    const result = JSON.parse(String(raw.result_json));
    result.totalRows++;
    db.prepare("UPDATE summary_runs SET result_json=? WHERE id=?").run(
      JSON.stringify(result),
      run.id,
    );
    db.close();
    state = await t.state(run.id);
    assert.notEqual(state.targetHash, s.targetHash);
    assert.equal(state.decision.valid, false);
    assert.equal(state.decision.targetHash, s.targetHash);
    assert.equal(
      (await t.decide(run.id, { ...body, targetHash: state.targetHash }))
        .status,
      409,
    );
  } finally {
    await t.cleanup();
  }
});
test("미완료·취소·파일 없는 이전 완료 작업에는 결정을 남길 수 없다", async () => {
  const t = await setup();
  try {
    const pending = await t.enqueue();
    assert.equal((await t.f.get(t.url(pending.id), t.a.cookie)).status, 409);
    await t.f.postJson(
      t.base + "/runs/" + pending.id + "/cancel",
      {},
      t.a.cookie,
    );
    assert.equal((await t.f.get(t.url(pending.id), t.a.cookie)).status, 409);
    const run = await t.completed();
    const db = new DatabaseSync(t.f.filename);
    db.prepare("DELETE FROM summary_run_artifacts WHERE run_id=?").run(run.id);
    db.close();
    const state = await t.state(run.id);
    assert.equal(state.reviewable, false);
    assert.equal(state.decision, null);
    assert.equal(
      (
        await t.decide(run.id, {
          targetHash: state.targetHash,
          decision: "approved",
          comment: "",
        })
      ).status,
      409,
    );
  } finally {
    await t.cleanup();
  }
});
test("v7 완료 요약·파일은 v8 마이그레이션 후 보존되고 검토 대기로 시작한다", async () => {
  const t = await setup();
  try {
    const run = await t.completed(),
      before = await (
        await t.f.get(t.base + "/runs/" + run.id + "/result", t.a.cookie)
      ).json();
    await t.queue.stop();
    const db = new DatabaseSync(t.f.filename);
    dropActivitySchema(db);
    db.exec("DROP TABLE summary_run_reviews; PRAGMA user_version=7;");
    db.close();
    await t.f.restart();
    assert.deepEqual(
      await (
        await t.f.get(t.base + "/runs/" + run.id + "/result", t.a.cookie)
      ).json(),
      before,
    );
    const state = await t.state(run.id);
    assert.equal(state.reviewable, true);
    assert.equal(state.decision, null);
    const check = new DatabaseSync(t.f.filename);
    assert.equal(check.prepare("PRAGMA user_version").get()!.user_version, 9);
    assert.equal(check.prepare("PRAGMA quick_check").get()!.quick_check, "ok");
    assert.equal(check.prepare("PRAGMA foreign_key_check").all().length, 0);
    check.close();
  } finally {
    await t.cleanup();
  }
});

test("결정 저장 오류는 롤백하고 파일 검증 뒤 대상이 바뀐 경우도 트랜잭션에서 차단한다", async () => {
  const t = await setup();
  try {
    const run = await t.completed(),
      state = await t.state(run.id),
      body = {
        targetHash: state.targetHash,
        decision: "approved",
        comment: "",
      },
      key = randomUUID();
    const db = new DatabaseSync(t.f.filename);
    db.exec(
      "CREATE TRIGGER reject_review BEFORE INSERT ON summary_run_reviews BEGIN SELECT RAISE(ABORT,'synthetic error'); END;",
    );
    assert.equal((await t.decide(run.id, body, key)).status, 500);
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM summary_run_reviews").get()!.n,
      0,
    );
    db.exec("DROP TRIGGER reject_review;");
    const original = String(
      db.prepare("SELECT result_json FROM summary_runs WHERE id=?").get(run.id)!
        .result_json,
    );
    const summary = JSON.parse(original);
    summary.includedRows++;
    db.prepare("UPDATE summary_runs SET result_json=? WHERE id=?").run(
      JSON.stringify(summary),
      run.id,
    );
    assert.throws(
      () =>
        t.store.decideSummaryRun(
          t.a.user.id,
          t.job.id,
          t.attachment.id,
          run.id,
          key,
          body as { targetHash: string; decision: "approved"; comment: string },
        ),
      /검토 대상이 변경/,
    );
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM summary_run_reviews").get()!.n,
      0,
    );
    db.prepare("UPDATE summary_runs SET result_json=? WHERE id=?").run(
      original,
      run.id,
    );
    db.close();
    assert.equal((await t.decide(run.id, body, key)).status, 201);
  } finally {
    await t.cleanup();
  }
});
