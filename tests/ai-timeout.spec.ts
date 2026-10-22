import { test, expect, type Page } from "@playwright/test";
import { cancelSyntheticPending } from "./aiCleanup";
import { createStore } from "../backend/src/store";
import { registerViaApi } from "./accountHelpers";
import { randomUUID } from "node:crypto";

const scopes = new WeakMap<Page, string>();
test.afterEach(async ({ page }) => { const base = scopes.get(page); if (base) await cancelSyntheticPending(page, base); });

test("AI 접수 응답 시간 초과 후 잠금을 풀고 같은 요청으로 한 실행만 재확인한다", async ({ page }) => {
  const filename = process.env.OFFICE_E2E_DB;
  if (!filename || !/e2e(?:-dev)?\.sqlite$/.test(filename)) throw Error("Explicit isolated E2E DB required");
  await registerViaApi(page);
  const account = (await (await page.request.get("/api/auth/session")).json()).user.id;
  const created = await page.request.post("/api/jobs", {
    headers: { "X-Office-Request": "1", "Idempotency-Key": randomUUID() },
    data: { kind: "notice", title: "합성 응답 시간 초과", instructions: "합성 텍스트 요청" },
  });
  expect(created.status()).toBe(201);
  const job = (await created.json()).job, base = `/api/jobs/${job.id}/ai-runs`;
  scopes.set(page, base);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; }), keys: string[] = [];
  await page.route("**" + base + "?*", async (route) => {
    const response = await route.fetch(), data = await response.json();
    await route.fulfill({ response, json: { ...data, capability: { configured: true, mode: "synthetic" } } });
  });
  await page.route("**" + base, async (route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    const key = route.request().headers()["idempotency-key"]; keys.push(key);
    const store = createStore(filename);
    let value;
    try { value = store.enqueueAi(account, job.id, key, { mode: "synthetic", model: "synthetic-model", policyId: "synthetic-ui-timeout" })!; }
    finally { store.close(); }
    if (keys.length === 1) await gate;
    await route.fulfill({ status: value.replayed ? 200 : 202, json: value }).catch(() => {});
  });
  await page.goto(`/?job=${job.id}`);
  const ai = page.getByRole("region", { name: "AI 텍스트 초안·실행 이력", exact: true });
  await ai.getByRole("button", { name: "텍스트 초안 접수", exact: true }).click();
  await expect(ai.getByRole("button", { name: "접수 응답 다시 확인" })).toBeEnabled({ timeout: 15000 });
  await expect(ai.getByRole("alert")).toContainText("대기 시간을 초과");
  expect(keys).toHaveLength(1); release();
  await ai.getByRole("button", { name: "AI 기록 새로고침" }).click();
  await expect(ai).toContainText("AI 실행 기록 1개"); expect(keys).toHaveLength(1);
  await ai.getByRole("button", { name: "접수 응답 다시 확인" }).click();
  await expect(ai).toContainText("추가 실행을 만들지 않았습니다");
  expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]);
  expect((await (await page.request.get(base)).json()).page.total).toBe(1);
});
