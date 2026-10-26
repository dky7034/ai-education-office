import { test } from "node:test";
import assert from "node:assert/strict";
import { access, chmod, copyFile, link, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { loadServiceConfig } from "../src/codex/serviceConfig.ts";
import { checkService, SERVICE_CHECK_PROMPT } from "../src/codex/serviceCheck.ts";

async function fixture(t: { after: (fn: () => Promise<void>) => void }, mode = "exec-ok") {
  const root = await mkdtemp(join(tmpdir(), "office-service-check-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ["codex-server.mjs", "codex-execution.mjs"])
    await copyFile(new URL(`./fixtures/${name}`, import.meta.url), join(root, name));
  const executable = join(root, "codex-server.mjs"), observations = join(root, "observations.jsonl");
  await writeFile(executable, `#!${process.execPath}\n${await readFile(executable, "utf8")}`, { mode: 0o700 });
  await chmod(executable, 0o700);
  await writeFile(join(root, "config.mjs"), `export const config = ${JSON.stringify({ mode, observations })};`);
  const key = join(root, "service.key"), path = join(root, "service.json");
  await writeFile(key, "synthetic-private-key\n", { mode: 0o600 });
  const config = { version: 1, executable, serviceApiKeyFile: key, model: "synthetic-model", maxRunMs: 5000,
    allowPaidCalls: true, allowDataTransfer: true, executionIsolationReviewed: true };
  const save = (value: unknown = config) => writeFile(path, JSON.stringify(value), { mode: 0o600 });
  await save();
  return { root, key, path, config, observations, save,
    rows: async () => (await readFile(observations, "utf8")).trim().split("\n").map((row) => JSON.parse(row)) };
}

test("offline product configuration validates private files without launching even the version command", async (t) => {
  const f = await fixture(t);
  assert.equal((await loadServiceConfig(f.path)).serviceApiKey, "synthetic-private-key");
  const result = await checkService([], f.path);
  assert.equal(result.exitCode, 0); assert.match(result.message, /호출 없음/); assert.match(result.message, /미검증/);
  assert.equal(result.message.includes(f.root), false); assert.equal(result.message.includes("synthetic-private-key"), false);
  await assert.rejects(access(f.observations));
});

test("configuration fails closed for incomplete policy, unknown fields, wrong types and limits", async (t) => {
  const f = await fixture(t);
  for (const field of ["allowPaidCalls", "allowDataTransfer", "executionIsolationReviewed"]) {
    for (const value of [false, "true", 1, null]) {
      await f.save({ ...f.config, [field]: value });
      await assert.rejects(loadServiceConfig(f.path), { code: "policy_required" });
    }
  }
  for (const change of [{ version: 2 }, { model: "bad model" }, { maxRunMs: 49 }, { maxRunMs: 120001 },
    { maxRunMs: "5000" }, { executable: "relative" }, { serviceApiKey: "must-not-inline" }]) {
    await f.save({ ...f.config, ...change });
    await assert.rejects(loadServiceConfig(f.path), { code: "config_schema" });
  }
  await writeFile(f.path, "not-json");
  await assert.rejects(loadServiceConfig(f.path), { code: "config_schema" });
  await writeFile(f.path, "x".repeat(8193));
  await assert.rejects(loadServiceConfig(f.path), { code: "config_file" });
  await assert.rejects(access(f.observations));
});

test("private configuration/key reject public permissions, links, directories and invalid keys without revealing paths or contents", async (t) => {
  const f = await fixture(t);
  for (const [path, code] of [[f.path, "config_file"], [f.key, "key_file"]] as const) {
    await chmod(path, 0o644);
    await assert.rejects(loadServiceConfig(f.path), { code });
    await chmod(path, 0o600);
    const alias = `${path}.alias`;
    await link(path, alias);
    await assert.rejects(loadServiceConfig(f.path), { code });
    await rm(alias);
    await symlink(path, alias);
    if (path === f.path) await assert.rejects(loadServiceConfig(alias), { code });
    else {
      await f.save({ ...f.config, serviceApiKeyFile: alias });
      await assert.rejects(loadServiceConfig(f.path), { code });
      await f.save();
    }
    await rm(alias);
  }
  await f.save({ ...f.config, serviceApiKeyFile: f.root });
  await assert.rejects(loadServiceConfig(f.path), { code: "key_file" });
  await f.save();
  for (const key of ["", " ", "key\n\n", "key\r", "key\0", "key\ttext", " key", "x".repeat(4097)]) {
    await writeFile(f.key, key);
    assert.equal((await checkService([], f.path)).exitCode, 1);
  }
  await writeFile(f.key, "x".repeat(4096) + "\r\n");
  assert.equal((await loadServiceConfig(f.path)).serviceApiKey.length, 4096);
  await writeFile(f.key, Buffer.from([0xff]));
  await assert.rejects(loadServiceConfig(f.path), { code: "key_file" });
  const fifo = join(f.root, "key-fifo");
  await promisify(execFile)("mkfifo", [fifo]);
  await f.save({ ...f.config, serviceApiKeyFile: fifo });
  await assert.rejects(loadServiceConfig(f.path), { code: "key_file" });
  await f.save();
  await writeFile(f.key, "synthetic-private-key");
  await chmod(f.config.executable, 0o600);
  await assert.rejects(loadServiceConfig(f.path), { code: "executable" });
  const result = await checkService([], f.path);
  assert.equal(JSON.stringify(result).includes(f.root), false);
  assert.equal(JSON.stringify(result).includes("synthetic-private-key"), false);
  await assert.rejects(access(f.observations));
});

test("single opt-in synthetic process run redacts output and uses the fixed prompt with one turn and cleanup", async (t) => {
  const f = await fixture(t);
  const result = await checkService(["--execute"], f.path);
  assert.equal(result.exitCode, 0); assert.match(result.message, /검수 필요/); assert.match(result.message, /서버 실행은 계속 비활성/);
  const rows = await f.rows(), messages = rows.filter((row) => row.event === "message").map((row) => row.message);
  assert.equal(messages.filter((m) => m.method === "turn/start").length, 1);
  assert.equal(messages.filter((m) => m.method === "account/login/start").length, 1);
  assert.deepEqual(rows[0].envKeys.sort(), ["HOME", "CODEX_HOME", "PATH", "TMPDIR"].sort());
  await assert.rejects(access(rows[0].cwd));
  for (const secret of ["synthetic-private-key", "합성 설문 요약 초안", "synthetic-thread", "synthetic-turn", f.root, SERVICE_CHECK_PROMPT])
    assert.equal(JSON.stringify(result).includes(secret), false);
});

test("authentication failure and timeout do not retry or report success or leak diagnostics", async (t) => {
  for (const mode of ["exec-auth-error", "exec-hang"]) {
    const f = await fixture(t, mode);
    if (mode === "exec-hang") await f.save({ ...f.config, maxRunMs: 1500 });
    const result = await checkService(["--execute"], f.path);
    assert.equal(result.exitCode, 1); assert.match(result.message, /자동 재전송 없음/);
    assert.equal(JSON.stringify(result).includes("synthetic-secret-error"), false);
    const messages = (await f.rows()).filter((row) => row.event === "message").map((row) => row.message);
    assert.equal(messages.filter((m) => m.method === "turn/start").length, mode === "exec-hang" ? 1 : 0);
  }
});

test("abort before launch sends no request; abort during execution confirms interruption and cleans up", async (t) => {
  const f = await fixture(t, "exec-hang"), controller = new AbortController();
  assert.equal((await checkService(["--execute"], f.path, AbortSignal.abort())).exitCode, 1);
  await assert.rejects(access(f.observations));
  const pending = checkService(["--execute"], f.path, controller.signal);
  let started = false;
  for (let i = 0; i < 200; i++) {
    if ((await f.rows().catch(() => [])).some((r) => r.message?.method === "turn/start")) { started = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(started, true);
  controller.abort();
  const result = await pending;
  assert.equal(result.exitCode, 1); assert.match(result.message, /cancelled/); assert.match(result.message, /interrupted/);
  const rows = await f.rows();
  assert.equal(rows.filter((r) => r.message?.method === "turn/interrupt").length, 1);
  await assert.rejects(access(rows[0].cwd));
});

test("operator CLI refuses unknown arguments and missing explicit configuration; never uses inherited auth", async (t) => {
  const f = await fixture(t);
  assert.equal((await checkService(["--execute", "extra"], f.path)).exitCode, 1);
  const script = fileURLToPath(new URL("../../scripts/check-ai.mts", import.meta.url));
  const run = promisify(execFile);
  await assert.rejects(run(process.execPath, [script], { env: { PATH: process.env.PATH, OPENAI_API_KEY: "synthetic-inherited-trap" } }),
    (error: any) => error.code === 1 && /OFFICE_AI_CONFIG/.test(error.stderr) && !error.stderr.includes("synthetic-inherited-trap"));
  const output = await run(process.execPath, [script], { env: { PATH: process.env.PATH, OFFICE_AI_CONFIG: f.path } });
  assert.match(output.stdout, /호출 없음/);
  assert.equal(output.stderr, "");
  await assert.rejects(access(f.observations));
});
