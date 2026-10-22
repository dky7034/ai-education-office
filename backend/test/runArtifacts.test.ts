import { dropActivitySchema } from "./migrationHelpers.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fixture } from "./fixture.ts";
import { createStore } from "../src/store.ts";
import { createSummaryQueue } from "../src/summaryQueue.ts";
import {
  ARTIFACT_LIMITS,
  outputPaths,
  outputFile,
  writeArtifactSet,
  publishArtifactSet,
  readArtifact,
  sweepOutputs,
  discardOutputs,
} from "../src/runArtifacts.ts";
import { summarize, displaySummary } from "../src/summary.ts";
import { readWorkbook } from "./readWorkbook.ts";
const selection = {
  sheetId: "csv",
  headerRow: 1,
  columns: [0, 1],
  questions: [],
};
const long = "가😀".repeat(11000);
const bytes = Buffer.from(
  `A,B\n1,0.1\n5,0.2\n=1+1,"${long}"\n` +
    Array.from({ length: 35 }, (_, i) => `${i + 10},합성${i}`).join("\n"),
);
async function setup() {
  const f = await fixture(),
    a = await f.account(),
    b = await f.account();
  const { job } = await (
    await f.post(
      { kind: "survey", title: "합성 보관 검증", instructions: "가상 자료" },
      a.cookie,
    )
  ).json();
  const { attachment } = await (
    await f.upload(job.id, "합성.csv", bytes, a.cookie)
  ).json();
  const base = `/api/jobs/${job.id}/attachments/${attachment.id}`;
  assert.equal(
    (await f.put(base + "/selection", { ...selection, revision: 0 }, a.cookie))
      .status,
    200,
  );
  const store = createStore(f.filename);
  const queue = createSummaryQueue(store, { pollMs: 10 });
  const enqueue = async () =>
    (
      await (
        await f.postJson(base + "/runs", { revision: 1 }, a.cookie, {
          "Idempotency-Key": randomUUID(),
        })
      ).json()
    ).run;
  const terminal = async (id: string) => {
    for (let i = 0; i < 400; i++) {
      const r = await (await f.get(base + "/runs/" + id, a.cookie)).json();
      if (!["queued", "running"].includes(r.run.status)) return r.run;
      await wait(20);
    }
    throw Error("집계 완료 시간 초과");
  };
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
    terminal,
    async cleanup() {
      await queue.stop();
      store.close();
      await f.cleanup();
    },
  };
}
test("완료 결과 3종을 같은 시각·버전으로 보관하고 설정·원본 변경과 서버 재시작 뒤에도 동일 바이트를 내려받는다", async () => {
  const t = await setup();
  const { f, a, base, store, queue, job, attachment } = t;
  try {
    const run = await t.enqueue();
    queue.start();
    assert.equal((await t.terminal(run.id)).status, "completed");
    const url = base + "/runs/" + run.id;
    const result = await (await f.get(url + "/result", a.cookie)).json();
    assert.deepEqual(
      result.summary.columns,
      summarize("csv", bytes, null, selection).columns,
    );
    assert.equal(result.artifacts.length, 3);
    const outputs = new Map<string, Buffer>();
    for (const artifact of result.artifacts) {
      assert.equal(artifact.createdAt, result.summary.calculatedAt);
      const response = await f.get(
        url + "/artifacts/" + artifact.format,
        a.cookie,
      );
      assert.equal(response.status, 200);
      assert.match(
        response.headers.get("content-disposition")!,
        new RegExp(run.id),
      );
      assert.match(response.headers.get("cache-control")!, /no-store/);
      const data = Buffer.from(await response.arrayBuffer());
      outputs.set(artifact.format, data);
      assert.equal(data.length, artifact.size);
      assert.equal(
        createHash("sha256").update(data).digest("hex"),
        artifact.sha256,
      );
      assert.equal(
        statSync(outputFile(store.outputRoot, run.id, artifact.format)).mode &
          0o777,
        0o600,
      );
    }
    assert.equal(statSync(join(store.outputRoot, run.id)).mode & 0o777, 0o700);
    assert.ok(
      outputs
        .get("csv")!
        .toString()
        .includes("'" + long),
    );
    assert.ok(outputs.get("csv")!.toString().includes(run.id));
    const html = outputs.get("html")!.toString();
    assert.ok(html.includes(run.id));
    assert.ok(html.includes(attachment.sha256));
    const { sheets } = await readWorkbook(outputs.get("xlsx")!);
    assert.equal(sheets.length, 5);
    assert.ok(sheets[0]!.rows.some((r) => r.values.includes(run.id)));
    assert.equal(
      sheets[4]!.rows
        .filter((r) => r.values[7] === 2)
        .map((r) => r.values[3])
        .join(""),
      long,
    );
    await queue.stop();
    assert.equal(
      (
        await f.put(
          base + "/selection",
          { ...selection, columns: [1], revision: 1 },
          a.cookie,
        )
      ).status,
      200,
    );
    rmSync(store.attachmentPath(job.id, attachment.id));
    await f.restart();
    for (const [format, data] of outputs) {
      const response = await f.get(url + "/artifacts/" + format, a.cookie);
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), data);
    }
    assert.equal(
      (await (await f.get(url + "/result", a.cookie)).json()).summary.revision,
      1,
    );
  } finally {
    await t.cleanup();
  }
});
test("보관 다운로드는 계정·첨부·완료 상태를 검사하고 변조·분실·심볼릭 링크를 차단한다", async () => {
  const t = await setup();
  const { f, a, b, base, store, queue } = t;
  try {
    const run = await t.enqueue(),
      url = base + "/runs/" + run.id + "/artifacts/";
    assert.equal((await f.get(url + "csv", a.cookie)).status, 409);
    queue.start();
    assert.equal((await t.terminal(run.id)).status, "completed");
    assert.equal((await f.get(url + "csv")).status, 401);
    assert.equal((await f.get(url + "csv", b.cookie)).status, 404);
    assert.equal((await f.get(url + "pdf", a.cookie)).status, 404);
    assert.equal(
      (
        await f.get(
          url.replace(t.attachment.id, randomUUID()) + "csv",
          a.cookie,
        )
      ).status,
      404,
    );
    const path = outputFile(store.outputRoot, run.id, "csv"),
      saved = readFileSync(path);
    const changed = Buffer.from(saved);
    changed[changed.length - 1] ^= 1;
    writeFileSync(path, changed);
    assert.equal((await f.get(url + "csv", a.cookie)).status, 409);
    rmSync(path);
    assert.equal((await f.get(url + "csv", a.cookie)).status, 409);
    const elsewhere = join(dirname(f.filename), "elsewhere.csv");
    writeFileSync(elsewhere, saved);
    symlinkSync(elsewhere, path);
    assert.equal((await f.get(url + "csv", a.cookie)).status, 409);
    rmSync(path);
    writeFileSync(path, saved);
    const final = join(store.outputRoot, run.id),
      moved = join(dirname(f.filename), "elsewhere-dir");
    const { renameSync } = await import("node:fs");
    renameSync(final, moved);
    symlinkSync(moved, final, "dir");
    assert.equal((await f.get(url + "csv", a.cookie)).status, 409);
    rmSync(final);
    renameSync(moved, final);
    assert.equal((await f.get(url + "csv", a.cookie)).status, 200);
    assert.equal(
      (await f.get(base + "/runs/" + run.id + "/result", a.cookie)).status,
      200,
    );
  } finally {
    await t.cleanup();
  }
});
test("v6 완료 기록은 v7 마이그레이션 뒤 결과를 유지하며 파일을 새로 만들지 않는다", async () => {
  const t = await setup();
  const { f, a, base, store } = t;
  try {
    const run = await t.enqueue();
    const db = new DatabaseSync(f.filename);
    const summary = {
      ...summarize("csv", bytes, null, selection),
      revision: 1,
      sourceHash: t.attachment.sha256,
      calculatedAt: new Date().toISOString(),
    };
    db.prepare(
      "UPDATE summary_runs SET status='completed',result_json=?,finished_at=? WHERE id=?",
    ).run(JSON.stringify(summary), summary.calculatedAt, run.id);
    dropActivitySchema(db);
    db.exec("DROP TABLE summary_run_reviews; DROP TABLE summary_run_artifacts; PRAGMA user_version=6;");
    db.close();
    await f.restart();
    const result = await (
      await f.get(base + "/runs/" + run.id + "/result", a.cookie)
    ).json();
    assert.deepEqual(result.summary, summary);
    assert.deepEqual(result.artifacts, []);
    assert.equal(
      (await f.get(base + "/runs/" + run.id + "/artifacts/csv", a.cookie))
        .status,
      404,
    );
    assert.equal(existsSync(join(store.outputRoot, run.id)), false);
    const check = new DatabaseSync(f.filename);
    assert.equal(check.prepare("PRAGMA user_version").get()!.user_version, 10);
    assert.equal(check.prepare("PRAGMA foreign_key_check").all().length, 0);
    check.close();
  } finally {
    await t.cleanup();
  }
});
test("3개 파일을 모두 검증해야 게시하며 손상·출력 초과 시 부분 파일을 공개하지 않는다", async () => {
  const t = await setup();
  const root = t.store.outputRoot;
  try {
    const paths = outputPaths(root, randomUUID(), randomUUID());
    const buffers = {
      csv: Buffer.from("csv"),
      html: Buffer.from("html"),
      xlsx: Buffer.from("xlsx"),
    };
    const artifacts = writeArtifactSet(
      paths.stage,
      buffers,
      new Date().toISOString(),
    );
    writeFileSync(join(paths.stage, "summary.xlsx"), "xxxx");
    assert.throws(() =>
      publishArtifactSet(paths.stage, paths.final, artifacts),
    );
    assert.equal(existsSync(paths.final), false);
    discardOutputs(paths.stage, paths.final, false);
    assert.equal(existsSync(paths.stage), false);
    assert.throws(() =>
      writeArtifactSet(
        paths.stage,
        { ...buffers, html: Buffer.alloc(ARTIFACT_LIMITS.html + 1) },
        new Date().toISOString(),
      ),
    );
    assert.equal(existsSync(paths.stage), false);
    const good = writeArtifactSet(
      paths.stage,
      buffers,
      new Date().toISOString(),
    );
    publishArtifactSet(paths.stage, paths.final, good);
    for (const a of good)
      assert.deepEqual(
        await readArtifact(join(paths.final, "summary." + a.format), a),
        buffers[a.format],
      );
    discardOutputs(paths.stage, paths.final, true);
    assert.ok(existsSync(paths.final));
  } finally {
    await t.cleanup();
  }
});
test("출력 경로 오류로 실패한 작업은 파일 메타데이터·부분 결과를 남기지 않는다", async () => {
  const t = await setup();
  try {
    writeFileSync(t.store.outputRoot, "occupied");
    const run = await t.enqueue();
    t.queue.start();
    assert.equal((await t.terminal(run.id)).status, "failed");
    const db = new DatabaseSync(t.f.filename);
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM summary_run_artifacts").get()!.n,
      0,
    );
    db.close();
    assert.equal(
      (await t.f.get(t.base + "/runs/" + run.id + "/artifacts/csv", t.a.cookie))
        .status,
      409,
    );
  } finally {
    await t.cleanup();
  }
});
test("취소·서버 중단은 워커 종료 후 부분 파일을 지우고 재시작 정리는 완료·알 수 없는 파일을 보존한다", async () => {
  const t = await setup();
  try {
    const worker = join(dirname(t.f.filename), "partial-worker.mjs");
    writeFileSync(
      worker,
      `import {workerData} from 'node:worker_threads'; import {mkdirSync,writeFileSync} from 'node:fs'; import {dirname,join} from 'node:path'; mkdirSync(dirname(workerData.stage),{recursive:true}); mkdirSync(workerData.stage); writeFileSync(join(workerData.stage,'summary.csv'),'partial'); setInterval(()=>{},1000);`,
    );
    const { pathToFileURL } = await import("node:url");
    for (const action of ["cancel", "stop"]) {
      const run = await t.enqueue();
      const queue = createSummaryQueue(t.store, {
        pollMs: 10,
        workerUrl: pathToFileURL(worker),
      });
      queue.start();
      try {
        let stage = "";
        for (let i = 0; i < 200; i++) {
          stage =
            (existsSync(t.store.outputRoot)
              ? readdirSync(t.store.outputRoot)
              : []
            ).find((n) => n.startsWith(".staging-" + run.id)) ?? "";
          if (stage) break;
          await wait(10);
        }
        assert.ok(stage);
        if (action === "cancel")
          await t.f.postJson(
            t.base + "/runs/" + run.id + "/cancel",
            {},
            t.a.cookie,
          );
        await queue.stop();
        assert.equal(existsSync(join(t.store.outputRoot, stage)), false);
        assert.equal(existsSync(join(t.store.outputRoot, run.id)), false);
      } finally {
        await queue.stop();
      }
    }
    const ids = {
      failed: randomUUID(),
      completed: randomUUID(),
      unknown: randomUUID(),
      active: randomUUID(),
    };
    const active = outputPaths(
      t.store.outputRoot,
      ids.active,
      randomUUID(),
    ).stage;
    const failedStage = outputPaths(
      t.store.outputRoot,
      ids.failed,
      randomUUID(),
    ).stage;
    for (const path of [
      active,
      failedStage,
      ...Object.values(ids)
        .slice(0, 3)
        .map((id) => join(t.store.outputRoot, id)),
    ])
      mkdirSync(path, { recursive: true });
    sweepOutputs(
      t.store.outputRoot,
      (id) =>
        id === ids.failed
          ? "failed"
          : id === ids.completed
            ? "completed"
            : id === ids.active
              ? "running"
              : null,
      active,
    );
    assert.equal(existsSync(failedStage), false);
    assert.equal(existsSync(join(t.store.outputRoot, ids.failed)), false);
    for (const path of [
      active,
      join(t.store.outputRoot, ids.completed),
      join(t.store.outputRoot, ids.unknown),
    ])
      assert.ok(existsSync(path));
  } finally {
    await t.cleanup();
  }
});
test("전체 빈도에서 만든 표시 요약이 직접 집계의 상위 30개·200자·나머지 건수와 일치한다", () => {
  const full = summarize("csv", bytes, null, selection, {
    fullValues: true,
    frequencyLimit: Infinity,
  });
  assert.deepEqual(
    displaySummary(full),
    summarize("csv", bytes, null, selection),
  );
  assert.ok(full.columns[1]!.frequencies.some((f) => f.value === long));
});

