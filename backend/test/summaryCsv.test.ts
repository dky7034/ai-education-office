import { test } from "node:test";
import assert from "node:assert/strict";
import { csvRows } from "../src/csv.ts";
import { summarize } from "../src/summary.ts";
import { summaryCsv } from "../src/summaryCsv.ts";
import { PreviewError } from "../src/tabular.ts";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { xlsxFixture } from "./xlsxFixture.ts";
import { fixture } from "./fixture.ts";
const meta = {
  jobId: "synthetic-job",
  fileId: "synthetic-file",
  filename: "=source.csv",
  sourceHash: "0".repeat(64),
  revision: 1,
  calculatedAt: "2026-10-21T00:00:00.000Z",
};
const selection = { sheetId: "csv", headerRow: 1, columns: [0] };
const full = (bytes: Buffer) =>
  summarize("csv", bytes, null, selection, {
    fullValues: true,
    frequencyLimit: Infinity,
  });
test("CSV는 BOM·CRLF·쉼표/인용/줄바꿈과 전체 긴 값·30개 초과 빈도를 보존한다", () => {
  const long = "가".repeat(230);
  const values = [
    "comma,value",
    'say "yes"',
    "line\nbreak",
    long,
    ...Array.from({ length: 40 }, (_, i) => "합성-" + i),
  ];
  const input = Buffer.from(
    "제목\r\n" +
      values.map((v) => '"' + v.replaceAll('"', '""') + '"').join("\r\n"),
  );
  const csv = summaryCsv(full(input), meta);
  assert.deepEqual([...csv.subarray(0, 3)], [239, 187, 191]);
  const rows = [...csvRows(csv)],
    frequencies = rows.filter((r) => r[0] === "값별 빈도");
  assert.equal(frequencies.length, 44);
  for (const value of values)
    assert.ok(frequencies.some((r) => r[4] === "'" + value && r[5] === "1"));
  assert.ok(
    rows.some((r) => r[3] === "원본 SHA-256" && r[4] === "'" + meta.sourceHash),
  );
  assert.ok(rows.every((r) => r.length === 8));
});
test("스프레드시트 수식·공백·탭·따옴표 모양의 모든 원본 텍스트를 보호한다", () => {
  const values = [
    "=1+1",
    "+SUM(1)",
    "-2",
    "@SUM(1)",
    " \t=1+1",
    "\t=1+1",
    "'이미텍스트",
    "정상",
  ];
  const bytes = Buffer.from(
    "=제목\n" +
      values.map((v) => '"' + v.replaceAll('"', '""') + '"').join("\n"),
  );
  const rows = [...csvRows(summaryCsv(full(bytes), meta))];
  for (const row of rows.filter((r) => r[0] === "값별 빈도")) {
    assert.ok(row[2]!.startsWith("'"));
    assert.ok(row[4]!.startsWith("'"));
    assert.equal(row[5], row[4] === "'=1+1" ? "3" : "1");
  }
  assert.ok(
    rows.some((r) => r[3] === "원본 파일명" && r[4] === "'=source.csv"),
  );
});
test("잘린 집계·출력 크기 초과는 부분 CSV 대신 거부한다", () => {
  const bytes = Buffer.from("A\n" + "합성\n".repeat(3));
  assert.throws(() => summaryCsv(full(bytes), meta, 20), PreviewError);
  const many = Buffer.from(
    "A\n" + Array.from({ length: 31 }, (_, i) => String(i)).join("\n"),
  );
  assert.throws(
    () => summaryCsv(summarize("csv", many, null, selection), meta),
    PreviewError,
  );
});
test("CSV API는 소유권·CSRF·원본·버전을 검사하고 메타데이터·전체 빈도를 반환한다", async () => {
  const f = await fixture();
  try {
    const a = await f.account(),
      b = await f.account();
    const { job } = await (
      await f.post(
        {
          kind: "survey",
          title: "합성 CSV 내보내기",
          instructions: "가상 값만 내보냅니다.",
        },
        a.cookie,
      )
    ).json();
    const { attachment } = await (
      await f.upload(job.id, "가상.csv", Buffer.from("A\n1\n1\n2\n"), a.cookie)
    ).json();
    const base = `/api/jobs/${job.id}/attachments/${attachment.id}`;
    await f.put(base + "/selection", { ...selection, revision: 0 }, a.cookie);
    const run = (
      cookie: string,
      body: unknown = { revision: 1 },
      extra: Record<string, string> = {},
    ) => f.postJson(base + "/summary.csv", body, cookie, extra);
    assert.equal((await run("")).status, 401);
    assert.equal((await run(b.cookie)).status, 404);
    assert.equal((await run(a.cookie, { revision: 0 })).status, 400);
    assert.equal(
      (await run(a.cookie, { revision: 1, columns: [0] })).status,
      400,
    );
    assert.equal(
      (
        await run(
          a.cookie,
          { revision: 1 },
          { Origin: "https://external.invalid" },
        )
      ).status,
      403,
    );
    const result = await run(a.cookie);
    assert.equal(result.status, 200);
    assert.match(result.headers.get("content-type")!, /^text\/csv/);
    assert.match(result.headers.get("content-disposition")!, /^attachment;/);
    assert.equal(result.headers.get("cache-control"), "no-store");
    assert.equal(result.headers.get("x-content-type-options"), "nosniff");
    const rows = [...csvRows(Buffer.from(await result.arrayBuffer()))];
    assert.ok(
      rows.some((r) => r[0] === "값별 빈도" && r[4] === "'1" && r[5] === "2"),
    );
    const xlsxUpload = await f.upload(
      job.id,
      "합성.xlsx",
      await xlsxFixture(),
      a.cookie,
      "export-xlsx-fixture",
    );
    assert.equal(xlsxUpload.status, 201);
    const xfile = (await xlsxUpload.json()).attachment;
    const xbase = `/api/jobs/${job.id}/attachments/${xfile.id}`;
    const xselection = await f.put(
      xbase + "/selection",
      { sheetId: "0", headerRow: 1, columns: [0, 1, 2], revision: 0 },
      a.cookie,
    );
    assert.equal(xselection.status, 200);
    const xexport = await f.postJson(
      xbase + "/summary.csv",
      { revision: 1 },
      a.cookie,
    );
    assert.equal(xexport.status, 200);
    const xrows = [...csvRows(Buffer.from(await xexport.arrayBuffer()))];
    assert.ok(
      xrows.some(
        (row) =>
          row[0] === "열 요약" &&
          row[1] === "B" &&
          row[3] === "수식 제외" &&
          row[5] === "1",
      ),
    );
    assert.ok(
      xrows.some(
        (row) =>
          row[0] === "열 요약" &&
          row[1] === "C" &&
          row[3] === "오류 제외" &&
          row[5] === "1",
      ),
    );
    assert.ok(
      xrows.some(
        (row) =>
          row[0] === "값별 빈도" && row[1] === "C" && row[4] === "'가상 의견",
      ),
    );
    const preview = await (await f.get(base + "/preview", a.cookie)).json();
    assert.equal(preview.selection.revision, 1);
    assert.equal(preview.selection.sourceHash, attachment.sha256);
    await f.put(base + "/selection", { ...selection, revision: 1 }, a.cookie);
    assert.equal((await run(a.cookie)).status, 409);
    writeFileSync(
      join(dirname(f.filename), "attachments", job.id, attachment.id),
      "tampered",
    );
    assert.equal((await run(a.cookie, { revision: 2 })).status, 409);
  } finally {
    await f.cleanup();
  }
});
