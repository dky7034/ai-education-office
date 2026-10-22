import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  summaryXlsx,
  spreadsheetText,
  valueChunks,
  XLSX_MIME,
} from "../src/summaryXlsx.ts";
import { summarize } from "../src/summary.ts";
import { PreviewError } from "../src/tabular.ts";
import { fixture } from "./fixture.ts";
import { xlsxFixture } from "./xlsxFixture.ts";
import { readWorkbook } from "./readWorkbook.ts";
const selection = {
  sheetId: "csv",
  headerRow: 1,
  columns: [0, 1],
  questions: [{ index: 0, min: 1, max: 5, required: true }],
};
const meta = {
  jobId: "synthetic-job",
  fileId: "synthetic-file",
  filename: "=가상.csv",
  sourceHash: "0".repeat(64),
  revision: 1,
  calculatedAt: "2026-10-22T00:00:00.000Z",
};
const full = (data: Buffer) =>
  summarize("csv", data, null, selection, {
    fullValues: true,
    frequencyLimit: Infinity,
  });
test("5개 시트의 전체 빈도·설문·정확한 숫자·메타데이터와 안전한 텍스트 셀을 생성한다", async () => {
  const bytes = Buffer.from(
    "척도,값\n1,0.1\n5,0.2\n문자,=1+1\n,01\n,https://example.invalid\n",
  );
  const { sheets, xml } = await readWorkbook(
    await summaryXlsx(full(bytes), meta),
  );
  assert.deepEqual(
    sheets.map((s) => s.name),
    ["집계 안내", "전체 요약", "열별 집계", "설문 문항", "전체 빈도"],
  );
  assert.ok(
    sheets[0]!.rows.some(
      (r) => r.values[0] === "원본 SHA-256" && r.values[1] === meta.sourceHash,
    ),
  );
  assert.ok(
    sheets[0]!.rows.some(
      (r) => r.values[1] === "=가상.csv" && r.types[1] === "inlineStr",
    ),
  );
  assert.ok(
    sheets[1]!.rows.some(
      (r) => r.values[0] === "유효 응답 행" && r.values[1] === 2,
    ),
  );
  const b = sheets[2]!.rows.find((r) => r.values[0] === "B")!;
  assert.equal(b.values[10], "1.3");
  assert.equal(b.values[11], "0.433333");
  assert.equal(b.types[10], "inlineStr");
  assert.equal(b.types[2], "n");
  const q = sheets[3]!.rows[1]!;
  assert.equal(q.values[13], "3");
  assert.equal(q.values[4], "필수");
  assert.ok(
    sheets[4]!.rows.some(
      (r) => r.values[3] === "=1+1" && r.types[3] === "inlineStr",
    ),
  );
  assert.ok(sheets[4]!.rows.some((r) => r.values[3] === "01"));
  for (const [name, value] of xml) {
    assert.ok(!/<f(?:\s|>)/.test(value));
    assert.ok(!value.includes('TargetMode="External"'));
    assert.ok(!name.includes("vbaProject"));
  }
});
test("긴 값은 서로게이트 쌍을 보존하며 분할하고 건수는 첫 조각에만 기록한다", async () => {
  const long = "가".repeat(31999) + "😀" + "끝".repeat(1000);
  const chunks = valueChunks(long);
  assert.equal(chunks.join(""), long);
  assert.equal(chunks[0]!.length, 31999);
  assert.ok(chunks.every((c) => c.length <= 32000));
  const values = [long, ...Array.from({ length: 40 }, (_, i) => "합성" + i)];
  const summary = summarize(
    "csv",
    Buffer.from("A\n" + values.join("\n")),
    null,
    { sheetId: "csv", headerRow: 1, columns: [0] },
    { fullValues: true, frequencyLimit: Infinity },
  );
  const { sheets } = await readWorkbook(await summaryXlsx(summary, meta));
  const rows = sheets[4]!.rows.slice(1);
  assert.equal(rows.length, 42);
  const split = rows.filter((r) => r.values[7] === 2);
  assert.equal(split.map((r) => r.values[3]).join(""), long);
  assert.equal(split[0]!.values[4], 1);
  assert.equal(split[1]!.values[4], undefined);
  assert.equal(
    rows.reduce((sum, r) => sum + Number(r.values[4] ?? 0), 0),
    41,
  );
});
test("OOXML 이스케이프·제어문자·CR·XML 특수 문자를 안전하게 표현한다", () => {
  assert.equal(
    spreadsheetText("_x000D_\r\u0000<&>"),
    "_x005F_x000D__x000D__x0000_&lt;&amp;&gt;",
  );
  assert.equal(spreadsheetText("😀\t\n"), "😀\t\n");
  assert.equal(spreadsheetText("\uD800"), "_xD800_");
});
test("표시용 잘린 결과·XML/압축 크기 초과는 부분 파일 대신 거부한다", async () => {
  const bytes = Buffer.from("A,B\n1,x\n");
  await assert.rejects(
    () => summaryXlsx(full(bytes), meta, { xmlBytes: 20 }),
    PreviewError,
  );
  await assert.rejects(
    () => summaryXlsx(full(bytes), meta, { archiveBytes: 20 }),
    PreviewError,
  );
  const partial = summarize(
    "csv",
    Buffer.from(
      "A,B\n" + Array.from({ length: 40 }, (_, i) => i + ",x").join("\n"),
    ),
    null,
    selection,
  );
  await assert.rejects(() => summaryXlsx(partial, meta), PreviewError);
  const empty = summarize(
    "csv",
    Buffer.from("A\n \n"),
    null,
    { sheetId: "csv", headerRow: 1, columns: [0] },
    { fullValues: true, frequencyLimit: Infinity },
  );
  const { sheets } = await readWorkbook(await summaryXlsx(empty, meta));
  assert.equal(sheets[3]!.rows.length, 1);
  assert.equal(sheets[4]!.rows.length, 1);
  assert.equal(sheets[2]!.rows[1]!.values[10], undefined);
});
test("다운로드 API는 권한·CSRF·원본·설정 버전과 응답 헤더를 검증한다", async () => {
  const f = await fixture();
  try {
    const a = await f.account(),
      b = await f.account();
    const { job } = await (
      await f.post(
        {
          kind: "survey",
          title: "합성 XLSX 출력",
          instructions: "가상 값만 내보내기",
        },
        a.cookie,
      )
    ).json();
    const { attachment } = await (
      await f.upload(
        job.id,
        "합성.csv",
        Buffer.from("A,B\n1,0.1\n5,0.2\n"),
        a.cookie,
      )
    ).json();
    const base = `/api/jobs/${job.id}/attachments/${attachment.id}`;
    await f.put(base + "/selection", { ...selection, revision: 0 }, a.cookie);
    const run = (
      cookie: string,
      revision = 1,
      headers: Record<string, string> = {},
    ) => f.postJson(base + "/summary.xlsx", { revision }, cookie, headers);
    assert.equal((await run("")).status, 401);
    assert.equal((await run(b.cookie)).status, 404);
    assert.equal((await run(a.cookie, 0)).status, 400);
    assert.equal(
      (await run(a.cookie, 1, { Origin: "https://external.invalid" })).status,
      403,
    );
    const result = await run(a.cookie);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("content-type"), XLSX_MIME);
    assert.equal(result.headers.get("cache-control"), "no-store");
    assert.equal(result.headers.get("x-content-type-options"), "nosniff");
    assert.match(
      result.headers.get("content-disposition")!,
      /^attachment; filename="office-summary-.*\.xlsx"/,
    );
    const { sheets } = await readWorkbook(
      Buffer.from(await result.arrayBuffer()),
    );
    assert.ok(sheets[0]!.rows.some((r) => r.values[1] === attachment.sha256));
    assert.equal(sheets[2]!.rows[2]!.values[10], "0.3");
    const preview = await (await f.get(base + "/preview", a.cookie)).json();
    assert.equal(preview.selection.revision, 1);
    await f.put(base + "/selection", { ...selection, revision: 1 }, a.cookie);
    assert.equal((await run(a.cookie)).status, 409);
    writeFileSync(
      join(dirname(f.filename), "attachments", job.id, attachment.id),
      "tampered",
    );
    assert.equal((await run(a.cookie, 2)).status, 409);
    const uploaded = await f.upload(
      job.id,
      "합성.xlsx",
      await xlsxFixture(),
      a.cookie,
      "xlsx-source",
    );
    assert.equal(uploaded.status, 201);
    const file = (await uploaded.json()).attachment,
      xb = `/api/jobs/${job.id}/attachments/${file.id}`;
    await f.put(
      xb + "/selection",
      { sheetId: "0", headerRow: 1, columns: [0, 1, 2], revision: 0 },
      a.cookie,
    );
    const response = await f.postJson(
      xb + "/summary.xlsx",
      { revision: 1 },
      a.cookie,
    );
    assert.equal(response.status, 200);
    const workbook = await readWorkbook(
      Buffer.from(await response.arrayBuffer()),
    );
    assert.equal(workbook.sheets[2]!.rows[2]!.values[4], 1);
    assert.equal(workbook.sheets[2]!.rows[3]!.values[5], 1);
  } finally {
    await f.cleanup();
  }
});
