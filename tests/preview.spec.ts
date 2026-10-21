import { expect, test, type Page } from "@playwright/test";
import { registerViaApi } from "./accountHelpers";
import { xlsxFixture } from "../backend/test/xlsxFixture";
async function attach(page: Page, name: string, bytes: Buffer) {
  await registerViaApi(page);
  const r = await page.request.post("/api/jobs", {
    headers: {
      "X-Office-Request": "1",
      "Idempotency-Key": "preview-browser-job",
    },
    data: {
      kind: "survey",
      title: "합성 파일 미리보기 검증",
      instructions: "분석할 열만 선택합니다.",
    },
  });
  const { job } = await r.json();
  const uploaded = await page.request.post(`/api/jobs/${job.id}/attachments`, {
    headers: {
      "X-Office-Request": "1",
      "Content-Type": "application/octet-stream",
      "X-File-Name": encodeURIComponent(name),
      "Idempotency-Key": "preview-browser-file",
    },
    data: bytes,
  });
  expect(uploaded.status()).toBe(201);
  const { attachment } = await uploaded.json();
  await page.goto(`/?job=${job.id}`);
  await page
    .getByRole("button", { name: name + " 미리보기", exact: true })
    .click();
  return {
    job,
    attachment,
    panel: page.getByRole("region", { name: "파일 내용 미리보기·열 선택" }),
  };
}
test("CSV 제목 행·중복/빈 제목·열 선택·저장 실패 재시도·새로고침·충돌 복원", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const bytes = Buffer.from(
    "가상 안내\n만족도,만족도,,의견\n5,4,,<img src=x onerror=alert(1)>\n" +
      "1,2,,가상 의견\n".repeat(24),
  );
  const { job, attachment, panel } = await attach(page, "합성 설문.csv", bytes);
  await expect(panel.getByLabel("제목 행", { exact: true })).toBeVisible();
  await panel.getByLabel("제목 행", { exact: true }).selectOption("2");
  await expect(
    panel.getByRole("columnheader", { name: "A · 만족도", exact: true }),
  ).toBeVisible();
  await expect(panel.locator("tbody tr")).toHaveCount(20);
  await expect(
    panel.getByRole("cell", {
      name: "<img src=x onerror=alert(1)>",
      exact: true,
    }),
  ).toBeVisible();
  await expect(panel.locator("img")).toHaveCount(0);
  const save = panel.getByRole("button", { name: "열 선택 저장", exact: true });
  await expect(save).toBeDisabled();
  await panel
    .getByRole("checkbox", { name: "A · 만족도", exact: true })
    .check();
  await panel.getByRole("checkbox", { name: "D · 의견", exact: true }).check();
  let fail = true;
  await page.route(
    `**/api/jobs/${job.id}/attachments/${attachment.id}/selection`,
    async (route) => {
      if (fail) {
        fail = false;
        await route.abort();
      } else await route.continue();
    },
  );
  await save.click();
  await expect(panel.getByRole("alert")).toContainText("연결");
  await expect(
    panel.getByRole("checkbox", { name: "A · 만족도", exact: true }),
  ).toBeChecked();
  await save.click();
  await expect(panel.getByRole("status")).toContainText("열 선택을 저장");
  await page.reload();
  await page
    .getByRole("button", { name: "합성 설문.csv 미리보기", exact: true })
    .click();
  await expect(panel.getByLabel("제목 행", { exact: true })).toHaveValue("2");
  await expect(
    panel.getByRole("checkbox", { name: "D · 의견", exact: true }),
  ).toBeChecked();
  const second = await page.context().newPage();
  try {
    await second.goto(page.url());
    await second
      .getByRole("button", { name: "합성 설문.csv 미리보기", exact: true })
      .click();
    const other = second.getByRole("region", {
      name: "파일 내용 미리보기·열 선택",
    });
    await expect(
      other.getByRole("checkbox", { name: "A · 만족도", exact: true }),
    ).toBeChecked();
    await panel
      .getByRole("checkbox", { name: "B · 만족도", exact: true })
      .check();
    await save.click();
    await expect(panel.getByRole("status")).toContainText("열 선택을 저장");
    await other
      .getByRole("checkbox", { name: "C · 제목 없음", exact: true })
      .check();
    await other
      .getByRole("button", { name: "열 선택 저장", exact: true })
      .click();
    await expect(other.getByRole("alert")).toContainText("다른 화면");
    await other
      .getByRole("button", { name: "저장 상태 다시 불러오기", exact: true })
      .click();
    await expect(
      other.getByRole("checkbox", { name: "B · 만족도", exact: true }),
    ).toBeChecked();
    await expect(
      other.getByRole("checkbox", { name: "C · 제목 없음", exact: true }),
    ).not.toBeChecked();
  } finally {
    await second.close();
  }
  expect(errors).toEqual([]);
});
test("XLSX 시트 전환·문자열·수식 비실행·선택 저장 복원", async ({ page }) => {
  const { panel } = await attach(
    page,
    "합성 통합문서.xlsx",
    await xlsxFixture(),
  );
  await expect(
    panel.getByRole("cell", { name: "[수식: 계산하지 않음]", exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("cell", { name: "가상 의견", exact: true }),
  ).toBeVisible();
  await panel.getByLabel("시트", { exact: true }).selectOption("1");
  await expect(
    panel.getByRole("cell", { name: "다른 합성 자료", exact: true }),
  ).toBeVisible();
  await panel.getByRole("checkbox", { name: "A · 제목", exact: true }).check();
  await panel
    .getByRole("button", { name: "열 선택 저장", exact: true })
    .click();
  await expect(panel.getByRole("status")).toContainText("열 선택을 저장");
  await page.reload();
  await page
    .getByRole("button", { name: "합성 통합문서.xlsx 미리보기", exact: true })
    .click();
  await expect(panel.getByLabel("시트", { exact: true })).toHaveValue("1");
  await expect(
    panel.getByRole("checkbox", { name: "A · 제목", exact: true }),
  ).toBeChecked();
});
