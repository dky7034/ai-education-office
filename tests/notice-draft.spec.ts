import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { registerViaApi } from "./accountHelpers";

test("구조화 공지의 응답 유실 재확인은 한 업무이며 입력·TXT·새로고침·검색을 유지한다", async ({page}) => {
  await registerViaApi(page); await page.goto("/");
  const form = page.getByRole("form", {name: "새 업무 요청", exact: true});
  await expect(form.getByRole("button", {name: "업무 요청 저장", exact: true})).toBeEnabled();
  await form.getByLabel("업무 종류", {exact: true}).selectOption("notice");
  await form.getByLabel("목적·대상·핵심 내용으로 작성", {exact: true}).check();
  await form.getByLabel("업무 제목").fill("가상 과정 안내");
  await form.getByLabel("초안 형식", {exact: true}).selectOption("email");
  await form.getByLabel("작성 목적 · 필수", {exact: true}).fill("가상 운영 일정 공유");
  await form.getByLabel("안내 대상 · 필수", {exact: true}).fill("가상 과정 참여자");
  await form.getByLabel("핵심 내용 · 필수", {exact: true}).fill("가상 안내 A\n<script>합성 문자</script>");
  await form.getByLabel("작성자 참고 메모 · 선택", {exact: true}).fill("검수 뒤 삭제할 가상 메모");
  // Toggling modes must preserve both the old free text and the structured fields.
  await form.getByLabel("목적·대상·핵심 내용으로 작성", {exact: true}).uncheck();
  await form.getByLabel("요청 내용").fill("보존할 자유 입력");
  await form.getByLabel("목적·대상·핵심 내용으로 작성", {exact: true}).check();
  await expect(form.getByLabel("작성 목적 · 필수", {exact: true})).toHaveValue("가상 운영 일정 공유");
  let lose = true;
  await page.route("**/api/jobs", async (route) => {
    if (route.request().method() === "POST" && lose) { lose = false; const response = await route.fetch(); expect(response.status()).toBe(201); await route.abort(); }
    else await route.continue();
  });
  await form.getByRole("button", {name: "업무 요청 저장", exact: true}).click();
  await expect(form.getByRole("alert")).toBeVisible();
  await expect(form.getByLabel("핵심 내용 · 필수", {exact: true})).toHaveValue("가상 안내 A\n<script>합성 문자</script>");
  await form.getByRole("button", {name: "업무 요청 저장", exact: true}).click();
  await expect(form.getByRole("status")).toContainText("저장했습니다");
  const list = await (await page.request.get("/api/jobs")).json(); expect(list.page.total).toBe(1);
  const draft = page.getByRole("region", {name: "공지·메일 검수용 초안", exact: true});
  await expect(draft).toContainText("가상 운영 일정 공유"); await expect(draft).toContainText("<script>합성 문자</script>");
  await form.getByLabel("업무 제목").fill("유지할 다음 업무 제목");
  let failed = false;
  await page.route("**/api/jobs/*/notice-draft", async (route) => { if (!failed) {failed = true; await route.abort();} else await route.continue(); });
  const button = draft.getByRole("button", {name: "공지·메일 초안 TXT 다운로드", exact: true});
  await button.click(); await expect(draft.getByRole("alert")).toContainText("내려받지 못했습니다");
  const pending = page.waitForEvent("download"); await button.click(); const file = await pending;
  const text = await readFile((await file.path())!, "utf8");
  expect(file.suggestedFilename()).toMatch(/^office-notice-[a-f0-9-]+\.txt$/);
  expect(text).toContain("규칙 기반 메일 초안"); expect(text).toContain("가상 안내 A\r\n<script>합성 문자</script>");
  expect(text).toContain("검수 뒤 삭제할 가상 메모"); expect(text).not.toContain("보존할 자유 입력");
  await expect(form.getByLabel("업무 제목")).toHaveValue("유지할 다음 업무 제목");
  await page.getByLabel("업무 검색", {exact: true}).fill("가상 운영 일정");
  await page.getByRole("button", {name: "검색·필터 적용", exact: true}).click();
  await expect(page.locator(".saved-job-list > li")).toHaveCount(1);
  await page.reload(); await expect(page.getByRole("region", {name: "공지·메일 검수용 초안", exact: true})).toContainText("가상 운영 일정 공유");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test("기존 자유 공지는 유지하며 다른 계정은 저장된 구조화 공지와 초안에 접근하지 못한다", async ({page}) => {
  await registerViaApi(page);
  const structured = await page.request.post("/api/jobs", {headers: {"X-Office-Request": "1", "Idempotency-Key": "notice-scoped-request"},
    data: {kind: "notice", title: "가상 계정 전용 공지", notice: {format: "notice", purpose: "가상 공지", audience: "가상 대상", keyPoints: "가상 내용"}}});
  const job = (await structured.json()).job;
  const legacy = await page.request.post("/api/jobs", {headers: {"X-Office-Request": "1", "Idempotency-Key": "notice-legacy-request"},
    data: {kind: "notice", title: "가상 자유 공지", instructions: "원문 요청 그대로"}});
  const old = (await legacy.json()).job;
  await page.goto(`/?job=${old.id}`);
  await expect(page.getByRole("region", {name: "선택한 업무 상세", exact: true})).toContainText("원문 요청 그대로");
  await expect(page.getByRole("region", {name: "공지·메일 검수용 초안", exact: true})).toHaveCount(0);
  await page.request.post("/api/auth/logout", {headers: {"X-Office-Request": "1"}, data: {}});
  await registerViaApi(page); await page.goto(`/?job=${job.id}`);
  await expect(page.getByRole("region", {name: "선택한 업무 상세", exact: true})).toContainText("업무를 찾을 수 없거나");
  expect((await page.request.get(`/api/jobs/${job.id}/notice-draft`)).status()).toBe(404);
  await expect(page.getByText("가상 대상", {exact: true})).toHaveCount(0);
});
