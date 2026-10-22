import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexExecution, CodexExecutionError } from '../src/codex/execution.ts';

const policy = { allowPaidCalls: true, allowDataTransfer: true, executionIsolationReviewed: true,
  model: 'synthetic-model', maxRunMs: 5000 } as const;
async function fixture(mode = 'exec-ok', override: { maxRunMs?: number; requestTimeoutMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'office-execution-fixture-'));
  for (const filename of ['codex-server.mjs', 'codex-execution.mjs'])
    await copyFile(new URL('./fixtures/' + filename, import.meta.url), join(root, filename));
  const executable = join(root, 'codex-server.mjs'), observations = join(root, 'observations.jsonl');
  await writeFile(executable, `#!${process.execPath}\n${await readFile(executable, 'utf8')}`, { mode: 0o700 });
  // copyFile may create 0644, explicitly apply executable permission.
  const { chmod } = await import('node:fs/promises'); await chmod(executable, 0o700);
  await writeFile(join(root, 'config.mjs'), `export const config = ${JSON.stringify({ mode, observations })};`);
  const session = new CodexExecution({ executable, serviceApiKey: 'synthetic-service-key',
    policy: { ...policy, maxRunMs: override.maxRunMs ?? policy.maxRunMs },
    requestTimeoutMs: override.requestTimeoutMs ?? 2000, interruptGraceMs: 500 });
  return {
    session,
    async rows() { return (await readFile(observations, 'utf8')).trim().split('\n').map((row) => JSON.parse(row)); },
    async cleanup() { await session.close(); await rm(root, { recursive: true, force: true }); },
  };
}
const messages = (rows: any[]) => rows.filter((row) => row.event === 'message').map((row) => row.message);
async function until(check: () => Promise<boolean>) {
  for (let n = 0; n < 200; n++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('synthetic protocol event was not observed');
}

test('single Codex task authenticates explicitly, maps IDs and returns only reviewed final text', async (t) => {
  const f = await fixture(); t.after(() => f.cleanup());
  const pending = f.session.run('job-one', '합성 입력 3행');
  assert.equal(f.session.run('job-one', '합성 입력 3행'), pending);
  await assert.rejects(f.session.run('job-two', '합성 입력 3행'), { code: 'conflict' });
  await assert.rejects(f.session.run('job-one', 'changed'), { code: 'conflict' });
  const result = await pending;
  assert.deepEqual(result, { jobId: 'job-one', threadId: 'synthetic-thread', turnId: 'synthetic-turn',
    status: 'completed', remoteStatus: 'completed', text: '합성 설문 요약 초안', needsReview: true, code: null });
  assert.equal(f.session.run('job-one', '합성 입력 3행'), pending);
  await assert.rejects(access((await f.rows())[0].cwd));
  const rpc = messages(await f.rows());
  assert.deepEqual(rpc.map((r) => r.method), ['initialize', 'initialized', 'account/login/start', 'account/read', 'thread/start', 'turn/start']);
  assert.equal(new Set(rpc.filter((r) => r.id).map((r) => r.id)).size, 5);
  assert.equal(rpc.find((r) => r.method === 'thread/start').params.ephemeral, true);
  assert.deepEqual(rpc.find((r) => r.method === 'turn/start').params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.equal(JSON.stringify(await f.rows()).includes('synthetic-service-key'), false);
  assert.deepEqual(f.session.events.map((e) => e.state), ['starting', 'running', 'completed']);
  assert.equal(JSON.stringify(f.session.events).includes('합성 입력'), false);
  const copy = f.session.events; copy[0].jobId = 'tampered';
  assert.equal(f.session.events[0].jobId, 'job-one');
});

for (const [mode, status, code] of [
  ['exec-early', 'completed', null], ['exec-retry', 'completed', null], ['exec-terminal-start', 'completed', null],
  ['exec-auth-error', 'failed', 'remote_error'], ['exec-no-auth', 'failed', 'authentication_required'],
  ['exec-wrong-model', 'failed', 'policy_mismatch'], ['exec-bad-policy', 'failed', 'protocol_error'],
  ['exec-invalid-event', 'failed', 'invalid_event'], ['exec-turn-mismatch', 'failed', 'turn_mismatch'],
  ['exec-unsupported', 'failed', 'unsupported_item'], ['exec-error', 'failed', 'turn_error'],
  ['exec-commentary', 'failed', 'invalid_result'], ['exec-empty', 'failed', 'invalid_result'],
  ['exec-item-conflict', 'failed', 'item_conflict'], ['exec-long-text', 'failed', 'invalid_item'],
  ['exec-approval', 'failed', 'approval_required'], ['exec-failed', 'failed', 'turn_failed'],
  ['exec-crash', 'failed', 'closed'], ['exec-buffer-limit', 'failed', 'event_limit'],
] as const) {
  test(`Codex task handles ${mode} without replaying start or exposing remote errors`, async (t) => {
    const f = await fixture(mode); t.after(() => f.cleanup());
    const result = await f.session.run('job-one', '합성 입력');
    assert.equal(result.status, status); assert.equal(result.code, code);
    assert.equal(JSON.stringify(result).includes('synthetic-secret-error'), false);
    if (status === 'failed') { assert.equal(result.text, null); assert.equal(result.needsReview, false); }
    const rpc = messages(await f.rows());
    assert.ok(rpc.filter((r) => r.method === 'turn/start').length <= 1);
    if (['exec-no-auth', 'exec-auth-error', 'exec-wrong-model', 'exec-bad-policy'].includes(mode))
      assert.equal(rpc.some((r) => r.method === 'turn/start'), false);
    assert.equal(f.session.events.filter((e) => ['completed', 'failed'].includes(e.state)).length, 1);
  });
}

test('Codex turn interrupt is idempotent and only a terminal notification confirms interruption', async (t) => {
  const f = await fixture('exec-hang'); t.after(() => f.cleanup());
  const result = f.session.run('job-one', '합성 입력');
  await until(async () => messages(await f.rows().catch(() => [])).some((r) => r.method === 'turn/start'));
  f.session.cancel('job-one'); f.session.cancel('job-one');
  const ended = await result;
  assert.equal(ended.status, 'cancelled'); assert.equal(ended.remoteStatus, 'interrupted');
  assert.equal(ended.code, null); assert.equal(ended.text, null);
  assert.equal(messages(await f.rows()).filter((r) => r.method === 'turn/interrupt').length, 1);
});

test('Codex cancellation before start acknowledgment interrupts once the turn ID arrives', async (t) => {
  const f = await fixture('exec-delayed-start'); t.after(() => f.cleanup());
  const pending = f.session.run('job-one', '합성 입력');
  await until(async () => messages(await f.rows().catch(() => [])).some((r) => r.method === 'turn/start'));
  f.session.cancel('job-one');
  assert.equal((await pending).remoteStatus, 'interrupted');
  assert.equal(messages(await f.rows()).filter((r) => r.method === 'turn/start').length, 1);
});

test('Codex cancellation acknowledgment alone is not confirmation of remote cancellation', async (t) => {
  const f = await fixture('exec-interrupt-hang'); t.after(() => f.cleanup());
  const pending = f.session.run('job-one', '합성 입력');
  await until(async () => messages(await f.rows().catch(() => [])).some((r) => r.method === 'turn/start'));
  f.session.cancel('job-one');
  const result = await pending;
  assert.equal(result.status, 'cancelled'); assert.equal(result.remoteStatus, 'unknown');
  assert.equal(result.code, 'interrupt_unconfirmed');
});

test('Codex run wall clock is bounded and a lost start response is never retried', async (t) => {
  for (const mode of ['exec-hang', 'exec-rpc-timeout']) {
    const f = await fixture(mode, { maxRunMs: mode === 'exec-hang' ? 1500 : 3000, requestTimeoutMs: 1000 });
    t.after(() => f.cleanup());
    const result = await f.session.run('job-one', '합성 입력');
    assert.equal(result.status, mode === 'exec-hang' ? 'timed_out' : 'failed');
    assert.equal(result.code, mode === 'exec-hang' ? 'run_timeout' : 'timeout');
    assert.equal(result.remoteStatus, 'unknown');
    assert.equal(messages(await f.rows()).filter((r) => r.method === 'turn/start').length, 1);
  }
});

test('Codex cancellation before sending a turn stops local setup without a model call', async (t) => {
  const f = await fixture(); t.after(() => f.cleanup());
  const pending = f.session.run('job-one', '합성 입력'); f.session.cancel('job-one');
  const result = await pending;
  assert.equal(result.status, 'cancelled'); assert.equal(result.turnId, null);
});

test('Codex execution requires explicit deployment policy and rejects invalid input before launch', async (t) => {
  for (const field of ['allowPaidCalls', 'allowDataTransfer', 'executionIsolationReviewed', 'model'] as const) {
    assert.throws(() => new CodexExecution({ executable: '/codex', serviceApiKey: 'synthetic-key',
      policy: { ...policy, [field]: field === 'model' ? '' : false } as any }), CodexExecutionError);
  }
  const f = await fixture(); t.after(() => f.cleanup());
  await assert.rejects(f.session.run('bad/id', '합성'), { code: 'configuration' });
  await assert.rejects(f.session.run('job', 'x'.repeat(17000)), { code: 'configuration' });
  await f.session.close();
  await assert.rejects(f.session.run('job', '합성'), { code: 'closed' });
});


test('Codex completion racing with cancellation preserves remote completion and discards output', async (t) => {
  const f = await fixture('exec-cancel-completes'); t.after(() => f.cleanup());
  const pending = f.session.run('job-one', '합성 입력');
  await until(async () => messages(await f.rows().catch(() => [])).some((r) => r.method === 'turn/start'));
  f.session.cancel('job-one');
  const result = await pending;
  assert.equal(result.status, 'cancelled'); assert.equal(result.remoteStatus, 'completed');
  assert.equal(result.text, null); assert.equal(result.needsReview, false);
});
