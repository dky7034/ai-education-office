import { test } from "node:test";
import assert from "node:assert/strict";
import { numericAccumulator } from "../src/numericSummary.ts";
import { summarize } from "../src/summary.ts";
import { readXlsx } from "../src/attachments.ts";
import { xlsxFixture } from "./xlsxFixture.ts";
import { fixture } from "./fixture.ts";
import { csvRows } from "../src/csv.ts";
const calculate = (values: string[]) => {
  const accumulator = numericAccumulator();
  for (const value of values) accumulator.add(value);
  return accumulator.result();
};
test("십진 소수·큰 정수·상쇄 합계는 이진 부동소수점 손실 없이 계산한다", () => {
  assert.deepEqual(calculate(["0.1", "0.2"]), {
    count: 2,
    nonNumericCount: 0,
    outOfRangeCount: 0,
    sum: "0.3",
    mean: "0.15",
    min: "0.1",
    max: "0.2",
  });
  assert.equal(calculate(["9007199254740993", "1"]).sum, "9007199254740994");
  assert.equal(calculate(["1e99", "0.1", "-1e99"]).sum, "0.1");
  assert.equal(calculate(["9".repeat(100), "1"]).sum, "1" + "0".repeat(100));
  assert.equal(calculate(Array(1000).fill("0.1")).sum, "100");
});
test("부호·소수·지수 표기를 정규화하며 비숫자와 지원 범위 초과를 구분한다", () => {
  const accepted = calculate([
    "+01",
    "-.5",
    "1.",
    "1e2",
    "-2E-1",
    "-0",
    "0e9999999",
  ]);
  assert.equal(accepted.count, 7);
  assert.equal(accepted.sum, "101.3");
  assert.equal(accepted.min, "-0.5");
  assert.equal(accepted.max, "100");
  const invalid = [
    "",
    "NaN",
    "Infinity",
    "0x10",
    "1,000",
    "10%",
    "₩100",
    "2026-10-22",
    "TRUE",
    "=1+1",
    "1 2",
    "１２",
    "1e",
    "--1",
    "<script>",
  ];
  const result = calculate([
    ...invalid,
    "1e100",
    "1e-101",
    "9".repeat(101),
    "1e99999999999999999999",
  ]);
  assert.equal(result.nonNumericCount, invalid.length);
  assert.equal(result.outOfRangeCount, 4);
  assert.equal(result.count, 0);
  assert.equal(result.sum, null);
  assert.equal(result.mean, null);
  assert.equal(calculate(["1e-100"]).min, "0." + "0".repeat(99) + "1");
  assert.equal(calculate(["0".repeat(1000) + "1"]).sum, "1");
});
test("평균은 소수점 6자리로 반올림하며 음수 동률·반복소수·0·빈 결과를 처리한다", () => {
  assert.equal(calculate(["1", "0", "0"]).mean, "0.333333");
  assert.equal(calculate(["2", "0", "0"]).mean, "0.666667");
  assert.equal(calculate(["0.000001", "0"]).mean, "0.000001");
  assert.equal(calculate(["-0.000001", "0"]).mean, "-0.000001");
  assert.equal(calculate(["-0.0000001"]).mean, "0");
  assert.equal(calculate(["0"]).sum, "0");
  assert.equal(calculate([]).min, null);
  assert.equal(calculate(["일반 문자"]).max, null);
});
test("전체 행의 숫자 부분집합을 집계하고 누락·수식·오류를 숫자 분모에서 제외한다", async () => {
  const csv = summarize(
    "csv",
    Buffer.from(
      "A,B\n0.1,x\n0.2,x\n합성,x\n1e100,x\n,x\n,\n" + "0.1,x\n".repeat(25),
    ),
    null,
    { sheetId: "csv", headerRow: 1, columns: [0, 1] },
  );
  assert.equal(csv.columns[0]!.numeric.count, 27);
  assert.equal(csv.columns[0]!.numeric.sum, "2.8");
  assert.equal(csv.columns[0]!.missingCount, 1);
  assert.equal(csv.columns[0]!.numeric.nonNumericCount, 1);
  assert.equal(csv.columns[0]!.numeric.outOfRangeCount, 1);
  for (const c of csv.columns)
    assert.equal(
      c.numeric.count + c.numeric.nonNumericCount + c.numeric.outOfRangeCount,
      c.valueCount,
    );
  const bytes = await xlsxFixture();
  const xlsx = summarize("xlsx", bytes, await readXlsx(bytes), {
    sheetId: "0",
    headerRow: 1,
    columns: [0, 1, 2],
  });
  assert.deepEqual(xlsx.columns[0]!.numeric, {
    count: 1,
    nonNumericCount: 1,
    outOfRangeCount: 0,
    sum: "5",
    mean: "5",
    min: "5",
    max: "5",
  });
  assert.equal(xlsx.columns[1]!.numeric.sum, "45292");
  assert.equal(xlsx.columns[1]!.numeric.count, 1);
  assert.equal(xlsx.columns[1]!.formulaCount, 1);
  assert.equal(xlsx.columns[2]!.numeric.count, 0);
  assert.equal(xlsx.columns[2]!.errorCount, 1);
});
test("API·CSV·HTML 숫자 결과는 동일하며 원본·선택 버전은 유지한다", async () => {
  const f = await fixture();
  try {
    const a = await f.account();
    const { job } = await (
      await f.post(
        {
          kind: "survey",
          title: "합성 숫자 집계",
          instructions: "십진수 확인",
        },
        a.cookie,
      )
    ).json();
    const { attachment } = await (
      await f.upload(
        job.id,
        "합성 숫자.csv",
        Buffer.from("A\n0.1\n0.2\n문자\n1e100\n"),
        a.cookie,
      )
    ).json();
    const base = `/api/jobs/${job.id}/attachments/${attachment.id}`;
    await f.put(
      base + "/selection",
      { sheetId: "csv", headerRow: 1, columns: [0], revision: 0 },
      a.cookie,
    );
    const run = (suffix: string) =>
      f.postJson(base + "/summary" + suffix, { revision: 1 }, a.cookie);
    const response = await run("");
    assert.equal(response.status, 200);
    const { summary } = await response.json();
    assert.deepEqual(summary.columns[0].numeric, {
      count: 2,
      nonNumericCount: 1,
      outOfRangeCount: 1,
      sum: "0.3",
      mean: "0.15",
      min: "0.1",
      max: "0.2",
    });
    const csv = await run(".csv");
    assert.equal(csv.status, 200);
    const rows = [...csvRows(Buffer.from(await csv.arrayBuffer()))];
    assert.ok(
      rows.some(
        (r) => r[0] === "숫자 집계" && r[3] === "합계" && r[4] === "'0.3",
      ),
    );
    assert.ok(
      rows.some(
        (r) => r[0] === "숫자 집계" && r[3] === "평균" && r[4] === "'0.15",
      ),
    );
    assert.ok(
      rows.some(
        (r) =>
          r[0] === "숫자 집계" && r[3] === "숫자 범위 초과" && r[5] === "1",
      ),
    );
    const html = await run(".html");
    assert.equal(html.status, 200);
    assert.match(
      await html.text(),
      /<dt>합계<\/dt><dd class="decimal">0.3<\/dd>/,
    );
    const preview = await (await f.get(base + "/preview", a.cookie)).json();
    assert.equal(preview.selection.revision, 1);
    assert.equal(preview.selection.sourceHash, attachment.sha256);
  } finally {
    await f.cleanup();
  }
});
