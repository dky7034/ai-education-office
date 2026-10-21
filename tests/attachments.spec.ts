import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { registerViaApi } from "./accountHelpers";
test("CSV 첨부·응답 유실 재시도·새로고침·원본 다운로드와 다른 계정 차단", async ({
  page,
  browser,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await registerViaApi(page);
  const created = await page.request.post("/api/jobs", {
    headers: {
      "X-Office-Request": "1",
      "Idempotency-Key": "attachment-browser-job",
    },
    data: {
      kind: "excel",
      title: "합성 파일 첨부 검증",
      instructions: "원본 보관만 확인합니다.",
    },
  });
  const { job } = await created.json();
  await page.goto(`/?job=${job.id}`);
  const panel = page.getByRole("region", { name: "업무 첨부 파일" });
  const picker = panel.getByLabel("첨부할 파일");
  await expect(picker).toBeEnabled();
  await picker.setInputFiles({
    name: "위장.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from("invalid archive"),
  });
  await panel.getByRole("button", { name: "파일 첨부", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("손상");
  const bytes = Buffer.from("\uFEFF항목,수\r\n가상과정,2\r\n");
  await picker.setInputFiles({
    name: "가상 원본.csv",
    mimeType: "text/csv",
    buffer: bytes,
  });
  let lose = true;
  await page.route(`**/api/jobs/${job.id}/attachments`, async (route) => {
    if (route.request().method() === "POST" && lose) {
      lose = false;
      expect((await route.fetch()).status()).toBe(201);
      await route.abort();
    } else await route.continue();
  });
  await panel.getByRole("button", { name: "파일 첨부", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("연결");
  await panel.getByRole("button", { name: "파일 첨부", exact: true }).click();
  await expect(
    panel.getByRole("status").filter({ hasText: "원본 파일을 보관" }),
  ).toBeVisible();
  await expect(panel.locator(".attachment-list li")).toHaveCount(1);
  await page.reload();
  await expect(panel.locator(".attachment-list li")).toHaveCount(1);
  const downloadEvent = page.waitForEvent("download");
  await panel
    .getByRole("button", { name: "가상 원본.csv 다운로드", exact: true })
    .click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe("가상 원본.csv");
  expect(await readFile((await download.path())!)).toEqual(bytes);
  const listing = await (
    await page.request.get(`/api/jobs/${job.id}/attachments`)
  ).json();
  const other = await browser.newContext();
  try {
    const otherPage = await other.newPage();
    await registerViaApi(otherPage);
    const base = new URL(page.url()).origin;
    expect(
      (
        await otherPage.request.get(`${base}/api/jobs/${job.id}/attachments`)
      ).status(),
    ).toBe(404);
    expect(
      (
        await otherPage.request.get(
          `${base}/api/jobs/${job.id}/attachments/${listing.attachments[0].id}`,
        )
      ).status(),
    ).toBe(404);
  } finally {
    await other.close();
  }
  expect(errors).toEqual([]);
});
