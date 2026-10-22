import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { summaryReport, REPORT_CSP } from "../src/summaryReport.ts";
import { summarize } from "../src/summary.ts";
import { PreviewError } from "../src/tabular.ts";
import { fixture } from "./fixture.ts";
const selection = { sheetId: "csv", headerRow: 1, columns: [0] };
const meta = {
  jobId: "synthetic",
  fileId: "synthetic",
  filename: "<img src=x onerror=alert(1)>.csv",
  sourceHash: "0".repeat(64),
  revision: 1,
  calculatedAt: "2026-10-22T00:00:00.000Z",
};
test("HTML 보고서는 원본 텍스트를 이스케이프하고 실제 비율·표시 한도·빈 결과를 처리한다", () => {
  const bytes = Buffer.from("제목\n<script>alert(1)</script>\n합성\n합성\n");
  const summary = summarize("csv", bytes, null, selection);
  const html = summaryReport(summary, meta).toString();
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;.csv"));
  assert.ok(!html.includes("<script"));
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("66.7%"));
  assert.ok(html.includes("width:66.66666666666666%"));
  assert.ok(html.includes("생성 시각(UTC)"));
  assert.throws(() => summaryReport(summary, meta, 10), PreviewError);
  const empty = summaryReport(
    summarize("csv", Buffer.from("A\n \n"), null, selection),
    meta,
  ).toString();
  assert.ok(!empty.includes("NaN"));
  assert.ok(!empty.includes("Infinity"));
  assert.ok(empty.includes("빈도를 표시할 일반 값이 없습니다."));
  const many = summarize(
    "csv",
    Buffer.from(
      "A\n" + Array.from({ length: 31 }, (_, i) => "합성" + i).join("\n"),
    ),
    null,
    selection,
  );
  const report = summaryReport(many, meta).toString();
  assert.equal((report.match(/<li><div class="label">/g) || []).length, 10);
  assert.equal((report.match(/<tr><td>/g) || []).length, 30);
  assert.ok(report.includes("나머지 1종: 총 1건"));
});
test("보고서 API는 계정·Origin·선택 버전·원본 검증과 안전한 다운로드 헤더를 적용한다", async () => {
  const f = await fixture();
  try {
    const a = await f.account(),
      b = await f.account();
    const { job } = await (
      await f.post(
        { kind: "survey", title: "합성 보고서", instructions: "가상 값 검증" },
        a.cookie,
      )
    ).json();
    const { attachment } = await (
      await f.upload(
        job.id,
        "합성.csv",
        Buffer.from("A\n온라인\n온라인\n오프라인\n"),
        a.cookie,
      )
    ).json();
    const base = `/api/jobs/${job.id}/attachments/${attachment.id}`;
    await f.put(base + "/selection", { ...selection, revision: 0 }, a.cookie);
    const run = (
      cookie: string,
      revision = 1,
      headers: Record<string, string> = {},
    ) => f.postJson(base + "/summary.html", { revision }, cookie, headers);
    assert.equal((await run("")).status, 401);
    assert.equal((await run(b.cookie)).status, 404);
    assert.equal((await run(a.cookie, 0)).status, 400);
    assert.equal(
      (await run(a.cookie, 1, { Origin: "https://external.invalid" })).status,
      403,
    );
    const result = await run(a.cookie);
    assert.equal(result.status, 200);
    assert.match(result.headers.get("content-type")!, /^text\/html/);
    assert.match(
      result.headers.get("content-disposition")!,
      /attachment; filename="office-summary-.*\.html"/,
    );
    assert.equal(result.headers.get("content-security-policy"), REPORT_CSP);
    assert.equal(result.headers.get("cache-control"), "no-store");
    assert.equal(result.headers.get("x-content-type-options"), "nosniff");
    const html = await result.text();
    assert.ok(html.includes(attachment.sha256));
    assert.ok(html.includes("온라인"));
    await f.put(base + "/selection", { ...selection, revision: 1 }, a.cookie);
    assert.equal((await run(a.cookie)).status, 409);
    writeFileSync(
      join(dirname(f.filename), "attachments", job.id, attachment.id),
      "tampered",
    );
    assert.equal((await run(a.cookie, 2)).status, 409);
  } finally {
    await f.cleanup();
  }
});
