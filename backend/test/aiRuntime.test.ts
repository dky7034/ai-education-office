import { test } from "node:test";
import assert from "node:assert/strict";
import { access, chmod, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { loadAiRuntime } from "../src/aiRuntime.ts";
import { createAiQueue } from "../src/aiQueue.ts";
import { createStore } from "../src/store.ts";
import { fixture, testPassword, cookie } from "./fixture.ts";

const config = { mode: "synthetic", model: "synthetic-model", policyId: "synthetic-policy" } as const;
const jobInput = { kind: "notice", title: "가상 운영 연결", instructions: "가상 안내 초안을 작성하세요." };
async function until<T>(check: () => Promise<T> | T, timeout = 8000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise((done) => setTimeout(done, 20)); }
  throw new Error("합성 서버 상태를 확인하지 못했습니다.");
}
async function files(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "office-ai-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, "codex-server.mjs"), observations = join(root, "observations.jsonl");
  for (const name of ["codex-server.mjs", "codex-execution.mjs"])
    await copyFile(new URL(`./fixtures/${name}`, import.meta.url), join(root, name));
  await writeFile(executable, `#!${process.execPath}\n${await readFile(executable, "utf8")}`); await chmod(executable, 0o700);
  const peer = (mode: string) => writeFile(join(root, "config.mjs"), `export const config=${JSON.stringify({mode, observations})};`);
  await peer("exec-ok");
  const key = join(root, "product.key"), service = join(root, "service.json"), runtime = join(root, "runtime.json");
  await writeFile(key, "synthetic-product-key", { mode: 0o600 });
  await writeFile(service, JSON.stringify({ version: 1, executable, serviceApiKeyFile: key, model: "synthetic-model", maxRunMs: 10000,
    allowPaidCalls: true, allowDataTransfer: true, executionIsolationReviewed: true }), { mode: 0o600 });
  const value = { version: 1, enableDispatch: true, serviceCallVerified: true, serviceConfigFile: service,
    policyId: "synthetic-runtime-v1", allowedAccountIds: [randomUUID()] };
  const save = (data: unknown = value) => writeFile(runtime, JSON.stringify(data), { mode: 0o600 });
  await save();
  return { root, key, service, runtime, value, save, peer, observations,
    rows: async () => (await readFile(observations, "utf8")).trim().split("\n").map((line) => JSON.parse(line)) };
}

test("runtime is explicitly opt-in, loads no process and fails closed for malformed policy or account scope", async (t) => {
  const f = await files(t);
  assert.equal(await loadAiRuntime(undefined), undefined);
  await assert.rejects(loadAiRuntime(""));
  const runtime = await loadAiRuntime(f.runtime);
  assert.equal(runtime!.registration.config.mode, "codex");
  assert.deepEqual(runtime!.allowedAccountIds, f.value.allowedAccountIds);
  await assert.rejects(access(f.observations));
  for (const change of [{ version: 2 }, { enableDispatch: false }, { serviceCallVerified: false }, { enableDispatch: "true" },
    { allowedAccountIds: [] }, { allowedAccountIds: ["*"] }, { allowedAccountIds: [f.value.allowedAccountIds[0], f.value.allowedAccountIds[0]] },
    { allowedAccountIds: Array.from({ length: 21 }, () => randomUUID()) }, { policyId: "bad/policy" }, { serviceConfigFile: "relative" }, { key: "must-not-inline" }]) {
    await f.save({ ...f.value, ...change });
    await assert.rejects(loadAiRuntime(f.runtime), (error: any) => !error.message.includes(f.root) && !error.message.includes("must-not-inline"));
  }
  await f.save(); await chmod(f.runtime, 0o644);
  await assert.rejects(loadAiRuntime(f.runtime));
  await assert.rejects(access(f.observations));
});

test("account-scoped admission keeps histories, replay and cancellation available after access removal", async (t) => {
  const options = { aiConfig: config, aiAllowedAccounts: [] as string[] }, f = await fixture(options);
  t.after(() => f.cleanup());
  const a = await f.account(), b = await f.account();
  const job = (await (await f.post(jobInput, a.cookie)).json()).job;
  const other = (await (await f.post(jobInput, b.cookie)).json()).job;
  options.aiAllowedAccounts = [a.user.id]; await f.restart();
  options.aiAllowedAccounts.push(b.user.id); // The running HTTP router must keep its own scope snapshot.
  const base = `/api/jobs/${job.id}/ai-runs`, denied = `/api/jobs/${other.id}/ai-runs`;
  assert.deepEqual((await (await f.get(base, a.cookie)).json()).capability, { configured: true, mode: "synthetic" });
  assert.deepEqual((await (await f.get(denied, b.cookie)).json()).capability, { configured: false, mode: "disabled" });
  assert.equal((await f.postJson(denied, {}, b.cookie, { "Idempotency-Key": "denied-request" })).status, 503);
  assert.equal((await f.get(base, b.cookie)).status, 404);
  const run = await (await f.postJson(base, {}, a.cookie, { "Idempotency-Key": "enabled-request" })).json();
  options.aiAllowedAccounts = []; await f.restart();
  assert.equal((await f.postJson(base, {}, a.cookie, { "Idempotency-Key": "new-disabled-request" })).status, 503);
  const replay = await f.postJson(base, {}, a.cookie, { "Idempotency-Key": "enabled-request" });
  assert.equal(replay.status, 200); assert.equal((await replay.json()).run.id, run.run.id);
  assert.equal((await f.postJson(`${base}/${run.run.id}/cancel`, {}, a.cookie)).status, 200);
  assert.equal((await f.get(base, a.cookie)).status, 200);
});

