import { readdirSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { createStore } from "../src/store.ts";
import { fixture } from "./fixture.ts";
import { dropActivitySchema } from "./migrationHelpers.ts";

const input = {
  kind: "survey" as const,
  title: "합성 이벤트 업무",
  instructions: "가상 요청",
};
test("업무·첨부·설정·집계·검토를 같은 트랜잭션에 기록하고 재전송/충돌/롤백은 순서를 늘리지 않는다", async (t) => {
  const f = await fixture();
  t.after(() => f.cleanup());
  const a = await f.account(),
    s = createStore(f.filename),
    other = createStore(f.filename),
    db = new DatabaseSync(f.filename);
  t.after(() => {
    s.close();
    other.close();
    db.close();
  });
  const owner = createHash("sha256")
    .update(a.cookie.split("=")[1]!)
    .digest("hex");
  const job = s.create(owner, "same-key", input, a.user.id).job;
  other.create(owner, "same-key", input, a.user.id);
  assert.throws(() =>
    other.create(
      owner,
      "same-key",
      { ...input, title: "합성 다른 제목" },
      a.user.id,
    ),
  );
  const file = s.saveAttachment(
    a.user.id,
    job.id,
    "same-file",
    "합성.csv",
    "csv",
    Buffer.from("A\n1\n"),
  ).attachment;
  other.saveAttachment(
    a.user.id,
    job.id,
    "same-file",
    "합성.csv",
    "csv",
    Buffer.from("A\n1\n"),
  );
  const selection = { sheetId: "csv", headerRow: 1, columns: [0] };
  s.saveSelection(a.user.id, job.id, file.id, 0, selection);
  assert.throws(() =>
    other.saveSelection(a.user.id, job.id, file.id, 0, selection),
  );
  db.exec(
    "CREATE TRIGGER synthetic_failure BEFORE INSERT ON activity_events WHEN NEW.type IN ('selection.saved','attachment.added') BEGIN SELECT RAISE(ABORT,'synthetic'); END;",
  );
  assert.throws(() =>
    s.saveSelection(a.user.id, job.id, file.id, 1, selection),
  );
  assert.equal(s.selection(a.user.id, job.id, file.id)!.revision, 1);
  assert.equal(s.activityHead(a.user.id).sequence, 3);
  const directory = dirname(s.attachmentPath(job.id, file.id));
  const originalFiles = readdirSync(directory).sort();
  assert.throws(() =>
    s.saveAttachment(
      a.user.id,
      job.id,
      "failed-file",
      "합성 실패.csv",
      "csv",
      Buffer.from("A\n2\n"),
    ),
  );
  assert.deepEqual(readdirSync(directory).sort(), originalFiles);
  assert.equal(s.attachments(a.user.id, job.id)!.length, 1);
  assert.equal(s.activityHead(a.user.id).sequence, 3);
  db.exec("DROP TRIGGER synthetic_failure;");
  other.saveSelection(a.user.id, job.id, file.id, 1, selection);
  const { run } = s.enqueueSummary(a.user.id, job.id, file.id, 2, "same-run");
  other.enqueueSummary(a.user.id, job.id, file.id, 2, "same-run");
  s.cancelSummaryRun(a.user.id, job.id, file.id, run.id);
  s.cancelSummaryRun(a.user.id, job.id, file.id, run.id);
  // Synthetic immutable decision metadata; actual file verification remains covered by reviews.test.ts.
  db.prepare("INSERT INTO summary_run_reviews VALUES(?,?,?,?,?,?,?,?,?)").run(
    randomUUID(),
    run.id,
    a.user.id,
    "review-key",
    "a".repeat(64),
    "{}",
    "approved",
    "합성 비공개 의견",
    new Date().toISOString(),
  );
  const head = s.activityHead(a.user.id);
  assert.equal(head.sequence, 7);
  const events = s.activityAfter(a.user.id, 0, head.sequence);
  assert.deepEqual(
    events.map((e) => e.type),
    [
      "job.created",
      "attachment.added",
      "selection.saved",
      "selection.saved",
      "run.changed",
      "run.changed",
      "review.decided",
    ],
  );
  assert.deepEqual(
    events.slice(4).map((e) => e.state),
    ["queued", "cancelled", "approved"],
  );
  assert.deepEqual(
    events.filter((e) => e.type === "selection.saved").map((e) => e.revision),
    [1, 2],
  );
  assert.ok(!JSON.stringify(events).includes("비공개 의견"));
  assert.throws(() => db.exec("UPDATE activity_events SET state='changed'"));
  assert.throws(() => db.exec("DELETE FROM activity_events"));
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
});

test("v8 기록을 보존해 v9 기준점을 만들고 실패한 마이그레이션은 전체 롤백한다", async (t) => {
  let account = "",
    jobId = "",
    fileId = "";
  const f = await fixture({
    seed(filename) {
      const s = createStore(filename);
      const user = s.register(
        "migration_events",
        "synthetic-unused",
        "synthetic-unused-recovery",
      )!;
      account = user.id;
      s.addAuthSession("synthetic-owner", account, Date.now() + 60000);
      jobId = s.create("synthetic-owner", "migrate", input, account).job.id;
      fileId = s.saveAttachment(
        account,
        jobId,
        "migrate-file",
        "합성.csv",
        "csv",
        Buffer.from("A\n1\n"),
      ).attachment.id;
      s.saveSelection(account, jobId, fileId, 0, {
        sheetId: "csv",
        headerRow: 1,
        columns: [0],
      });
      s.close();
      const db = new DatabaseSync(filename);
      dropActivitySchema(db);
      db.exec(
        "PRAGMA user_version=8; CREATE TRIGGER activity_job AFTER INSERT ON jobs BEGIN SELECT 1; END;",
      );
      db.close();
      assert.throws(() => createStore(filename));
      const check = new DatabaseSync(filename);
      assert.equal(check.prepare("PRAGMA user_version").get()!.user_version, 8);
      assert.equal(
        check
          .prepare(
            "SELECT count(*) AS n FROM sqlite_master WHERE name IN ('activity_events','activity_streams')",
          )
          .get()!.n,
        0,
      );
      check.exec("DROP TRIGGER activity_job;");
      check.close();
    },
  });
  t.after(() => f.cleanup());
  const s = createStore(f.filename);
  t.after(() => s.close());
  assert.equal(s.detail(account, jobId)!.job.title, input.title);
  assert.equal(s.attachments(account, jobId)![0]!.id, fileId);
  assert.equal(s.selection(account, jobId, fileId)!.revision, 1);
  assert.equal(s.activityHead(account).sequence, 0);
  assert.deepEqual(s.activityAfter(account, 0, 0), []);
  s.saveSelection(account, jobId, fileId, 1, {
    sheetId: "csv",
    headerRow: 1,
    columns: [0],
  });
  assert.equal(s.activityHead(account).sequence, 1);
  await f.restart();
  assert.equal(s.activityHead(account).sequence, 1);
  const db = new DatabaseSync(f.filename);
  t.after(() => db.close());
  assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 11);
  assert.equal(db.prepare("PRAGMA quick_check").get()!.quick_check, "ok");
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
});

test("익명 이력 가져오기는 대상 계정에 한 번만 기록한다", async (t) => {
  const f = await fixture();
  const a = await f.account(),
    b = await f.account(),
    s = createStore(f.filename);
  t.after(async () => {
    s.close();
    await f.cleanup();
  });
  const owner = "a".repeat(64);
  s.addSession(owner, Date.now() + 60000);
  const job = s.create(owner, "legacy-event", input).job;
  assert.equal(s.activityHead(a.user.id).sequence, 0);
  assert.equal(s.importLegacy(owner, a.user.id), 1);
  assert.equal(s.importLegacy(owner, a.user.id), 0);
  const events = s.activityAfter(a.user.id, 0, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "job.imported");
  assert.equal(events[0]!.jobId, job.id);
  assert.equal(s.activityHead(a.user.id).sequence, 1);
  assert.equal(s.activityHead(b.user.id).sequence, 0);
});
