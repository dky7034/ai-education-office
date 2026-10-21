import { expect, test } from "@playwright/test";
import { registerViaApi, login, accountPanel, signUp } from "./accountHelpers";

test("업무 요청 저장·선택·이벤트 이력·새로고침·다른 브라우저 복원·계정별 분리", async ({
  page,
  browser,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const account = await registerViaApi(page);
  await page.goto("/");
  const workspace = page.getByRole("region", { name: "업무 요청·저장 이력" });
  const submit = workspace.getByRole("button", {
    name: "업무 요청 저장",
    exact: true,
  });
  await expect(submit).toBeEnabled();
  await workspace
    .getByLabel("업무 종류", { exact: true })
    .selectOption("excel");
  await workspace.getByLabel(/업무 제목/).fill("가상 출결 데이터 확인 요청");
  await workspace
    .getByLabel(/요청 내용/)
    .fill(
      "합성 데이터의 누락 항목을 확인해 주세요. 실제 파일 처리는 아직 요청하지 않습니다.",
    );
  await submit.click();
  const detail = page.getByRole("region", { name: "선택한 업무 상세" });
  await expect(
    detail.getByRole("heading", { name: "가상 출결 데이터 확인 요청" }),
  ).toBeVisible();
  await expect(detail).toContainText("접수됨 · 자동 실행 미연결");
  await expect(detail).toContainText("데이터 분석가");
  await expect(detail).toContainText("업무 요청이 저장되었습니다.");
  await expect(page.locator(".phase-announcement")).toHaveText(
    "업무 선택 대기",
  );
  await expect(workspace.locator(".saved-job-list li")).toHaveCount(1);
  const selectedUrl = page.url();
  await page.reload();
  await expect(detail).toContainText("합성 데이터의 누락 항목");
  expect(page.url()).toBe(selectedUrl);
  const another = await browser.newContext();
  try {
    const otherPage = await another.newPage();
    await otherPage.goto(selectedUrl);
    await expect(
      accountPanel(otherPage).getByRole("button", {
        name: "로그인하기",
        exact: true,
      }),
    ).toBeVisible();
    await login(otherPage, account.username, account.password);
    await expect(otherPage.locator(".saved-job-detail")).toContainText(
      "합성 데이터의 누락 항목",
    );
    await accountPanel(otherPage)
      .getByRole("button", { name: "로그아웃", exact: true })
      .click();
    await signUp(otherPage);
    await otherPage.goto(selectedUrl);
    await expect(otherPage.locator(".request-history")).toContainText(
      "아직 저장한 업무가 없습니다.",
    );
    await expect(
      otherPage.getByRole("region", { name: "선택한 업무 상세" }),
    ).toContainText("업무를 찾을 수 없거나");
  } finally {
    await another.close();
  }
  expect(errors).toEqual([]);
});

test("연결 실패와 저장 응답 유실을 알리고 재시도 시 중복 저장하지 않는다", async ({
  page,
}) => {
  let offline = true;
  await page.route("**/api/jobs", async (route) => {
    if (offline && route.request().method() === "GET") await route.abort();
    else await route.continue();
  });
  const account = await registerViaApi(page);
  await page.goto("/");
  const workspace = page.getByRole("region", { name: "업무 요청·저장 이력" });
  await expect(workspace.getByRole("alert")).toBeVisible();
  await expect(
    workspace.getByRole("button", { name: "업무 요청 저장", exact: true }),
  ).toBeDisabled();
  offline = false;
  await workspace
    .getByRole("button", { name: "다시 연결", exact: true })
    .click();
  const submit = workspace.getByRole("button", {
    name: "업무 요청 저장",
    exact: true,
  });
  await expect(submit).toBeEnabled();
  await workspace.getByLabel(/업무 제목/).fill("응답 유실 재시도 검증");
  await workspace
    .getByLabel(/요청 내용/)
    .fill("네트워크 응답이 유실되어도 한 번만 저장되어야 합니다.");
  let loseResponse = true;
  await page.route("**/api/jobs", async (route) => {
    if (route.request().method() === "POST" && loseResponse) {
      loseResponse = false;
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      await route.abort();
    } else await route.fallback();
  });
  await submit.click();
  await expect(workspace.getByRole("alert")).toBeVisible();
  await expect(workspace.getByLabel(/업무 제목/)).toHaveValue(
    "응답 유실 재시도 검증",
  );
  await submit.click();
  await expect(
    page.getByRole("region", { name: "선택한 업무 상세" }),
  ).toContainText("응답 유실 재시도 검증");
  await expect(workspace.locator(".saved-job-list li")).toHaveCount(1);
  await expect(workspace.locator(".saved-events li")).toHaveCount(1);
});
