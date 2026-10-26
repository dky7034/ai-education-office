import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { reviewFixture, aiPanel, reviewPanel } from "./aiReviewFixtures";

test("AI 초안 승인·응답 유실의 같은 결정 재확인·URL 복원을 외부 효과 없이 확인한다", async ({ page }) => {
  await page.routeWebSocket("**/api/jobs/updates?*", (ws) => { ws.connectToServer().onMessage(() => {}); });
  const { id, job, base, text } = await reviewFixture(page);
  await page.goto(`/?job=${job.id}&aiRun=${id}`);
  const review = reviewPanel(page), approve = review.getByRole("button", { name: "AI 승인 확정", exact: true });
  await expect(aiPanel(page).locator(".ai-text pre")).toHaveText(text);
  await expect(approve).toBeDisabled();
  await review.getByLabel("AI 검토 의견 (선택)", { exact: true }).fill("합성 의견 <script>문자</script>");
  await review.getByRole("checkbox").check();
  let lose = true; const keys: string[] = [];
  await page.route("**" + base + "/review", async (route) => {
    if (route.request().method() === "POST") {
      keys.push(route.request().headers()["idempotency-key"]);
      if (lose) {
        lose = false; const response = await route.fetch(); expect(response.status()).toBe(201); await route.abort(); return;
      }
    }
    await route.continue();
  });
  await approve.click(); await expect(review.getByRole("alert")).toContainText("연결");
  await expect(approve).toBeEnabled(); await approve.click();
  await expect(review.locator(".ai-review-decision strong")).toHaveText("AI 초안 승인 기록");
  expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]);
  await expect(review.locator(".ai-review-comment")).toContainText("<script>문자</script>");
  expect(await review.locator("script").count()).toBe(0);
  const writes: string[] = [];
  page.on("request", (r) => { if (["POST", "PUT", "PATCH", "DELETE"].includes(r.method()) && new URL(r.url()).pathname.startsWith("/api/")) writes.push(r.url()); });
  await page.reload(); await expect(review.locator(".ai-review-decision strong")).toHaveText("AI 초안 승인 기록");
  await review.getByRole("button", { name: "AI 검토 상태 새로고침" }).click();
  await expect(review.getByRole("form")).toHaveCount(0); expect(writes).toEqual([]);
  expect(await page.evaluate(() => (window as Window & {__reviewUnsafe?:boolean}).__reviewUnsafe)).toBeUndefined();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("AI 검토 초안·확인 체크를 자동 갱신에서 유지하고 다른 화면의 반려 확정을 반영한다", async ({ page }) => {
  const { id, job, base } = await reviewFixture(page);
  await page.goto(`/?job=${job.id}&aiRun=${id}`);
  const review = reviewPanel(page);
  await review.getByLabel("AI 검토 결정", { exact: true }).selectOption("rejected");
  const reject = review.getByRole("button", { name: "AI 반려 확정", exact: true });
  await expect(reject).toBeDisabled();
  await review.getByLabel("AI 검토 의견 (필수)", { exact: true }).fill("유지할 합성 반려 초안");
  await review.getByRole("checkbox").check();
  const refreshed = page.waitForResponse((r) => r.url().endsWith(base + "/review") && r.request().method() === "GET");
  await page.request.post("/api/jobs", { headers: { "X-Office-Request": "1", "Idempotency-Key": randomUUID() }, data: { kind: "notice", title: "합성 갱신 알림", instructions: "합성" } });
  await refreshed;
  await expect(review.getByLabel("AI 검토 의견 (필수)")).toHaveValue("유지할 합성 반려 초안");
  await expect(review.getByRole("checkbox")).toBeChecked(); await expect(reject).toBeEnabled();
  const state = await (await page.request.get(base + "/review")).json();
  const result = await page.request.post(base + "/review", { headers: { "X-Office-Request": "1", "Idempotency-Key": randomUUID() },
    data: { targetHash: state.targetHash, decision: "rejected", comment: "다른 화면에서 확정한 합성 반려" } });
  expect(result.status()).toBe(201);
  await expect(review.locator(".ai-review-decision strong")).toHaveText("AI 초안 반려 기록");
  await expect(review.locator(".ai-review-comment")).toContainText("다른 화면에서 확정한 합성 반려");
  await expect(review.getByRole("form")).toHaveCount(0);
});

test("AI 검토 충돌은 기존 결정을 복구하고 손상 응답에서는 당시 기록만 표시한다", async ({ page }) => {
  await page.routeWebSocket("**/api/jobs/updates?*", (ws) => { ws.connectToServer().onMessage(() => {}); });
  const { id, job, base } = await reviewFixture(page);
  await page.goto(`/?job=${job.id}&aiRun=${id}`);
  const review = reviewPanel(page);
  await review.getByLabel("AI 검토 의견 (선택)").fill("합성 승인 의견"); await review.getByRole("checkbox").check();
  const initial = await (await page.request.get(base + "/review")).json();
  const stored = await page.request.post(base + "/review", { headers: { "X-Office-Request": "1", "Idempotency-Key": randomUUID() }, data: { targetHash: initial.targetHash, decision: "rejected", comment: "선행 합성 반려" } });
  expect(stored.status()).toBe(201);
  await review.getByRole("button", { name: "AI 승인 확정", exact: true }).click();
  await expect(review.getByRole("alert")).toContainText("이미 AI 초안");
  await expect(review.locator(".ai-review-decision strong")).toHaveText("AI 초안 반려 기록");
  const history = await (await page.request.get(base + "/review")).json();
  await page.route("**" + base + "/review", async (route) => {
    if (route.request().method() === "GET") await route.fulfill({ json: { targetHash: null, resultHash: null, reviewable: false, problem: "합성 무결성 실패", decision: { ...history.decision, valid: false } } });
    else await route.continue();
  });
  await page.route("**" + base + "/result", (route) => route.fulfill({ status: 409, json: { error: "합성 무결성 실패" } }));
  await aiPanel(page).getByRole("button", { name: "AI 기록 새로고침" }).click();
  await expect(aiPanel(page).locator(".ai-text pre")).toHaveCount(0);
  await expect(review.locator(".ai-review-decision strong")).toHaveText("AI 초안 반려 기록");
  await expect(review.getByRole("alert")).toContainText("유효한지 확인할 수 없습니다");
  await expect(review.getByRole("form")).toHaveCount(0);
});
