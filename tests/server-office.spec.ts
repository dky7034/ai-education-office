import { expect, test } from "@playwright/test";
import { registerViaApi } from "./accountHelpers";
async function createJob(
  page: import("@playwright/test").Page,
  title = "합성 실제 오피스 업무",
) {
  const response = await page.request.post("/api/jobs", {
    headers: {
      "X-Office-Request": "1",
      "Idempotency-Key": crypto.randomUUID(),
    },
    data: { kind: "notice", title, instructions: "합성 데이터 정량 집계 확인" },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).job;
}
test("서버 집계 보기는 계정 전체·실제 완료·승인 기록을 읽기 전용으로 표시하고 로그아웃 시 지운다", async ({
  page,
}) => {
  await registerViaApi(page);
  const job = await createJob(page);
  for (let i = 0; i < 22; i++)
    await createJob(page, `합성 다른 보관 업무 ${i}`);
  const uploaded = await page.request.post(`/api/jobs/${job.id}/attachments`, {
    headers: {
      "X-Office-Request": "1",
      "Idempotency-Key": crypto.randomUUID(),
      "Content-Type": "application/octet-stream",
      "X-File-Name": encodeURIComponent("합성 오피스.csv"),
    },
    data: Buffer.from("A\n1\n3\n"),
  });
  expect(uploaded.status()).toBe(201);
  const file = (await uploaded.json()).attachment;
  const base = `/api/jobs/${job.id}/attachments/${file.id}`;
  expect(
    (
      await page.request.put(base + "/selection", {
        headers: { "X-Office-Request": "1" },
        data: { sheetId: "csv", headerRow: 1, columns: [0], revision: 0 },
      })
    ).status(),
  ).toBe(200);
  const enqueued = await page.request.post(base + "/runs", {
    headers: {
      "X-Office-Request": "1",
      "Idempotency-Key": crypto.randomUUID(),
    },
    data: { revision: 1 },
  });
  expect(enqueued.status()).toBe(202);
  const run = (await enqueued.json()).run;
  await expect
    .poll(
      async () =>
        (await (await page.request.get(base + "/runs/" + run.id)).json()).run
          .status,
    )
    .toBe("completed");
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (
      ["POST", "PUT", "DELETE", "PATCH"].includes(request.method()) &&
      new URL(request.url()).pathname.startsWith("/api/")
    )
      mutations.push(request.method());
  });
  await page.goto("/?q=" + encodeURIComponent("찾을수없는합성문구"));
  await expect(page.locator(".saved-job-list > li")).toHaveCount(0);
  const toggle = page.getByRole("group", { name: "오피스 표시 선택" });
  await toggle
    .getByRole("button", { name: "서버 집계 보기", exact: true })
    .click();
  const panel = page.getByRole("region", {
    name: "서버 집계 현황",
    exact: true,
  });
  await expect(panel.getByRole("status")).toHaveText("검토 대기");
  await expect(panel.locator(".server-counts dd").first()).toHaveText("23건");
  await expect(page.locator(".person-intro h3")).toHaveText("데이터 분석가");
  await expect(page.locator(".person-data")).toContainText(job.title);
  await expect(
    page.getByLabel("직원 선택").getByRole("button", { name: /운영팀장/ }),
  ).toContainText("검토 대기 1건");
  expect(
    new URL(
      await panel
        .getByRole("link", { name: "집계 실행·결과·검토 보기" })
        .getAttribute("href")!,
      page.url(),
    ).searchParams.get("run"),
  ).toBe(run.id);
  const review = await (
    await page.request.get(base + "/runs/" + run.id + "/review")
  ).json();
  expect(
    (
      await page.request.post(base + "/runs/" + run.id + "/review", {
        headers: {
          "X-Office-Request": "1",
          "Idempotency-Key": crypto.randomUUID(),
        },
        data: {
          targetHash: review.targetHash,
          decision: "approved",
          comment: "합성 오피스 검토",
        },
      })
    ).status(),
  ).toBe(201);
  await expect(panel.getByRole("status")).toHaveText("승인 기록");
  await expect(
    page.getByLabel("직원 선택").getByRole("button", { name: /데이터 분석가/ }),
  ).toContainText("승인 기록");
  await toggle
    .getByRole("button", { name: "업무 시연 보기", exact: true })
    .click();
  await expect(page.locator(".phase-announcement")).toHaveText(
    "업무 선택 대기",
  );
  await toggle
    .getByRole("button", { name: "서버 집계 보기", exact: true })
    .click();
  await expect(panel.getByRole("status")).toHaveText("승인 기록");
  expect(mutations).toEqual([]);
  expect(
    (await (await page.request.get(base + "/runs")).json()).page.total,
  ).toBe(1);
  expect(
    (
      await page.request.post("/api/auth/logout", {
        headers: { "X-Office-Request": "1" },
        data: {},
      })
    ).status(),
  ).toBe(200);
  await expect(panel).toHaveCount(0);
  await expect(page.locator(".person-data")).not.toContainText(job.title);
  await registerViaApi(page);
  await page.reload();
  await toggle
    .getByRole("button", { name: "서버 집계 보기", exact: true })
    .click();
  await expect(panel.getByRole("status")).toHaveText("접수한 집계 없음");
  await expect(panel.locator(".server-counts dd").first()).toHaveText("0건");
  await expect(
    page.getByRole("region", { name: "최근 서버 집계 기록", exact: true }),
  ).not.toContainText(job.title);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("실행 중 캐릭터 표시·조회 실패의 마지막 기록·복구를 확인하며 서버 쓰기를 만들지 않는다", async ({
  page,
}) => {
  await registerViaApi(page);
  const job = await createJob(page, "합성 표시 계약 업무");
  const snapshot = {
    executionMode: "quantitative_summary",
    aiConnected: false,
    totals: {
      jobs: 1,
      queued: 0,
      running: 1,
      latestRuns: 1,
      completed: 0,
      failed: 0,
      cancelled: 0,
      reviewPending: 0,
      approved: 0,
      rejected: 0,
      summaryOnly: 0,
    },
    focus: {
      runId: crypto.randomUUID(),
      jobId: job.id,
      jobTitle: job.title,
      fileId: crypto.randomUUID(),
      filename: "합성 표시.csv",
      status: "running",
      revision: 1,
      review: null,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
    },
    recent: [],
  };
  let broken = false,
    invalid = false;
  // Synthetic GET responses exercise long-running animation and transport failure
  // without pausing the shared real worker or creating a fake production run.
  await page.route("**/api/jobs/office", async (route) => {
    if (broken) await route.abort();
    else
      await route.fulfill({
        json: invalid ? { ...snapshot, totals: null } : snapshot,
      });
  });
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (["POST", "PUT", "DELETE", "PATCH"].includes(request.method()))
      mutations.push(request.method());
  });
  await page.goto("/");
  await page
    .getByRole("group", { name: "오피스 표시 선택" })
    .getByRole("button", { name: "서버 집계 보기", exact: true })
    .click();
  const panel = page.getByRole("region", {
    name: "서버 집계 현황",
    exact: true,
  });
  await expect(panel.getByRole("status")).toHaveText("집계 실행 중");
  const roster = page.getByLabel("직원 선택");
  await roster.getByRole("button", { name: /운영팀장/ }).click();
  await page.waitForTimeout(1300);
  const canvas = page.locator("canvas"),
    box = (await canvas.boundingBox())!;
  await canvas.click({
    position: { x: (box.width * 468) / 960, y: (box.height * 190) / 664 },
  });
  await expect(page.locator(".person-intro h3")).toHaveText("데이터 분석가");
  await expect(
    roster.getByRole("button", { name: /데이터 분석가/ }),
  ).toContainText("집계 실행 중");
  broken = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(panel.getByRole("status")).toContainText("상태 확인 필요");
  await expect(panel.getByRole("alert")).toContainText("연결");
  await expect(
    roster.getByRole("button", { name: /데이터 분석가/ }),
  ).toContainText("상태 확인 필요");
  await expect(panel.locator(".server-current h3")).toHaveText(job.title);
  broken = false;
  invalid = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(panel.getByRole("alert")).toContainText("응답 형식");
  await expect(panel.getByRole("status")).toContainText("상태 확인 필요");
  invalid = false;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(panel.getByRole("status")).toHaveText("집계 실행 중");
  await expect(panel.getByRole("alert")).toHaveCount(0);
  expect(mutations).toEqual([]);
  expect((await (await page.request.get("/api/jobs")).json()).page.total).toBe(
    1,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
