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

test("업무 목록의 최근 집계·검토 현황과 결과 링크·새로고침·의견 보존·계정 격리", async ({
  page,
  browser,
}) => {
  await registerViaApi(page);
  const title = "합성 집계 현황 검증";
  const { job } = await (
    await page.request.post("/api/jobs", {
      headers: {
        "X-Office-Request": "1",
        "Idempotency-Key": crypto.randomUUID(),
      },
      data: { kind: "survey", title, instructions: "가상 결과 검토" },
    })
  ).json();
  const { attachment } = await (
    await page.request.post(`/api/jobs/${job.id}/attachments`, {
      headers: {
        "X-Office-Request": "1",
        "Content-Type": "application/octet-stream",
        "X-File-Name": encodeURIComponent("합성 현황.csv"),
        "Idempotency-Key": crypto.randomUUID(),
      },
      data: Buffer.from("A\n1\n3\n"),
    })
  ).json();
  const base = `/api/jobs/${job.id}/attachments/${attachment.id}`;
  expect(
    (
      await page.request.put(base + "/selection", {
        headers: { "X-Office-Request": "1" },
        data: {
          sheetId: "csv",
          headerRow: 1,
          columns: [0],
          questions: [],
          revision: 0,
        },
      })
    ).status(),
  ).toBe(200);
  const { run } = await (
    await page.request.post(base + "/runs", {
      headers: {
        "X-Office-Request": "1",
        "Idempotency-Key": crypto.randomUUID(),
      },
      data: { revision: 1 },
    })
  ).json();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(base + "/runs/" + run.id)).json()).run
          .status,
    )
    .toBe("completed");
  await page.goto("/");
  const row = page.locator(`.saved-job-list > li[data-job-id="${job.id}"]`);
  await expect(row).toContainText("완료 1건");
  await expect(row).toContainText("검토 대기 1건");
  await expect(row).toContainText("승인 기록 0건");
  await row
    .getByRole("button", { name: title + " 최근 집계·검토 보기", exact: true })
    .click();
  const linked = page.getByRole("region", {
    name: "선택한 집계·검토 상세",
    exact: true,
  });
  const stored = linked.getByRole("region", {
    name: "저장된 백그라운드 집계 결과",
    exact: true,
  });
  await expect(stored.locator(".stored-row-counts dd")).toHaveText([
    "2행",
    "2행",
    "0행",
  ]);
  await expect(page).toHaveURL(
    new RegExp(`job=${job.id}.*file=${attachment.id}.*run=${run.id}`),
  );
  const review = linked.getByRole("region", {
      name: "결과물 검토",
      exact: true,
    }),
    comment = review.getByLabel("검토 의견 (선택)", { exact: true });
  await comment.fill("저장 전 합성 검토 의견");
  const refresh = page.getByRole("button", {
    name: "집계·검토 상태 새로고침",
    exact: true,
  });
  await refresh.click();
  await expect(refresh).toBeEnabled();
  await expect(comment).toHaveValue("저장 전 합성 검토 의견");
  let offline = true;
  await page.route("**/api/jobs", async (route) => {
    if (offline && route.request().method() === "GET") await route.abort();
    else await route.continue();
  });
  await refresh.click();
  await expect(page.locator(".request-history > .request-error")).toContainText(
    "연결",
  );
  await expect(comment).toHaveValue("저장 전 합성 검토 의견");
  offline = false;
  await refresh.click();
  await expect(refresh).toBeEnabled();
  await expect(comment).toHaveValue("저장 전 합성 검토 의견");
  await review
    .getByLabel("이 실행 결과와 보관 파일을 확인했습니다", { exact: true })
    .check();
  await review.getByRole("button", { name: "승인 확정", exact: true }).click();
  await expect(review.locator(".review-decision strong")).toHaveText(
    "승인 확정",
  );
  await expect(row).toContainText("승인 기록 1건");
  await expect(row).toContainText("검토 대기 0건");
  const url = page.url();
  await page.reload();
  await expect(linked.locator(".review-decision strong")).toHaveText(
    "승인 확정",
  );
  const { run: next } = await (
    await page.request.post(base + "/runs", {
      headers: {
        "X-Office-Request": "1",
        "Idempotency-Key": crypto.randomUUID(),
      },
      data: { revision: 1 },
    })
  ).json();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(base + "/runs/" + next.id)).json()).run
          .status,
    )
    .toBe("completed");
  await refresh.click();
  await expect(row).toContainText("검토 대기 1건");
  await expect(row).toContainText("승인 기록 0건");
  // Historical deep link keeps the previously approved run visible while the list shows the new run.
  await expect(linked.locator(".review-decision strong")).toHaveText(
    "승인 확정",
  );
  const { rm } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const directory = process.env.OFFICE_E2E_DB?.endsWith("e2e-dev.sqlite")
    ? "e2e-dev"
    : "e2e";
  await rm(resolve("storage/input", directory, job.id, attachment.id));
  await page.reload();
  await expect(linked.locator(".review-decision strong")).toHaveText(
    "승인 확정",
  );
  await expect(stored.locator(".stored-row-counts dd")).toHaveText([
    "2행",
    "2행",
    "0행",
  ]);
  const context = await browser.newContext();
  try {
    const other = await context.newPage();
    await registerViaApi(other);
    await other.goto(url);
    await expect(other.locator(".request-history")).toContainText(
      "아직 저장한 업무가 없습니다.",
    );
    await expect(
      other.getByRole("region", { name: "선택한 업무 상세" }),
    ).toContainText("업무를 찾을 수 없거나");
    await expect(other.locator(".stored-summary")).toHaveCount(0);
  } finally {
    await context.close();
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
