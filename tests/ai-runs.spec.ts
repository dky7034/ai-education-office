import { expect, test, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { registerViaApi, accountPanel } from "./accountHelpers";
import { cancelSyntheticPending } from "./aiCleanup";
import { createStore } from "../backend/src/store";
import type { AiStatus } from "../backend/src/aiStore";
const scopes = new WeakMap<Page, string>();
test.afterEach(async ({ page }) => { const base = scopes.get(page); if (base) await cancelSyntheticPending(page, base); });
const config = { mode: "synthetic" as const, model: "synthetic-model", policyId: "synthetic-ui-v1" };
const stamp = "2026-10-22T02:00:00.000Z";
const text = "합성 초안 <script>window.__aiUnsafe=true</script>\n" + "긴합성문구".repeat(180);
function filename() {
  const path = process.env.OFFICE_E2E_DB;
  if (!path || !/e2e(?:-dev)?\.sqlite$/.test(path)) throw Error("Explicit isolated E2E DB required");
  return path;
}
async function setup(page: Page, title = "합성 AI 화면 업무") {
  await registerViaApi(page);
  const session = await (await page.request.get("/api/auth/session")).json();
  const job = await createJob(page, title);
  const base = `/api/jobs/${job.id}/ai-runs`; scopes.set(page, base);
  return { account: session.user.id as string, job, base };
}
async function createJob(page: Page, title: string) {
  const response = await page.request.post("/api/jobs", { headers: { "X-Office-Request": "1", "Idempotency-Key": randomUUID() },
    data: { kind: "notice", title, instructions: "합성 텍스트 초안 요청" } });
  expect(response.status()).toBe(201); return (await response.json()).job;
}
// Explicit synthetic records only, scoped to this test's account in the E2E DB.
function seed(account: string, job: string, status: AiStatus = "completed", createdAt = stamp) {
  const db = new DatabaseSync(filename()); db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
  const id = randomUUID(), done = !["queued", "running", "cancelling"].includes(status);
  try {
    db.prepare(`INSERT INTO ai_runs(id,account_id,job_id,request_key,input_text,mode,model,policy_id,status,remote_status,thread_id,turn_id,result_text,result_hash,created_at,started_at,finished_at)
      VALUES(?,?,?,?,?,'synthetic',?,?,?,?,'synthetic-thread','synthetic-turn',?,?,?,?,?)`).run(
      id, account, job, randomUUID(), "합성 UI 검증 입력", config.model, config.policyId, status,
      status === "completed" ? "completed" : "unknown", status === "completed" ? text : null,
      status === "completed" ? createHash("sha256").update(text).digest("hex") : null,
      createdAt, status === "queued" ? null : createdAt, done ? createdAt : null);
    const states = status === "queued" ? ["queued"] : status === "running" ? ["queued", "running"] : status === "cancelling" ? ["queued", "running", "cancelling"] : ["queued", "running", status];
    for (const state of states) db.prepare("INSERT INTO ai_run_events(run_id,status,created_at) VALUES(?,?,?)").run(id, state, createdAt);
    db.exec("COMMIT"); return id;
  } catch (error) { db.exec("ROLLBACK"); throw error; } finally { db.close(); }
}
function finish(id: string, status: "cancelled" | "completed" = "cancelled") {
  const db = new DatabaseSync(filename()); db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE ai_runs SET status=?,remote_status=?,finished_at=?,result_text=?,result_hash=? WHERE id=?").run(status,
      status === "cancelled" ? "interrupted" : "completed", stamp, status === "completed" ? text : null,
      status === "completed" ? createHash("sha256").update(text).digest("hex") : null, id);
    db.prepare("INSERT INTO ai_run_events(run_id,status,created_at) VALUES(?,?,?)").run(id, status, stamp); db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; } finally { db.close(); }
}
const panel = (page: Page) => page.getByRole("region", { name: "AI 텍스트 초안·실행 이력", exact: true });
const row = (page: Page, id: string) => panel(page).locator(`[data-ai-run-id="${id}"]`);

