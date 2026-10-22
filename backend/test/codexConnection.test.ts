import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, writeFile, chmod, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexConnection, CodexConnectionError } from '../src/codex/connection.ts';
import { isInitializeResult } from '../src/codex/protocol.ts';

async function fixture(mode = 'ok', timeoutMs = 2000) {
  const root = await mkdtemp(join(tmpdir(), 'office-codex-fixture-'));
  const executable = join(root, 'codex.mjs'), observations = join(root, 'observations.jsonl');
  await copyFile(new URL('./fixtures/codex-server.mjs', import.meta.url), executable);
  await copyFile(new URL('./fixtures/codex-execution.mjs', import.meta.url), join(root, 'codex-execution.mjs'));
  const source = await readFile(executable, 'utf8');
  await writeFile(executable, `#!${process.execPath}\n${source}`);
  await chmod(executable, 0o700);
  await writeFile(join(root, 'config.mjs'), `export const config = ${JSON.stringify({ mode, observations })};\n`);
  const connection = new CodexConnection({ executable, timeoutMs });
  return {
    connection,
    async observations() {
      return (await readFile(observations, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    },
    async cleanup() { await connection.close(); await rm(root, { recursive: true, force: true }); },
  };
}

const code = (expected: string) => (error: unknown) => {
  assert.ok(error instanceof CodexConnectionError);
  assert.equal(error.code, expected);
  assert.equal(error.message.includes('synthetic-private-marker'), false);
  return true;
};

test('Codex private stdio initializes once, isolates environment and removes temporary state', async (t) => {
  const f = await fixture(); t.after(() => f.cleanup());
  process.env.OFFICE_SYNTHETIC_SECRET = 'synthetic-private-marker';
  try { await f.connection.start(); } finally { delete process.env.OFFICE_SYNTHETIC_SECRET; }
  assert.equal(f.connection.state, 'ready');
  await assert.rejects(f.connection.start(), code('closed'));
  // Wait for child to observe initialized; no work is requested.
  await new Promise((resolve) => setTimeout(resolve, 30));
  const observations = await f.observations();
  const launch = observations[0];
  assert.deepEqual(launch.args, ['app-server', '--listen', 'stdio://']);
  assert.deepEqual(launch.envKeys.sort(), ['CODEX_HOME', 'HOME', 'PATH', 'TMPDIR'].sort());
  assert.notEqual(launch.cwd, process.cwd());
  assert.notEqual(launch.codexHome, process.env.CODEX_HOME);
  const messages = observations.filter((row) => row.event === 'message').map((row) => row.message);
  assert.deepEqual(messages.map((message) => message.method), ['initialize', 'initialized']);
  assert.equal(messages[0].params.capabilities.experimentalApi, false);
  assert.equal(messages[0].params.capabilities.explicitGatewayOauth, true);
  await Promise.all([f.connection.close(), f.connection.close()]);
  assert.equal(f.connection.state, 'closed');
  await assert.rejects(access(launch.cwd));
});

for (const mode of ['version', 'malformed', 'utf8-invalid', 'large-line', 'flood', 'wrong-id', 'bad-schema', 'wrong-home', 'both', 'duplicate', 'error', 'crash', 'timeout', 'stubborn']) {
  test(`Codex rejects ${mode} without retrying or exposing remote data`, async (t) => {
    const f = await fixture(mode, ['timeout', 'stubborn'].includes(mode) ? 200 : 2000);
    t.after(() => f.cleanup());
    const expected = mode === 'version' ? 'version_mismatch' : mode === 'error' ? 'remote_error'
      : mode === 'crash' ? 'closed' : ['timeout', 'stubborn'].includes(mode) ? 'timeout' : 'protocol_error';
    await assert.rejects(f.connection.start(), code(expected));
    assert.equal(f.connection.state, 'closed');
    if (mode !== 'version') {
      const rows = await f.observations();
      assert.equal(rows.filter((row) => row.event === 'launch').length, 1);
      assert.equal(rows.filter((row) => row.message?.method === 'initialize').length, 1);
      await assert.rejects(access(rows[0].cwd));
    }
  });
}

test('Codex reassembles UTF-8 frames split across stdout chunks', async (t) => {
  const f = await fixture('split'); t.after(() => f.cleanup());
  await f.connection.start();
  assert.equal(f.connection.state, 'ready');
});

test('Codex refuses server tool approvals without echoing private parameters', async (t) => {
  const f = await fixture('approval'); t.after(() => f.cleanup());
  await f.connection.start();
  const rows = await f.observations();
  const reply = rows.find((row) => row.message?.id === 'tool')?.message;
  assert.deepEqual(reply, { id: 'tool', error: { code: -32601, message: 'Unsupported client request' } });
});

test('Codex close during initialization rejects pending call and cannot restart', async (t) => {
  const f = await fixture('timeout'); t.after(() => f.cleanup());
  const starting = f.connection.start();
  const rejection = assert.rejects(starting, code('closed'));
  await f.connection.close();
  await rejection;
  assert.equal(f.connection.state, 'closed');
  await assert.rejects(f.connection.start(), code('closed'));
});

test('Codex notices child closure after ready and does not reconnect', async (t) => {
  const f = await fixture('crash-ready'); t.after(() => f.cleanup());
  await f.connection.start();
  for (let i = 0; i < 100 && f.connection.state !== 'closed'; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.connection.state, 'closed');
  const rows = await f.observations();
  assert.equal(rows.filter((row) => row.event === 'launch').length, 1);
});

test('Codex configuration and required schema fields fail closed', () => {
  assert.throws(() => new CodexConnection({ executable: 'codex' }), code('configuration'));
  assert.throws(() => new CodexConnection({ executable: '/codex', timeoutMs: NaN }), code('configuration'));
  for (const value of [null, [], {}, { userAgent: 'a', codexHome: '/x', platformFamily: 'unix', platformOs: 1 }]) {
    assert.equal(isInitializeResult(value), false);
  }
});


test('Codex version subprocess has a hard deadline even if SIGTERM is ignored', async (t) => {
  const f = await fixture('version-hang', 500); t.after(() => f.cleanup());
  await assert.rejects(f.connection.start(), code('launch_failed'));
  assert.equal(f.connection.state, 'closed');
});

test('Codex missing executable fails with a sanitized error', async () => {
  const connection = new CodexConnection({ executable: '/nonexistent/office-synthetic-codex' });
  try { await assert.rejects(connection.start(), code('launch_failed')); }
  finally { await connection.close(); }
});

test('Codex close after initialize was sent cancels its pending response', async (t) => {
  const f = await fixture('timeout'); t.after(() => f.cleanup());
  const starting = f.connection.start();
  const rejected = assert.rejects(starting, code('closed'));
  let sent = false;
  for (let i = 0; i < 200; i++) {
    const rows = await f.observations().catch(() => []);
    if (rows.some((row) => row.message?.method === 'initialize')) { sent = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(sent, true);
  await f.connection.close();
  await rejected;
  const rows = await f.observations();
  assert.equal(rows.filter((row) => row.message?.method === 'initialize').length, 1);
  await assert.rejects(access(rows[0].cwd));
});


test('Codex close cancels the version process immediately without waiting for its deadline', { timeout: 2000 }, async (t) => {
  const f = await fixture('version-hang', 5000); t.after(() => f.cleanup());
  const pending = f.connection.start();
  const rejected = assert.rejects(pending, code('closed'));
  let observed = false;
  for (let i = 0; i < 200; i++) {
    if ((await f.observations().catch(() => [])).some((row) => row.event === 'version')) { observed = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(observed, true);
  await f.connection.close();
  await rejected;
});
