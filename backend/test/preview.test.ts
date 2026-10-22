import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readXlsx } from "../src/attachments.ts";
import { tablePreview, PreviewError } from "../src/tabular.ts";
import { createStore } from "../src/store.ts";
import { fixture } from "./fixture.ts";
import { xlsxFixture } from "./xlsxFixture.ts";
const input = {
  kind: "survey",
  title: "합성 설문 열 선택",
  instructions: "열 선택만 저장합니다.",
};
const csv = Buffer.from(
  '\uFEFF가상 제목\r\n"만족,도",만족도,,의견\r\n5,4,,"가상\n의견"\r\n',
);
const selection = {
  sheetId: "csv",
  headerRow: 2,
  columns: [0, 3],
  revision: 0,
};
async function setup() {
  const f = await fixture();
  const account = await f.account();
  const { job } = await (await f.post(input, account.cookie)).json();
  const { attachment } = await (
    await f.upload(job.id, "합성.csv", csv, account.cookie)
  ).json();
  const base = `/api/jobs/${job.id}/attachments/${attachment.id}`;
  return { f, account, job, attachment, base };
}
test("CSV 인용 구분자·줄바꿈·빈 열·중복 제목·표시 한도를 처리한다", () => {
  const bytes = Buffer.from(
    '"만족,도";만족도;;의견\r\n5;4;;"가상\n의견"\r\n' +
      "1;2;;" +
      "가".repeat(220) +
      "\r\n" +
      "1;2;;추가\r\n".repeat(25),
  );
  const preview = tablePreview("csv", bytes, null);
  assert.deepEqual(
    preview.columns.map((c) => c.label),
    ["만족,도", "만족도", "제목 없음", "의견"],
  );
  assert.equal(preview.rows[0]!.values[3], "가상\n의견");
  assert.equal(preview.rows[1]!.values[3]!.length, 200);
  assert.equal(preview.cellsTruncated, true);
  assert.equal(preview.rows.length, 20);
  assert.equal(preview.rowsTruncated, true);
  assert.equal(preview.totalRows, 28);
});
test("XLSX 시트·공유/리치/인라인 문자열·빈 행·희소 열·수식 비실행을 처리한다", async () => {
  const data = await xlsxFixture(),
    xml = await readXlsx(data);
  const p = tablePreview("xlsx", data, xml);
  assert.deepEqual(
    p.sheets.map((s) => s.name),
    ["합성 설문", "두 번째 시트"],
  );
  assert.equal(p.columns[0]!.label, "만족도");
  assert.equal(p.columns[1]!.label, "제목 없음");
  assert.deepEqual(p.rows[0]!.values, [
    "5",
    "[수식: 계산하지 않음]",
    "가상 의견",
  ]);
  assert.equal(p.rows[1]!.rowNumber, 3);
  assert.deepEqual(p.rows[1]!.values, []);
  assert.deepEqual(p.rows[2]!.values, ["TRUE", "45292", "[셀 오류] #N/A"]);
  assert.equal(
    tablePreview("xlsx", data, xml, "1").rows[0]!.values[0],
    "다른 합성 자료",
  );
});
test("빈 표·없는 제목/시트·행/열/셀 한도와 잘못된 XLSX 참조를 거부한다", async () => {
  for (const [data, header] of [
    ["a,b\n1,2", 3],
    ["a,b\n1,2", 0],
    [Array(101).fill("a").join(","), 1],
    ["a\n".repeat(20001), 1],
    [("a,".repeat(20) + "a\n").repeat(5000), 1],
  ] as const)
    assert.throws(
      () => tablePreview("csv", Buffer.from(data), null, undefined, header),
      PreviewError,
    );
  const bytes = await xlsxFixture();
  const xml = await readXlsx(bytes);
  assert.throws(
    () => tablePreview("xlsx", bytes, xml, "missing"),
    PreviewError,
  );
  const bad = new Map(xml);
  bad.set(
    "xl/sharedStrings.xml",
    '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>',
  );
  assert.throws(() => tablePreview("xlsx", bytes, bad), PreviewError);
  const empty = new Map(xml);
  empty.set(
    "xl/worksheets/sheet2.xml",
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>',
  );
  assert.throws(() => tablePreview("xlsx", bytes, empty, "1"), PreviewError);
});
test("열 선택 저장·제목 행·재시작 복원·원본 불변을 확인한다", async () => {
  const { f, account, attachment, base, job } = await setup();
  try {
    const preview = await (
      await f.get(base + "/preview?headerRow=2", account.cookie)
    ).json();
    assert.equal(preview.selection, null);
    assert.equal(preview.preview.headerRow, 2);
    assert.equal(preview.preview.columns.length, 4);
    const saved = await f.put(base + "/selection", selection, account.cookie);
    assert.equal(saved.status, 200);
    const stored = (await saved.json()).selection;
    assert.equal(stored.sourceHash, attachment.sha256);
    assert.equal(stored.revision, 1);
    await f.restart();
    const restored = await (
      await f.get(base + "/preview", account.cookie)
    ).json();
    assert.equal(restored.preview.headerRow, 2);
    assert.deepEqual(restored.selection.columns, [0, 3]);
    assert.deepEqual(
      readFileSync(
        join(dirname(f.filename), "attachments", job.id, attachment.id),
      ),
      csv,
    );
  } finally {
    await f.cleanup();
  }
});
test("미리보기·선택 저장의 로그인·소유권·CSRF·계정 전환을 검사한다", async () => {
  const { f, account, base } = await setup();
  try {
    const other = await f.account();
    for (const [cookie, status] of [
      ["", 401],
      [other.cookie, 404],
    ] as const) {
      assert.equal((await f.get(base + "/preview", cookie)).status, status);
      assert.equal(
        (await f.put(base + "/selection", selection, cookie)).status,
        status,
      );
    }
    for (const headers of [
      { Origin: "https://external.invalid" },
      { "X-Office-Request": "" },
      { "Content-Type": "text/plain" },
    ])
      assert.equal(
        (await f.put(base + "/selection", selection, account.cookie, headers))
          .status,
        403,
      );
    assert.equal(
      (
        await f.put(base + "/selection", selection, account.cookie, {
          "X-Office-Account": other.user.id,
        })
      ).status,
      401,
    );
    assert.equal(
      (await f.get(base + "/preview", account.cookie)).headers.get(
        "cache-control",
      ),
      "no-store",
    );
  } finally {
    await f.cleanup();
  }
});
test("잘못된 선택·실제 없는 열·쿼리는 저장하지 않는다", async () => {
  const { f, account, base } = await setup();
  try {
    for (const body of [
      null,
      [],
      { ...selection, columns: [] },
      { ...selection, columns: [0, 0] },
      { ...selection, columns: [-1] },
      { ...selection, columns: ["0"] },
      { ...selection, revision: -1 },
      { ...selection, sourceHash: "forged" },
    ])
      assert.equal(
        (await f.put(base + "/selection", body, account.cookie)).status,
        400,
      );
    for (const body of [
      { ...selection, columns: [9] },
      { ...selection, sheetId: "wrong" },
      { ...selection, headerRow: 21 },
    ])
      assert.equal(
        (await f.put(base + "/selection", body, account.cookie)).status,
        422,
      );
    for (const query of [
      "headerRow=x",
      "headerRow=1&headerRow=2",
      "sheetId=a&sheetId=b",
      "unknown=1",
    ])
      assert.equal(
        (await f.get(base + "/preview?" + query, account.cookie)).status,
        400,
      );
    assert.equal(
      (await (await f.get(base + "/preview", account.cookie)).json()).selection,
      null,
    );
  } finally {
    await f.cleanup();
  }
});
test("동시 저장·오래된 버전은 덮어쓰지 않고 충돌을 알린다", async () => {
  const { f, account, base } = await setup();
  try {
    const responses = await Promise.all([
      f.put(base + "/selection", selection, account.cookie),
      f.put(
        base + "/selection",
        { ...selection, columns: [1] },
        account.cookie,
      ),
    ]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
    assert.equal(
      (await f.put(base + "/selection", selection, account.cookie)).status,
      409,
    );
    assert.equal(
      (
        await f.put(
          base + "/selection",
          { ...selection, revision: 1, columns: [1] },
          account.cookie,
        )
      ).status,
      200,
    );
    const result = await (
      await f.get(base + "/preview", account.cookie)
    ).json();
    assert.equal(result.selection.revision, 2);
    assert.deepEqual(result.selection.columns, [1]);
  } finally {
    await f.cleanup();
  }
});
test("원본 변조는 미리보기·열 선택 저장을 차단한다", async () => {
  const { f, account, base, job, attachment } = await setup();
  try {
    writeFileSync(
      join(dirname(f.filename), "attachments", job.id, attachment.id),
      "tampered",
    );
    assert.equal((await f.get(base + "/preview", account.cookie)).status, 409);
    assert.equal(
      (await f.put(base + "/selection", selection, account.cookie)).status,
      409,
    );
  } finally {
    await f.cleanup();
  }
});
test("v3에서 첨부·계정·업무·이벤트를 보존하며 v8로 추가 마이그레이션한다", async () => {
  let userId = "",
    jobId = "",
    fileId = "";
  const f = await fixture({
    seed(filename) {
      const s = createStore(filename);
      const user = s.register(
        "preview_migration",
        "synthetic-unused-hash",
        "synthetic-unused-recovery",
      )!;
      userId = user.id;
      s.addAuthSession("synthetic-session", userId, Date.now() + 60000);
      const { job } = s.create(
        "synthetic-session",
        "migration-key",
        { ...input, kind: "survey" },
        userId,
      );
      jobId = job.id;
      fileId = s.saveAttachment(
        userId,
        jobId,
        "migration-file",
        "합성.csv",
        "csv",
        csv,
      ).attachment.id;
      s.close();
      const db = new DatabaseSync(filename);
      db.exec("DROP TABLE summary_run_reviews; DROP TABLE summary_run_artifacts; DROP TABLE summary_run_events; DROP TABLE summary_runs; DROP TABLE summary_queue_lease; DROP TABLE column_selections; PRAGMA user_version=3;");
      db.close();
    },
  });
  try {
    const s = createStore(f.filename);
    try {
      assert.equal(s.detail(userId, jobId)!.events.length, 1);
      assert.equal(s.attachments(userId, jobId)![0]!.id, fileId);
      assert.equal(s.selection(userId, jobId, fileId), null);
    } finally {
      s.close();
    }
    const db = new DatabaseSync(f.filename, { readOnly: true });
    try {
      assert.equal(
        (db.prepare("PRAGMA user_version").get() as { user_version: number })
          .user_version,
        8,
      );
      assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
    } finally {
      db.close();
    }
  } finally {
    await f.cleanup();
  }
});