test("AI 기본 비활성·합성 초안·페이지·URL 복원·계정 격리를 읽기 전용으로 확인한다", async ({ page }) => {
  const { account, job } = await setup(page);
  const ids = Array.from({ length: 23 }, (_, i) => seed(account, job.id, "completed", new Date(Date.parse(stamp) + i * 1000).toISOString()));
  const mutations: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && r.url().includes("/ai-runs")) mutations.push(r.url()); });
  await page.goto(`/?job=${job.id}`);
  const ai = panel(page);
  await expect(ai.getByRole("status", { name: "AI 접수 설정" })).toContainText("AI 실행 미설정");
  await expect(ai.getByRole("button", { name: "텍스트 초안 접수", exact: true })).toBeDisabled();
  await expect(ai.locator(".ai-run-list > li")).toHaveCount(20);
  await row(page, ids[22]).getByRole("button", { name: "AI 초안 결과 보기" }).click();
  const stored = ai.getByRole("region", { name: "검수 필요한 AI 초안" });
  await expect(ai).toContainText("미승인 초안"); await expect(stored.locator("pre")).toHaveText(text);
  expect(await stored.locator("script").count()).toBe(0);
  expect(await page.evaluate(() => (window as Window & {__aiUnsafe?:boolean}).__aiUnsafe)).toBeUndefined();
  await ai.getByRole("button", { name: "다음 AI 기록" }).click();
  await expect(ai.locator(".ai-run-list > li")).toHaveCount(3);
  await expect(stored.locator("pre")).toHaveText(text);
  expect(new URL(page.url()).searchParams.get("aiRun")).toBe(ids[22]);
  await page.reload(); await expect(stored.locator("pre")).toHaveText(text);
  await page.getByLabel("업무 검색", { exact: true }).fill("입력 유지 합성문구");
  seed(account, job.id, "failed", "2026-10-22T03:00:00.000Z");
  await expect(ai).toContainText("AI 실행 기록 24개");
  await expect(page.getByLabel("업무 검색", { exact: true })).toHaveValue("입력 유지 합성문구");
  await expect(stored.locator("pre")).toHaveText(text);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(mutations).toEqual([]);
  const second = await createJob(page, "다른 합성 AI 업무");
  await page.goto(`/?job=${second.id}&aiRun=${ids[22]}`);
  await expect(panel(page).getByRole("alert")).toContainText("찾을 수");
  await expect(panel(page).locator("pre")).toHaveCount(0);
  await accountPanel(page).getByRole("button", { name: "로그아웃", exact: true }).click();
  await expect(panel(page)).toHaveCount(0);
  expect(new URL(page.url()).searchParams.has("aiRun")).toBe(false);
  await registerViaApi(page); await page.goto(`/?job=${job.id}&aiRun=${ids[22]}`);
  await expect(page.getByRole("region", { name: "선택한 업무 상세" })).toContainText("접근할 수");
  await expect(panel(page)).toHaveCount(0);
});

test("AI 대기 취소·중단 접수·원격 확인·재시작 미확정을 구분하며 조회로 재실행하지 않는다", async ({ page }) => {
  const { account, job, base } = await setup(page);
  const queued = seed(account, job.id, "queued");
  await page.goto(`/?job=${job.id}`);
  await row(page, queued).getByRole("button", { name: "AI 대기 취소" }).click();
  await expect(row(page, queued)).toContainText("실행 전에 취소");
  const running = seed(account, job.id, "running", "2026-10-22T03:00:00.000Z");
  await row(page, running).getByRole("button", { name: "AI 실행 중단 요청" }).click();
  await expect(row(page, running)).toContainText("중단 요청 중");
  await expect(row(page, running).getByRole("button", { name: "AI 실행 중단 요청" })).toHaveCount(0);
  finish(running);
  await expect(row(page, running)).toContainText("원격 실행 중단이 확인");
  const interrupted = seed(account, job.id, "interrupted", "2026-10-22T04:00:00.000Z");
  await expect(row(page, interrupted)).toContainText("자동 재실행하지");
  await row(page, interrupted).getByRole("button", { name: "AI 실행 상세 보기" }).click();
  await expect(panel(page).getByRole("region", { name: "선택한 AI 실행 기록" })).toContainText("실행 결과 확인 필요");
  await page.reload();
  await expect(panel(page).getByRole("region", { name: "선택한 AI 실행 기록" })).toContainText("자동 재실행하지");
  expect((await (await page.request.get(base)).json()).page.total).toBe(3);
});

