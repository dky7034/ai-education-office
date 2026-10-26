import { expect, type Page } from "@playwright/test";
import { registerViaApi } from "./accountHelpers";
import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
export async function reviewFixture(page: Page) {
  await registerViaApi(page);
  const account = (await (await page.request.get("/api/auth/session")).json()).user.id;
  const created = await page.request.post("/api/jobs", { headers: { "X-Office-Request": "1", "Idempotency-Key": randomUUID() },
    data: { kind: "notice", title: "합성 AI 초안 검토 화면", instructions: "합성 안내문 검토" } });
  expect(created.status()).toBe(201);
  const job = (await created.json()).job, id = randomUUID(), filename = process.env.OFFICE_E2E_DB;
  if (!filename || !/e2e(?:-dev)?\.sqlite$/.test(filename)) throw Error("Explicit isolated E2E DB required");
  const db = new DatabaseSync(filename), text = "합성 <script>window.__reviewUnsafe=true</script> 초안";
  const time = "2026-10-26T00:00:00.000Z";
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
  try {
    db.prepare(`INSERT INTO ai_runs(id,account_id,job_id,request_key,input_text,mode,model,policy_id,status,remote_status,thread_id,turn_id,result_text,result_hash,created_at,started_at,finished_at)
      VALUES(?,?,?,?,?,'synthetic','synthetic-model','synthetic-review-ui','completed','completed','synthetic-thread','synthetic-turn',?,?,?,?,?)`)
      .run(id, account, job.id, randomUUID(), "합성 검토 입력", text, createHash("sha256").update(text).digest("hex"), time, time, time);
    for (const state of ["queued", "running", "completed"]) db.prepare("INSERT INTO ai_run_events(run_id,status,created_at) VALUES(?,?,?)").run(id, state, time);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; } finally { db.close(); }
  const base = `/api/jobs/${job.id}/ai-runs/${id}`;
  return { id, job, account, base, text };
}
export const aiPanel = (page: Page) => page.getByRole("region", { name: "AI 텍스트 초안·실행 이력", exact: true });
export const reviewPanel = (page: Page) => page.getByRole("region", { name: "AI 초안 검토", exact: true });
