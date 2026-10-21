import { expect, test } from "@playwright/test";

test("한국어 화면과 6명 직원, 캔버스 클릭, 전체 시연 흐름", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /교육운영 오피스/ }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "ko");
  await expect(
    page.getByText("시뮬레이션 모드", { exact: true }),
  ).toBeVisible();
  const roster = page.getByLabel("직원 선택");
  await expect(roster.getByRole("button")).toHaveCount(6);
  const canvas = page.locator("canvas");
  await expect(canvas).toBeVisible();
  // Click the third character at its initial map coordinates; proves Phaser input bridges to React.
  const box = (await canvas.boundingBox())!;
  await canvas.click({
    position: { x: (box.width * 832) / 960, y: (box.height * 213) / 664 },
  });
  await expect(page.locator(".person-intro h3")).toHaveText("교육생 관리 담당");
  await roster.getByRole("button", { name: /콘텐츠 디자이너/ }).click();
  await expect(page.locator(".person-data")).toContainText("PPT 구성");
  await page
    .locator(".task-grid")
    .getByRole("button", { name: /공지·메일 작성/ })
    .click();
  await expect(page.locator(".person-intro h3")).toHaveText("문서 전문가");
  await expect(page.locator(".phase-announcement")).toContainText(
    "작업 구역 이동",
  );
  // The writer started beside the desk (x=232,y=528). Select someone else, then
  // click the writer at the desk (y=497) to prove the scene moved the actor.
  await roster.getByRole("button", { name: /운영팀장/ }).click();
  await page.waitForTimeout(900);
  await canvas.click({
    position: { x: (box.width * 168) / 960, y: (box.height * 480) / 664 },
  });
  await expect(page.locator(".person-intro h3")).toHaveText("문서 전문가");
  await expect(page.locator(".task-grid button:disabled")).toHaveCount(6);
  await expect(page.locator(".phase-announcement")).toContainText("시연 완료", {
    timeout: 19000,
  });
  await expect(page.locator(".person-data")).toContainText(
    "공지·메일 작성 · 시연 완료",
  );
  await expect(page.locator(".logs")).toContainText(
    "실제 결과물 생성·사용자 승인·외부 발송은 수행하지 않았습니다",
  );
  await expect(page.locator(".task-grid button:disabled")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("6가지 버튼 배정, 오류 상황, 초기화, 새로고침", async ({ page }) => {
  await page.goto("/");
  const tasks = [
    ["강의 설문 분석", "데이터 분석가"],
    ["공지·메일 작성", "문서 전문가"],
    ["교육생 모니터링", "교육생 관리 담당"],
    ["엑셀 관리", "데이터 분석가"],
    ["PPT 제작", "콘텐츠 디자이너"],
    ["교육 일정 관리", "일정·소통 담당"],
  ];
  for (const [title, employee] of tasks) {
    await page
      .locator(".task-grid")
      .getByRole("button", { name: new RegExp(title) })
      .click();
    await expect(page.locator(".person-intro h3")).toHaveText(employee);
    await expect(page.locator(".current-task h3")).toHaveText(title);
    await page
      .getByRole("button", { name: "시연 초기화", exact: true })
      .click();
  }
  await page
    .locator(".task-grid")
    .getByRole("button", { name: /강의 설문 분석/ })
    .click();
  await page
    .getByRole("button", { name: "시연 설정 열기", exact: true })
    .click();
  await page.getByRole("button", { name: "오류 시연", exact: true }).click();
  await expect(page.locator(".phase-announcement")).toContainText("오류 시연");
  await expect(page.locator(".person-status")).toContainText("오류 발생");
  await page.getByRole("button", { name: "시연 초기화", exact: true }).click();
  await expect(page.locator(".phase-announcement")).toContainText(
    "업무 선택 대기",
  );
  await page.waitForTimeout(700);
  await expect(page.locator(".log-line")).toHaveCount(1);
  await page.reload();
  await expect(page.locator(".log-line")).toHaveCount(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("사용 안내 대화상자와 동작 줄이기 설정에서도 시연 가능", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByRole("button", { name: "사용 안내" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("Phase 3 업무 관리");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page
    .getByLabel("직원 선택")
    .getByRole("button", { name: /일정·소통 담당/ })
    .focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".person-intro h3")).toHaveText("일정·소통 담당");
  await page
    .locator(".task-grid")
    .getByRole("button", { name: /교육 일정 관리/ })
    .click();
  await expect(page.locator(".phase-announcement")).toContainText(
    "작업 구역 이동",
  );
});