test("AI 합성 접수 응답 유실의 명시적 재확인은 같은 키로 한 실행만 만들며 자동 POST하지 않는다", async ({ page }) => {
  const { account, job, base } = await setup(page);
  const keys: string[] = []; let lost = true, id = "";
  await page.route("**" + base + "?*", async (route) => {
    const response = await route.fetch(), data = await response.json();
    await route.fulfill({ response, json: { ...data, capability: { configured: true, mode: "synthetic" } } });
  });
  await page.route("**" + base, async (route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    expect(route.request().postDataJSON()).toEqual({});
    const key = route.request().headers()["idempotency-key"]; keys.push(key);
    const s = createStore(filename());
    let value;
    try { value = s.enqueueAi(account, job.id, key, config)!; } finally { s.close(); }
    id = value.run.id;
    if (lost) { lost = false; await route.abort(); }
    else await route.fulfill({ status: value.replayed ? 200 : 202, json: value });
  });
  await page.goto(`/?job=${job.id}`);
  const ai = panel(page), submit = ai.getByRole("button", { name: "텍스트 초안 접수", exact: true });
  await expect(ai).toContainText("합성 실행기 설정");
  await submit.click();
  await expect(ai.getByRole("button", { name: "접수 응답 다시 확인" })).toBeEnabled();
  await ai.getByRole("button", { name: "AI 기록 새로고침" }).click();
  await expect(row(page, id)).toContainText("대기");
  expect(keys.length).toBe(1);
  await ai.getByRole("button", { name: "접수 응답 다시 확인" }).click();
  await expect(ai).toContainText("추가 실행을 만들지 않았습니다");
  expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]);
  expect((await (await page.request.get(base)).json()).page.total).toBe(1);
  await page.reload(); await expect(row(page, id)).toContainText("대기"); expect(keys).toHaveLength(2);
});

test("AI 결과 조회 실패·잘못된 200 응답·전환 중 늦은 응답을 분리하고 기존 입력을 유지한다", async ({ page }) => {
  const { account, job, base } = await setup(page);
  const id = seed(account, job.id), otherJob = await createJob(page, "합성 전환 대상");
  await page.goto(`/?job=${job.id}&aiRun=${id}`);
  const ai = panel(page), stored = ai.getByRole("region", { name: "검수 필요한 AI 초안" });
  await expect(stored.locator("pre")).toHaveText(text);
  await page.getByLabel(/업무 제목/).fill("유지할 합성 입력");
  let broken = true;
  await page.route("**" + base + "/" + id + "/result", async (route) => {
    if (broken) await route.abort(); else await route.continue();
  });
  await ai.getByRole("button", { name: "AI 기록 새로고침" }).click();
  await expect(ai.getByRole("alert")).toContainText("현재 상태 확인");
  await expect(stored).toContainText("마지막으로 확인한 초안");
  await expect(page.getByLabel(/업무 제목/)).toHaveValue("유지할 합성 입력");
  broken = false; await ai.getByRole("button", { name: "AI 기록 새로고침" }).click();
  await expect(ai.getByRole("alert")).toHaveCount(0);
  await page.unroute("**" + base + "/" + id + "/result");
  await page.route("**" + base + "/" + id + "/result", async (route) => {
    const response = await route.fetch(); await route.fulfill({ response, json: { ...await response.json(), needsReview: false } });
  });
  await ai.getByRole("button", { name: "AI 기록 새로고침" }).click();
  await expect(ai.getByRole("alert")).toContainText("응답을 확인하지");
  await expect(ai.locator("pre")).toHaveCount(0);
  let release!: () => void, seen!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; }), observed = new Promise<void>((resolve) => { seen = resolve; });
  await page.unroute("**" + base + "/" + id + "/result");
  await page.route("**" + base + "/" + id, async (route) => {
    const response = await route.fetch(); seen(); await gate;
    await route.fulfill({ response }).catch(() => {});
  });
  await ai.getByRole("button", { name: "AI 기록 새로고침" }).click(); await observed;
  await page.locator(`[data-job-id="${otherJob.id}"] > button`).first().click();
  release();
  await expect(panel(page)).toContainText("접수한 AI 텍스트 초안이 없습니다");
  await expect(panel(page).locator("pre")).toHaveCount(0);
  expect(new URL(page.url()).searchParams.has("aiRun")).toBe(false);
});