test("queue rechecks a copied allowlist before running and never dispatches revoked queued work", async (t) => {
  const f = await fixture(), a = await f.account(), b = await f.account();
  const store = createStore(f.filename); let dispatches = 0;
  const allowed = [a.user.id];
  const queue = createAiQueue(store, { config, create: () => ({
    async run(id) { dispatches++; return { jobId: id, threadId: "synthetic-thread", turnId: "synthetic-turn", status: "completed",
      remoteStatus: "completed", code: null, text: "합성 초안", needsReview: true }; }, cancel() {}, async close() {},
  }) }, { pollMs: 10, allowedAccounts: allowed });
  t.after(async () => { await queue.stop(); store.close(); await f.cleanup(); });
  const other = (await (await f.post(jobInput, b.cookie)).json()).job;
  const job = (await (await f.post(jobInput, a.cookie)).json()).job;
  const denied = store.enqueueAi(b.user.id, other.id, "revoked-queued", config)!.run;
  const accepted = store.enqueueAi(a.user.id, job.id, "allowed-queued", config)!.run;
  allowed.push(b.user.id); // Mutating the caller's list must not broaden an already configured queue.
  queue.start();
  await until(() => store.aiStatus(accepted.id) === "completed");
  assert.equal(dispatches, 1);
  assert.equal(store.aiStatus(denied.id), "failed");
  assert.equal(store.aiRun(b.user.id, other.id, denied.id)!.run.code, "account_not_enabled");
  assert.equal(store.aiRun(b.user.id, other.id, denied.id)!.events.some((e) => e.status === "running"), false);
});

const serverScript = fileURLToPath(new URL("../src/server.ts", import.meta.url));
async function launch(root: string, runtime?: string, extra: Record<string, string> = {}) {
  const probe = createServer(); await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const port = (probe.address() as {port: number}).port; await new Promise<void>((done) => probe.close(() => done()));
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, PORT: String(port), HOST: "127.0.0.1", NODE_ENV: "test",
    OFFICE_DB_PATH: join(root, "office.sqlite"), OFFICE_INPUT_DIR: join(root, "input"), OFFICE_OUTPUT_DIR: join(root, "output"), ...extra };
  if (runtime !== undefined) env.OFFICE_AI_RUNTIME_CONFIG = runtime;
  const child = spawn(process.execPath, [serverScript], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = new Promise<number | null>((done) => child.on("exit", done));
  const url = `http://127.0.0.1:${port}`;
  try { await until(async () => child.exitCode === null && (await fetch(url + "/api/health").catch(() => null))?.ok, 10000); }
  catch { child.kill("SIGKILL"); await exited; throw new Error("합성 서버 시작 실패"); }
  return { url, output: () => output,
    async stop() {
      if (child.exitCode === null) child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      try { return await exited; } finally { clearTimeout(timer); }
    } };
}
async function account(url: string) {
  const response = await fetch(url + "/api/auth/register", { method: "POST", headers: {"Content-Type": "application/json", "X-Office-Request": "1"},
    body: JSON.stringify({ username: `synthetic_${randomUUID().replaceAll("-", "").slice(0, 16)}`, password: testPassword }) });
  assert.equal(response.status, 201);
  const value = await response.json(); return { id: value.user.id, cookie: cookie(response) };
}
const post = (url: string, path: string, value: string, body = {}, key = randomUUID()) => fetch(url + path, {
  method: "POST", headers: { cookie: value, "Content-Type": "application/json", "X-Office-Request": "1", "Idempotency-Key": key }, body: JSON.stringify(body),
});
const get = (url: string, path: string, value: string) => fetch(url + path, { headers: {cookie: value} }).then((r) => r.json());

test("invalid runtime stops the real entrypoint before database creation without exposing configuration", async (t) => {
  const f = await files(t), db = join(f.root, "must-not-create.sqlite");
  await f.save({ ...f.value, serviceCallVerified: false });
  await assert.rejects(promisify(execFile)(process.execPath, [serverScript], { env: { PATH: process.env.PATH,
    OFFICE_AI_RUNTIME_CONFIG: f.runtime, OFFICE_DB_PATH: db } }), (error: any) => error.code === 1
    && /AI 운영 설정 오류/.test(error.stderr) && !error.stderr.includes(f.root) && !error.stderr.includes("synthetic-product-key"));
  await assert.rejects(access(db)); await assert.rejects(access(f.observations));
});

