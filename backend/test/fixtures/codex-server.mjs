// Synthetic process only: no network, real credentials, model or filesystem tools.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { config } from './config.mjs';
if (config.mode === 'version-hang' && process.argv.includes('--version')) {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else if (process.argv.includes('--version')) {
  console.log(config.mode === 'version' ? 'codex-cli 0.164.0' : 'codex-cli 0.163.0');
  process.exit(0);
}
if (config.mode === 'version-hang') await new Promise(() => {});
appendFileSync(config.observations, JSON.stringify({
  event: 'launch', args: process.argv.slice(2), cwd: process.cwd(),
  envKeys: Object.keys(process.env), home: process.env.HOME, codexHome: process.env.CODEX_HOME,
}) + '\n');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const result = () => ({ userAgent: '합성 Codex', codexHome: process.env.CODEX_HOME,
  platformFamily: 'unix', platformOs: 'linux', futureField: true });
const respond = () => send({ id: 1, result: result() });
if (config.mode === 'stubborn') process.on('SIGTERM', () => {});
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  appendFileSync(config.observations, JSON.stringify({ event: 'message', message }) + '\n');
  if (message.method === 'initialized' && config.mode === 'crash-ready') process.exit(1);
  if (message.id === 'tool' && message.error?.code === -32601) respond();
  if (message.method !== 'initialize') return;
  if (config.mode === 'timeout' || config.mode === 'stubborn') return;
  if (config.mode === 'crash') process.exit(1);
  if (config.mode === 'malformed') { process.stdout.write('{bad\n'); return; }
  if (config.mode === 'utf8-invalid') { process.stdout.write(Buffer.from([0xff, 10])); return; }
  if (config.mode === 'large-line') { process.stdout.write('x'.repeat(65537)); return; }
  if (config.mode === 'flood') {
    process.stdout.write((JSON.stringify({ method: 'synthetic', params: 'x'.repeat(60000) }) + '\n').repeat(20));
    return;
  }
  if (config.mode === 'error') { send({ id: 1, error: { code: -1, message: 'synthetic-private-marker' } }); return; }
  if (config.mode === 'wrong-id') { send({ id: 99, result: result() }); return; }
  if (config.mode === 'bad-schema') { send({ id: 1, result: { ...result(), platformOs: null } }); return; }
  if (config.mode === 'wrong-home') { send({ id: 1, result: { ...result(), codexHome: '/different' } }); return; }
  if (config.mode === 'both') { send({ id: 1, result: result(), error: {} }); return; }
  if (config.mode === 'duplicate') {
    process.stdout.write([JSON.stringify({ id: 1, result: result() }), JSON.stringify({ id: 1, result: result() }), ''].join('\n'));
    return;
  }
  if (config.mode === 'approval') {
    send({ id: 'tool', method: 'item/commandExecution/requestApproval', params: { command: 'synthetic-private-marker' } });
    return;
  }
  if (config.mode === 'split') {
    const bytes = Buffer.from(JSON.stringify({ id: 1, result: result() }) + '\n');
    for (let offset = 0; offset < bytes.length; offset++) setTimeout(() => process.stdout.write(bytes.subarray(offset, offset + 1)), offset);
    return;
  }
  process.stderr.write('synthetic-private-marker\n'.repeat(10000));
  send({ method: 'synthetic/notification', params: { ignored: true } });
  respond();
});