test("AI 조회 권한 거부 뒤 늦은 성공 응답으로 이전 초안을 다시 표시하지 않는다", async ({ page }) => {
  const { account, job, base } = await setup(page);
  const id = seed(account, job.id);
  await page.goto(`/?job=${job.id}&aiRun=${id}`);
  const ai = panel(page);
  await expect(ai.locator("pre")).toHaveText(text);
  let release!: () => void, seen!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const observed = new Promise<void>((resolve) => { seen = resolve; });
  await page.route("**" + base + "/" + id + "/result", async (route) => {
    const response = await route.fetch(); seen(); await gate;
    await route.fulfill({ response }).catch(() => {});
  });
  await page.route("**" + base + "?*", async (route) => {
    await observed;
    await route.fulfill({ status: 404, json: { error: "합성 권한 변경: 접근할 수 없습니다." } });
  });
  await ai.getByRole("button", { name: "AI 기록 새로고침" }).click();
  await expect(ai.getByRole("alert")).toContainText("합성 권한 변경");
  await expect(ai.locator("pre")).toHaveCount(0);
  const delivered = page.waitForResponse((response) => response.url().endsWith(base + "/" + id + "/result"));
  release(); await delivered;
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(ai.locator("pre")).toHaveCount(0);
  await expect(ai.getByRole("button", { name: "텍스트 초안 접수", exact: true })).toBeDisabled();
});

test("AI 접수 설정은 실제 연결 성공과 구분하며 조회 실패·잘못된 설정이면 버튼을 잠근다", async ({ page }) => {
  const { job, base } = await setup(page);
  let mode: "ok" | "bad" | "offline" = "ok", posts = 0;
  page.on("request", (request) => { if (request.method() === "POST" && request.url().includes("/ai-runs")) posts++; });
  await page.route("**" + base + "?*", async (route) => {
    if (mode === "offline") { await route.abort(); return; }
    const response = await route.fetch(), data = await response.json();
    await route.fulfill({ response, json: { ...data, capability: { configured: true, mode: mode === "bad" ? ["codex"] : "codex" } } });
  });
  await page.goto(`/?job=${job.id}`);
  const ai = panel(page), submit = ai.getByRole("button", { name: "텍스트 초안 접수", exact: true });
  await expect(ai).toContainText("실제 연결 성공 여부는 실행 후 확인");
  await expect(ai).toContainText("사용료가 발생할 수");
  await expect(submit).toBeEnabled();
  mode = "bad"; await ai.getByRole("button", { name: "AI 기록 새로고침" }).click();
  await expect(ai.getByRole("alert")).toContainText("응답을 확인하지"); await expect(submit).toBeDisabled();
  mode = "offline"; await ai.getByRole("button", { name: "AI 기록 새로고침" }).click();
  await expect(ai.getByRole("alert")).toContainText("연결"); await expect(submit).toBeDisabled();
  mode = "ok"; await ai.getByRole("button", { name: "AI 기록 새로고침" }).click();
  await expect(ai.getByRole("alert")).toHaveCount(0); await expect(submit).toBeEnabled();
  expect(posts).toBe(0);
});
