import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { surveyQuestions } from "../src/survey.ts";
import { summarize } from "../src/summary.ts";
import { PreviewError } from "../src/tabular.ts";
import { fixture } from "./fixture.ts";
import { createStore } from "../src/store.ts";
import { xlsxFixture } from "./xlsxFixture.ts";
import { readXlsx } from "../src/attachments.ts";
import { csvRows } from "../src/csv.ts";
const questions = [
  { index: 0, min: 1, max: 5, required: true },
  { index: 1, min: 1, max: 5, required: false },
];
const selection = {
  sheetId: "csv",
  headerRow: 1,
  columns: [0, 1, 2],
  questions,
};
const data = Buffer.from(
  "A,B,C\n1,5,\n5,,\n,3,\n6,2,\n2.5,1,\n문자,4,\n,,다른 열만\n,,\n",
);
test("정수 척도·필수/선택 문항·행 기준과 문항 통계를 분리한다", () => {
  const result = summarize("csv", data, null, selection),
    survey = result.survey!;
  assert.equal(result.includedRows, 7);
  assert.equal(result.excludedRows, 1);
  assert.deepEqual([survey.validRows, survey.invalidRows], [2, 5]);
  const a = survey.questions[0]!,
    b = survey.questions[1]!;
  assert.deepEqual(
    [
      a.validCount,
      a.missingCount,
      a.nonNumericCount,
      a.nonIntegerCount,
      a.outOfRangeCount,
    ],
    [2, 2, 1, 1, 1],
  );
  assert.deepEqual(
    [a.sum, a.mean, a.minValue, a.maxValue],
    ["6", "3", "1", "5"],
  );
  assert.deepEqual(
    [b.validCount, b.missingCount, b.sum, b.mean],
    [5, 2, "15", "3"],
  );
  for (const q of survey.questions)
    assert.equal(
      q.validCount +
        q.missingCount +
        q.formulaCount +
        q.errorCount +
        q.nonNumericCount +
        q.nonIntegerCount +
        q.outOfRangeCount,
      result.includedRows,
    );
  assert.equal(result.columns[0]!.numeric.sum, "14.5"); // Basic numeric output is unfiltered.
  assert.equal(
    summarize("csv", data, null, { ...selection, questions: [] }).survey,
    null,
  );
  const optional = summarize("csv", data, null, {
    ...selection,
    questions: questions.map((q) => ({ ...q, required: false })),
  }).survey!;
  assert.deepEqual([optional.validRows, optional.invalidRows], [3, 4]);
});
test("미리보기 이후 행·정확한 경계·정수 모양 소수/지수·빈 결과를 처리한다", () => {
  const q = [{ index: 0, min: -2, max: 2, required: false }];
  const r = summarize(
    "csv",
    Buffer.from("A\n-2\n2.0\n+02e0\n1e100\n" + "1\n".repeat(25)),
    null,
    { sheetId: "csv", headerRow: 1, columns: [0], questions: q },
  );
  assert.equal(r.survey!.validRows, 28);
  assert.equal(r.survey!.invalidRows, 1);
  assert.equal(r.survey!.questions[0]!.sum, "27");
  const empty = summarize("csv", Buffer.from("A\n \n"), null, {
    sheetId: "csv",
    headerRow: 1,
    columns: [0],
    questions: q,
  });
  assert.equal(empty.survey!.validRows, 0);
  assert.equal(empty.survey!.questions[0]!.mean, null);
});
test("설문 설정은 중복·미선택 열·잘못된 범위·불리언·추가 필드를 거부한다", () => {
  for (const value of [
    null,
    {},
    [questions[0], questions[0]],
    [{ ...questions[0], index: 9 }],
    [{ ...questions[0], min: 6 }],
    [{ ...questions[0], min: -1000001 }],
    [{ ...questions[0], max: 1000001 }],
    [{ ...questions[0], min: 1.5 }],
    [{ ...questions[0], required: "true" }],
    [{ ...questions[0], extra: true }],
  ])
    assert.throws(() => surveyQuestions(value, [0, 1]), PreviewError);
  assert.deepEqual(surveyQuestions(undefined, [0]), []);
});
test("XLSX 실제 수식·오류·불리언은 설문 유효값에서 제외한다", async () => {
  const bytes = await xlsxFixture();
  const s = summarize("xlsx", bytes, await readXlsx(bytes), {
    sheetId: "0",
    headerRow: 1,
    columns: [0, 1, 2],
    questions: [...questions, { index: 2, min: 1, max: 5, required: false }],
  }).survey!;
  assert.deepEqual([s.validRows, s.invalidRows], [0, 2]);
  assert.equal(s.questions[0]!.validCount, 1);
  assert.equal(s.questions[0]!.nonNumericCount, 1);
  assert.equal(s.questions[1]!.formulaCount, 1);
  assert.equal(s.questions[1]!.outOfRangeCount, 1);
  assert.equal(s.questions[2]!.errorCount, 1);
});
async function setup() {
  const f = await fixture(),
    a = await f.account(),
    b = await f.account();
  const { job } = await (
    await f.post(
      {
        kind: "survey",
        title: "합성 설문 기준",
        instructions: "가상 자료만 집계",
      },
      a.cookie,
    )
  ).json();
  const { attachment } = await (
    await f.upload(job.id, "합성.csv", data, a.cookie)
  ).json();
  return {
    f,
    a,
    b,
    job,
    attachment,
    base: `/api/jobs/${job.id}/attachments/${attachment.id}`,
  };
}
test("설정·재시작 복원·JSON/CSV/HTML 결과 일치와 원본 보존을 확인한다", async () => {
  const { f, a, job, attachment, base } = await setup();
  try {
    const saved = await f.put(
      base + "/selection",
      { ...selection, revision: 0 },
      a.cookie,
    );
    assert.equal(saved.status, 200);
    assert.deepEqual((await saved.json()).selection.questions, questions);
    await f.restart();
    const restored = await (await f.get(base + "/preview", a.cookie)).json();
    assert.deepEqual(restored.selection.questions, questions);
    assert.equal(restored.selection.revision, 1);
    const json = await f.postJson(base + "/summary", { revision: 1 }, a.cookie);
    assert.equal(json.status, 200);
    assert.equal((await json.json()).summary.survey.validRows, 2);
    const csv = await f.postJson(
      base + "/summary.csv",
      { revision: 1 },
      a.cookie,
    );
    assert.equal(csv.status, 200);
    const rows = [...csvRows(Buffer.from(await csv.arrayBuffer()))];
    assert.ok(rows.every((r) => r.length === 8));
    assert.ok(
      rows.some(
        (r) => r[0] === "설문 전체" && r[3] === "유효 응답 행" && r[5] === "2",
      ),
    );
    assert.ok(
      rows.some(
        (r) =>
          r[0] === "설문 문항" &&
          r[1] === "A" &&
          r[3] === "유효값 평균" &&
          r[4] === "'3",
      ),
    );
    const html = await f.postJson(
      base + "/summary.html",
      { revision: 1 },
      a.cookie,
    );
    assert.equal(html.status, 200);
    assert.match(await html.text(), /설문 기준 집계 결과/);
    assert.deepEqual(
      readFileSync(
        join(dirname(f.filename), "attachments", job.id, attachment.id),
      ),
      data,
    );
    assert.equal(
      (await (await f.get(`/api/jobs/${job.id}/events`, a.cookie)).json())
        .events.length,
      1,
    );
  } finally {
    await f.cleanup();
  }
});
test("설정 저장의 소유권·CSRF·잘못된 설정·동시 충돌·오래된 집계·원본 변조를 차단한다", async () => {
  const { f, a, b, job, attachment, base } = await setup();
  try {
    const save = (
      cookie: string,
      revision = 0,
      extra: Record<string, string> = {},
    ) => f.put(base + "/selection", { ...selection, revision }, cookie, extra);
    assert.equal((await save("")).status, 401);
    assert.equal((await save(b.cookie)).status, 404);
    assert.equal(
      (await save(a.cookie, 0, { Origin: "https://external.invalid" })).status,
      403,
    );
    const bad = await f.put(
      base + "/selection",
      { ...selection, revision: 0, questions: [{ ...questions[0], min: 9 }] },
      a.cookie,
    );
    assert.equal(bad.status, 422);
    const parallel = await Promise.all([save(a.cookie), save(a.cookie)]);
    assert.deepEqual(parallel.map((r) => r.status).sort(), [200, 409]);
    assert.equal((await save(a.cookie, 1)).status, 200);
    for (const suffix of ["", ".csv", ".html"])
      assert.equal(
        (
          await f.postJson(
            base + "/summary" + suffix,
            { revision: 1 },
            a.cookie,
          )
        ).status,
        409,
      );
    writeFileSync(
      join(dirname(f.filename), "attachments", job.id, attachment.id),
      "tampered",
    );
    assert.equal((await save(a.cookie, 2)).status, 409);
  } finally {
    await f.cleanup();
  }
});
test("v4 선택·원본·업무·계정·이력을 보존하고 v5 설문 기본값을 추가한다", async () => {
  let account = "",
    jobId = "",
    fileId = "",
    hash = "";
  const f = await fixture({
    seed(filename) {
      const store = createStore(filename);
      const user = store.register(
        "survey_migration",
        "synthetic-unused-hash",
        "synthetic-unused-recovery",
      )!;
      account = user.id;
      store.addAuthSession("synthetic-session", account, Date.now() + 60000);
      const { job } = store.create(
        "synthetic-session",
        "synthetic-key",
        { kind: "survey", title: "합성 이전", instructions: "보존 검증" },
        account,
      );
      jobId = job.id;
      const file = store.saveAttachment(
        account,
        job.id,
        "synthetic-file",
        "합성.csv",
        "csv",
        data,
      ).attachment;
      fileId = file.id;
      hash = file.sha256;
      store.saveSelection(account, jobId, fileId, 0, {
        sheetId: "csv",
        headerRow: 1,
        columns: [0, 1],
      });
      store.close();
      const db = new DatabaseSync(filename);
      db.exec(
        "DROP TABLE summary_run_events; DROP TABLE summary_runs; DROP TABLE summary_queue_lease; ALTER TABLE column_selections DROP COLUMN questions_json; PRAGMA user_version=4;",
      );
      db.close();
    },
  });
  try {
    const store = createStore(f.filename);
    try {
      const s = store.selection(account, jobId, fileId)!;
      assert.equal(s.revision, 1);
      assert.equal(s.sourceHash, hash);
      assert.deepEqual(s.columns, [0, 1]);
      assert.deepEqual(s.questions, []);
      assert.equal(store.detail(account, jobId)!.events.length, 1);
    } finally {
      store.close();
    }
    const db = new DatabaseSync(f.filename, { readOnly: true });
    try {
      assert.equal(
        (db.prepare("PRAGMA user_version").get() as { user_version: number })
          .user_version,
        6,
      );
      assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
      assert.equal(
        (db.prepare("PRAGMA quick_check").get() as { quick_check: string })
          .quick_check,
        "ok",
      );
    } finally {
      db.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("설문 보고서·CSV에서도 원본 문항 제목을 실행하지 않고 안전하게 내보낸다", async () => {
  const { summaryReport } = await import("../src/summaryReport.ts");
  const { summaryCsv } = await import("../src/summaryCsv.ts");
  const summary = summarize(
    "csv",
    Buffer.from("<img src=x onerror=alert(1)>\n1\n"),
    null,
    { sheetId: "csv", headerRow: 1, columns: [0], questions: [questions[0]!] },
  );
  const meta = {
    jobId: "synthetic-job",
    fileId: "synthetic-file",
    filename: "합성.csv",
    sourceHash: "0".repeat(64),
    revision: 1,
    calculatedAt: "2026-10-22T00:00:00.000Z",
  };
  const html = summaryReport(summary, meta).toString();
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(!html.includes("<img"));
  const rows = [...csvRows(summaryCsv(summary, meta))];
  assert.ok(
    rows.some(
      (r) => r[0] === "설문 문항" && r[2] === "'<img src=x onerror=alert(1)>",
    ),
  );
});
