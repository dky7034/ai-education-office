import { readFile } from "node:fs/promises";
import { csvRows } from "../backend/src/csv";
import { expect, test, type Page } from "@playwright/test";
import { registerViaApi } from "./accountHelpers";
import { xlsxFixture } from "../backend/test/xlsxFixture";
async function attach(
  page: Page,
  name: string,
  bytes: Buffer,
  columns: number[],
) {
  await registerViaApi(page);
  const created = await page.request.post("/api/jobs", {
    headers: {
      "X-Office-Request": "1",
      "Idempotency-Key": "summary-browser-job",
    },
    data: {
      kind: "survey",
      title: "합성 기초 집계 검증",
      instructions: "선택 열의 빈도만 확인합니다.",
    },
  });
  const { job } = await created.json();
  const r = await page.request.post(`/api/jobs/${job.id}/attachments`, {
    headers: {
      "X-Office-Request": "1",
      "Content-Type": "application/octet-stream",
      "X-File-Name": encodeURIComponent(name),
      "Idempotency-Key": "summary-browser-file",
    },
    data: bytes,
  });
  expect(r.status()).toBe(201);
  const { attachment } = await r.json();
  const base = `/api/jobs/${job.id}/attachments/${attachment.id}`;
  const saved = await page.request.put(base + "/selection", {
    headers: { "X-Office-Request": "1" },
    data: {
      sheetId: name.endsWith(".csv") ? "csv" : "0",
      headerRow: 1,
      columns,
      revision: 0,
    },
  });
  expect(saved.status()).toBe(200);
  await page.goto(`/?job=${job.id}`);
  await page
    .getByRole("button", { name: name + " 미리보기", exact: true })
    .click();
  const panel = page.getByRole("region", { name: "선택 열 기초 집계" });
  await expect(
    panel.getByRole("button", { name: "전체 데이터 집계", exact: true }),
  ).toBeEnabled();
  return { panel, base };
}
test("CSV 전체 행 집계·네트워크 재시도·저장 버전 충돌·새로고침 재실행", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const bytes = Buffer.from(
    "A,B,C\n x ,1,\nx,01,\nX,,\n,,다른 열만\n , ,\n0,0,\n" +
      "x,1,\n".repeat(25),
  );
  const { panel, base } = await attach(page, "합성 집계.csv", bytes, [0, 1]);
  let fail = true;
  await page.route("**" + base + "/summary", async (route) => {
    if (fail) {
      fail = false;
      await route.abort();
    } else await route.continue();
  });
  const run = panel.getByRole("button", {
    name: "전체 데이터 집계",
    exact: true,
  });
  await run.click();
  await expect(panel.getByRole("alert")).toContainText("연결");
  await run.click();
  await expect(
    panel.locator(".summary-results > .summary-counts dd"),
  ).toHaveText(["31행", "29행", "2행"]);
  const a = panel.getByRole("region", { name: "A열 집계", exact: true });
  await expect(a.locator(".summary-counts dd")).toHaveText([
    "29개",
    "0개",
    "0개",
    "0개",
    "3개",
  ]);
  await expect(a.locator("tbody tr").first().getByRole("cell")).toHaveText([
    "x",
    "27",
  ]);
  await expect(
    panel
      .getByRole("region", { name: "B열 집계", exact: true })
      .locator(".summary-counts dd"),
  ).toHaveText(["28개", "1개", "0개", "0개", "3개"]);
  const saved = await page.request.put(base + "/selection", {
    headers: { "X-Office-Request": "1" },
    data: { sheetId: "csv", headerRow: 1, columns: [2], revision: 1 },
  });
  expect(saved.status()).toBe(200);
  await run.click();
  await expect(panel.getByRole("alert")).toContainText("다른 화면");
  await expect(panel.locator(".summary-results")).toHaveCount(0);
  await page
    .getByRole("button", { name: "저장 상태 다시 불러오기", exact: true })
    .click();
  await panel
    .getByRole("button", { name: "전체 데이터 집계", exact: true })
    .click();
  await expect(
    panel.locator(".summary-results > .summary-counts dd"),
  ).toHaveText(["31행", "1행", "30행"]);
  await page.reload();
  await page
    .getByRole("button", { name: "합성 집계.csv 미리보기", exact: true })
    .click();
  await expect(panel.locator(".summary-results")).toHaveCount(0);
  await panel
    .getByRole("button", { name: "전체 데이터 집계", exact: true })
    .click();
  await expect(
    panel.locator(".summary-results > .summary-counts dd"),
  ).toHaveText(["31행", "1행", "30행"]);
  await page.getByRole("checkbox", { name: "A · A", exact: true }).check();
  await expect(panel).toHaveCount(0);
  expect(errors).toEqual([]);
});
test("XLSX 빈 행·수식·오류 제외 건수와 값별 빈도 표시", async ({ page }) => {
  const { panel } = await attach(
    page,
    "합성 집계.xlsx",
    await xlsxFixture(),
    [0, 1, 2],
  );
  await panel
    .getByRole("button", { name: "전체 데이터 집계", exact: true })
    .click();
  await expect(
    panel.locator(".summary-results > .summary-counts dd"),
  ).toHaveText(["3행", "2행", "1행"]);
  await expect(
    panel
      .getByRole("region", { name: "B열 집계", exact: true })
      .locator(".summary-counts dd"),
  ).toHaveText(["1개", "0개", "1개", "0개", "1개"]);
  await expect(
    panel
      .getByRole("region", { name: "C열 집계", exact: true })
      .locator(".summary-counts dd"),
  ).toHaveText(["1개", "0개", "0개", "1개", "1개"]);
  await expect(
    panel.getByRole("cell", { name: "가상 의견", exact: true }),
  ).toBeVisible();
  await expect(panel).toContainText("선택 버전 1");
});

test("CSV 다운로드·연결 실패 재시도·전체 빈도·오래된 선택 차단", async ({
  page,
}) => {
  const { panel, base } = await attach(
    page,
    "합성 결과.csv",
    Buffer.from("A\n=1+1\n가상\n가상\n"),
    [0],
  );
  await panel
    .getByRole("button", { name: "전체 데이터 집계", exact: true })
    .click();
  const button = panel.getByRole("button", {
    name: "전체 빈도 CSV 다운로드",
    exact: true,
  });
  await expect(button).toBeEnabled();
  let fail = true;
  await page.route("**" + base + "/summary.csv", async (route) => {
    if (fail) {
      fail = false;
      await route.abort();
    } else await route.continue();
  });
  await button.click();
  await expect(panel.getByRole("alert")).toContainText("연결");
  const event = page.waitForEvent("download");
  await button.click();
  const download = await event;
  expect(download.suggestedFilename()).toMatch(/^office-summary-.*\.csv$/);
  const data = await readFile((await download.path())!);
  const rows = [...csvRows(data)];
  expect(
    rows.some((r) => r[0] === "값별 빈도" && r[4] === "'=1+1" && r[5] === "1"),
  ).toBeTruthy();
  expect(
    rows.some((r) => r[0] === "값별 빈도" && r[4] === "'가상" && r[5] === "2"),
  ).toBeTruthy();
  const saved = await page.request.put(base + "/selection", {
    headers: { "X-Office-Request": "1" },
    data: { sheetId: "csv", headerRow: 1, columns: [0], revision: 1 },
  });
  expect(saved.status()).toBe(200);
  await button.click();
  await expect(panel.getByRole("alert")).toContainText("다른 화면");
  await expect(panel.locator(".summary-results")).toHaveCount(0);
});
