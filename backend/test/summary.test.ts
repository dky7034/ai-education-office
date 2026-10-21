import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { summarize } from "../src/summary.ts";
import { readXlsx } from "../src/attachments.ts";
import { PreviewError } from "../src/tabular.ts";
import { fixture } from "./fixture.ts";
import { xlsxFixture } from "./xlsxFixture.ts";
const pick = { sheetId: "csv", headerRow: 1, columns: [0, 1] };
const bytes = Buffer.from(
  "A,B,C\n x ,1,\nx,01,\nX,,\n,,다른 열만\n , ,\n0,0,\n",
);
const countInvariant = (result: ReturnType<typeof summarize>) => {
  assert.equal(result.includedRows + result.excludedRows, result.totalRows);
  for (const col of result.columns) {
    assert.equal(
      col.valueCount + col.missingCount + col.formulaCount + col.errorCount,
      result.includedRows,
    );
    assert.equal(
      col.frequencies.reduce((sum, e) => sum + e.count, 0) + col.otherCount,
      col.valueCount,
    );
  }
};
test("선택 열 공란 행 제외·열별 누락·공백 정리·숫자 표기·0·대소문자를 정확히 집계한다", () => {
  const result = summarize("csv", bytes, null, pick);
  assert.deepEqual(
    [result.totalRows, result.includedRows, result.excludedRows],
    [6, 4, 2],
  );
  assert.deepEqual(result.columns[0]!.frequencies, [
    { value: "x", valueTruncated: false, count: 2 },
    { value: "0", valueTruncated: false, count: 1 },
    { value: "X", valueTruncated: false, count: 1 },
  ]);
  assert.equal(result.columns[1]!.missingCount, 1);
  assert.equal(result.columns[1]!.distinctCount, 3);
  countInvariant(result);
});
test("미리보기 20행 이후도 집계하며 상위 30개 외 빈도 합계를 보존한다", () => {
  const data = Buffer.from(
    "A\n" +
      Array.from({ length: 40 }, (_, i) => String(i).padStart(3, "0")).join(
        "\n",
      ) +
      "\n" +
      "반복\n".repeat(25),
  );
  const result = summarize("csv", data, null, { ...pick, columns: [0] });
  const col = result.columns[0]!;
  assert.equal(result.includedRows, 65);
  assert.equal(col.valueCount, 65);
  assert.equal(col.distinctCount, 41);
  assert.equal(col.frequencies.length, 30);
  assert.equal(col.frequencies[0]!.value, "반복");
  assert.equal(col.frequencies[0]!.count, 25);
  assert.equal(col.otherDistinctCount, 11);
  assert.equal(col.otherCount, 11);
  countInvariant(result);
});
test("긴 값을 표시용으로 잘라도 서로 다른 원문·공유 문자열은 합치지 않는다", async () => {
  const a = "가".repeat(210) + "A",
    b = "가".repeat(210) + "B";
  const csv = summarize("csv", Buffer.from(`A\n${a}\n${b}\n${a}\n`), null, {
    ...pick,
    columns: [0],
  });
  assert.equal(csv.columns[0]!.distinctCount, 2);
  assert.equal(csv.columns[0]!.frequencies[0]!.count, 2);
  assert.equal(csv.columns[0]!.frequencies[0]!.valueTruncated, true);
  const xmlBytes = await xlsxFixture({
    "xl/sharedStrings.xml": `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>${a}</t></si><si><t>${b}</t></si></sst>`,
    "xl/worksheets/sheet1.xml":
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>값</t></is></c></row><row r="2"><c r="A2" t="s"><v>0</v></c></row><row r="3"><c r="A3" t="s"><v>1</v></c></row></sheetData></worksheet>',
  });
  const xlsx = summarize("xlsx", xmlBytes, await readXlsx(xmlBytes), {
    sheetId: "0",
    headerRow: 1,
    columns: [0],
  });
  assert.equal(xlsx.columns[0]!.distinctCount, 2);
  countInvariant(xlsx);
});
test("XLSX 실제 수식·오류는 별도로 세고 같은 모양의 문자열은 일반 값으로 센다", async () => {
  const data = await xlsxFixture({
    "xl/worksheets/sheet1.xml":
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>값</t></is></c><c r="B1" t="inlineStr"><is><t>의견</t></is></c></row><row r="2"><c r="A2"><f>HYPERLINK("https://invalid.invalid")</f><v>999</v></c><c r="B2" t="s"><v>1</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>[수식: 계산하지 않음]</t></is></c><c r="B3" t="e"><v>#N/A</v></c></row><row r="5"><c r="A5"><v>0</v></c></row></sheetData></worksheet>',
  });
  const result = summarize("xlsx", data, await readXlsx(data), {
    sheetId: "0",
    headerRow: 1,
    columns: [0, 1],
  });
  assert.deepEqual(
    [result.totalRows, result.includedRows, result.excludedRows],
    [4, 3, 1],
  );
  assert.equal(result.columns[0]!.formulaCount, 1);
  assert.equal(result.columns[0]!.valueCount, 2);
  assert.equal(result.columns[1]!.errorCount, 1);
  assert.equal(result.columns[1]!.missingCount, 1);
  countInvariant(result);
});
test("제목 행 이전은 제외하고 선택 열이 모두 비면 빈 집계를 반환한다", () => {
  const result = summarize(
    "csv",
    Buffer.from("가상 안내\nA,B\n,다른 열만\n ,값\n"),
    null,
    { sheetId: "csv", headerRow: 2, columns: [0] },
  );
  assert.equal(result.includedRows, 0);
  assert.equal(result.excludedRows, 2);
  assert.deepEqual(result.columns[0]!.frequencies, []);
  assert.equal(result.columns[0]!.missingCount, 0);
  countInvariant(result);
  const headerOnly = summarize("csv", Buffer.from("A\n"), null, {
    ...pick,
    columns: [0],
  });
  assert.equal(headerOnly.totalRows, 0);
  countInvariant(headerOnly);
});
test("CSV 수식 모양·HTML·특수 키는 실행/객체 키 변환 없이 문자열 빈도로 센다", () => {
  const result = summarize(
    "csv",
    Buffer.from("A\n=1+1\n<img src=x>\n__proto__\nconstructor\n"),
    null,
    { ...pick, columns: [0] },
  );
  assert.equal(result.columns[0]!.formulaCount, 0);
  assert.equal(result.columns[0]!.distinctCount, 4);
  countInvariant(result);
});
test("없는 열·잘못된 선택·파일 처리 한도는 부분 결과 대신 거부한다", () => {
  for (const selection of [
    { ...pick, columns: [] },
    { ...pick, columns: [0, 0] },
    { ...pick, columns: [9] },
    { ...pick, sheetId: "missing" },
  ])
    assert.throws(() => summarize("csv", bytes, null, selection), PreviewError);
  assert.throws(
    () =>
      summarize("csv", Buffer.from("A\n" + "1\n".repeat(20001)), null, {
        ...pick,
        columns: [0],
      }),
    PreviewError,
  );
});
async function setup() {
  const f = await fixture();
  const account = await f.account();
  const { job } = await (
    await f.post(
      {
        kind: "survey",
        title: "합성 기초 집계",
        instructions: "합성 값만 집계합니다.",
      },
      account.cookie,
    )
  ).json();
  const { attachment } = await (
    await f.upload(job.id, "합성.csv", bytes, account.cookie)
  ).json();
  const base = `/api/jobs/${job.id}/attachments/${attachment.id}`;
  return { f, account, job, attachment, base };
}
test("API는 저장한 선택 버전·원본으로 재현 가능한 집계만 반환하고 원본/설정을 보존한다", async () => {
  const { f, account, job, attachment, base } = await setup();
  try {
    await f.put(base + "/selection", { ...pick, revision: 0 }, account.cookie);
    const run = () =>
      f.postJson(base + "/summary", { revision: 1 }, account.cookie);
    const response = await run();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const { summary } = await response.json();
    assert.equal(summary.includedRows, 4);
    assert.equal(summary.sourceHash, attachment.sha256);
    assert.equal(summary.revision, 1);
    await f.restart();
    const restored = (await (await run()).json()).summary;
    assert.equal(restored.includedRows, summary.includedRows);
    assert.deepEqual(restored.columns, summary.columns);
    assert.deepEqual(
      readFileSync(
        join(dirname(f.filename), "attachments", job.id, attachment.id),
      ),
      bytes,
    );
    const preview = await (
      await f.get(base + "/preview", account.cookie)
    ).json();
    assert.equal(preview.selection.revision, 1);
    assert.equal(
      (await (await f.get(`/api/jobs/${job.id}/events`, account.cookie)).json())
        .events.length,
      1,
    );
  } finally {
    await f.cleanup();
  }
});
test("집계 API 로그인·소유권·CSRF·계정 전환을 검사한다", async () => {
  const { f, account, base } = await setup();
  try {
    await f.put(base + "/selection", { ...pick, revision: 0 }, account.cookie);
    const other = await f.account();
    assert.equal(
      (await f.postJson(base + "/summary", { revision: 1 }, "")).status,
      401,
    );
    assert.equal(
      (await f.postJson(base + "/summary", { revision: 1 }, other.cookie))
        .status,
      404,
    );
    for (const extra of [
      { Origin: "https://external.invalid" },
      { "X-Office-Request": "" },
      { "Content-Type": "text/plain" },
    ])
      assert.equal(
        (
          await f.postJson(
            base + "/summary",
            { revision: 1 },
            account.cookie,
            extra,
          )
        ).status,
        403,
      );
    assert.equal(
      (
        await f.postJson(base + "/summary", { revision: 1 }, account.cookie, {
          "X-Office-Account": other.user.id,
        })
      ).status,
      401,
    );
  } finally {
    await f.cleanup();
  }
});
test("선택 미저장·오래된 버전·변조 원본과 임의 열 지정 요청을 거부한다", async () => {
  const { f, account, base, job, attachment } = await setup();
  try {
    assert.equal(
      (await f.postJson(base + "/summary", { revision: 1 }, account.cookie))
        .status,
      409,
    );
    await f.put(base + "/selection", { ...pick, revision: 0 }, account.cookie);
    for (const body of [
      null,
      [],
      { revision: 0 },
      { revision: 1, columns: [0] },
      { revision: "1" },
    ])
      assert.equal(
        (await f.postJson(base + "/summary", body, account.cookie)).status,
        400,
      );
    await f.put(
      base + "/selection",
      { ...pick, columns: [1], revision: 1 },
      account.cookie,
    );
    assert.equal(
      (await f.postJson(base + "/summary", { revision: 1 }, account.cookie))
        .status,
      409,
    );
    writeFileSync(
      join(dirname(f.filename), "attachments", job.id, attachment.id),
      "tampered",
    );
    assert.equal(
      (await f.postJson(base + "/summary", { revision: 2 }, account.cookie))
        .status,
      409,
    );
  } finally {
    await f.cleanup();
  }
});