test("메타데이터 저장 도중 DB 오류가 나면 전체 트랜잭션과 게시 파일을 되돌린다", async () => {
  const t = await setup();
  try {
    const db = new DatabaseSync(t.f.filename);
    db.exec(
      "CREATE TRIGGER reject_artifact BEFORE INSERT ON summary_run_artifacts WHEN NEW.format='xlsx' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;",
    );
    const run = await t.enqueue();
    t.queue.start();
    assert.equal((await t.terminal(run.id)).status, "failed");
    await t.queue.stop();
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM summary_run_artifacts").get()!.n,
      0,
    );
    assert.equal(
      db.prepare("SELECT result_json FROM summary_runs WHERE id=?").get(run.id)!
        .result_json,
      null,
    );
    assert.equal(existsSync(join(t.store.outputRoot, run.id)), false);
    assert.deepEqual(readdirSync(t.store.outputRoot), []);
    db.close();
  } finally {
    await t.cleanup();
  }
});

test("개발 파일 감시의 모듈 알림을 집계 결과로 오인하지 않고 실제 워커를 완료한다", async () => {
  const t = await setup();
  const { pathToFileURL } = await import("node:url");
  const worker = join(dirname(t.f.filename), "watch-worker.mjs");
  const workerUrl = new URL("../src/summaryWorker.ts", import.meta.url).href;
  writeFileSync(
    worker,
    `process.env.WATCH_REPORT_DEPENDENCIES='1'; await import(${JSON.stringify(workerUrl)});`,
  );
  const queue = createSummaryQueue(t.store, {
    pollMs: 10,
    workerUrl: pathToFileURL(worker),
  });
  try {
    const run = await t.enqueue();
    queue.start();
    assert.equal((await t.terminal(run.id)).status, "completed");
    for (const format of ["csv", "html", "xlsx"])
      assert.equal(
        (
          await t.f.get(
            t.base + "/runs/" + run.id + "/artifacts/" + format,
            t.a.cookie,
          )
        ).status,
        200,
      );
  } finally {
    await queue.stop();
    await t.cleanup();
  }
});