test("real server composition defaults off and explicitly runs one account-owned synthetic peer task through review", async (t) => {
  const f = await files(t); let server = await launch(f.root, undefined, { OFFICE_AI_CONFIG: f.service, OPENAI_API_KEY: "synthetic-inherited-trap" });
  t.after(async () => { await server.stop(); });
  const a = await account(server.url), b = await account(server.url);
  const job = (await (await post(server.url, "/api/jobs", a.cookie, jobInput)).json()).job;
  const other = (await (await post(server.url, "/api/jobs", b.cookie, jobInput)).json()).job;
  const base = `/api/jobs/${job.id}/ai-runs`, denied = `/api/jobs/${other.id}/ai-runs`;
  assert.equal((await post(server.url, base, a.cookie)).status, 503);
  await assert.rejects(access(f.observations));
  assert.equal(await server.stop(), 0);
  await f.save({ ...f.value, allowedAccountIds: [a.id] }); server = await launch(f.root, f.runtime);
  assert.deepEqual((await get(server.url, base, a.cookie)).capability, { configured: true, mode: "codex" });
  assert.deepEqual((await get(server.url, denied, b.cookie)).capability, { configured: false, mode: "disabled" });
  assert.equal((await post(server.url, denied, b.cookie)).status, 503);
  const key = randomUUID(), responses = await Promise.all([post(server.url, base, a.cookie, {}, key), post(server.url, base, a.cookie, {}, key)]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 202]);
  const records = await Promise.all(responses.map((r) => r.json())); const id = records[0].run.id;
  assert.equal(records[1].run.id, id);
  await until(async () => (await get(server.url, `${base}/${id}`, a.cookie)).run.status === "completed");
  const result = await get(server.url, `${base}/${id}/result`, a.cookie);
  assert.equal(result.text, "합성 설문 요약 초안");
  assert.equal(result.needsReview, true);
  assert.equal((await post(server.url, `${base}/${id}/review`, a.cookie,
    { targetHash: result.reviewTargetHash, decision: "approved", comment: "합성 점검" } as any)).status, 201);
  assert.equal(await server.stop(), 0); server = await launch(f.root, f.runtime);
  assert.equal((await post(server.url, base, a.cookie, {}, key)).status, 200);
  assert.equal((await get(server.url, `${base}/${id}/review`, a.cookie)).decision.decision, "approved");
  assert.equal((await f.rows()).filter((r) => r.message?.method === "turn/start").length, 1);
  assert.equal(server.output().includes("synthetic-product-key"), false);
  assert.equal(await server.stop(), 0);
});

test("runtime cancellation and process shutdown keep durable terminal states without redispatch on restart", async (t) => {
  const f = await files(t); await f.peer("exec-hang");
  let server = await launch(f.root); t.after(async () => { await server.stop(); });
  const a = await account(server.url);
  const job = (await (await post(server.url, "/api/jobs", a.cookie, jobInput)).json()).job;
  await server.stop(); await f.save({ ...f.value, allowedAccountIds: [a.id] }); server = await launch(f.root, f.runtime);
  const base = `/api/jobs/${job.id}/ai-runs`;
  const first = (await (await post(server.url, base, a.cookie)).json()).run.id;
  await until(async () => (await f.rows().catch(() => [])).some((r) => r.message?.method === "turn/start"));
  assert.equal((await post(server.url, `${base}/${first}/cancel`, a.cookie)).status, 202);
  await until(async () => (await get(server.url, `${base}/${first}`, a.cookie)).run.status === "cancelled");
  assert.equal((await get(server.url, `${base}/${first}`, a.cookie)).run.remoteStatus, "interrupted");
  const second = (await (await post(server.url, base, a.cookie)).json()).run.id;
  await until(async () => (await f.rows()).filter((r) => r.message?.method === "turn/start").length === 2);
  assert.equal(await server.stop(), 0); server = await launch(f.root, f.runtime);
  const record = await get(server.url, `${base}/${second}`, a.cookie);
  assert.equal(record.run.status, "interrupted"); assert.equal(record.run.remoteStatus, "unknown");
  assert.equal(record.run.code, "server_stopped");
  await server.stop();
  assert.equal((await f.rows()).filter((r) => r.message?.method === "turn/start").length, 2);
  const db = new DatabaseSync(join(f.root, "office.sqlite"));
  assert.equal(db.prepare("PRAGMA quick_check").get()!.quick_check, "ok"); db.close();
});

test("listen failure shuts down both queues and redacts raw server diagnostics", async (t) => {
  const f = await files(t), occupied = createServer();
  await new Promise<void>((done) => occupied.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>((done) => occupied.close(() => done())));
  const port = (occupied.address() as {port: number}).port;
  await assert.rejects(promisify(execFile)(process.execPath, [serverScript], { timeout: 5000,
    env: { PATH: process.env.PATH, PORT: String(port), OFFICE_DB_PATH: join(f.root, "listen.sqlite"), OFFICE_AI_RUNTIME_CONFIG: f.runtime,
      OFFICE_INPUT_DIR: join(f.root, "input"), OFFICE_OUTPUT_DIR: join(f.root, "output") } }),
    (error: any) => error.code === 1 && /서버를 종료/.test(error.stderr) && !error.stderr.includes("EADDRINUSE") && !error.stderr.includes(f.root));
  await assert.rejects(access(f.observations));
});
