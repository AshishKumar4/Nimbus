import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { makeAsserter, stripAnsi } from '../../_driver.mjs';
import { scaffold } from '../../../../packages/cli/src/commands/scaffold.ts';
import { newSession } from '../../../../packages/cli/src/commands/session.ts';
import { issueNimbusToken } from '../../../../packages/sdk/src/token.ts';
import { NIMBUS_REQUIRED_ALIASES } from '../../../../packages/config/src/index.ts';

const a = makeAsserter('cli/new/scaffold-worker');
const root = mkdtempSync(join(tmpdir(), 'nimbus-scaffold-probe-'));
const project = join(root, 'worker');
const repo = new URL('../../../../', import.meta.url).pathname;
let child, socket, session, token, base;
let log = '';
async function capture(command, args) {
  const write = process.stdout.write;
  let stdout = '';
  process.stdout.write = (value) => { stdout += String(value); return true; };
  try { return { code: await command(args), stdout }; }
  finally { process.stdout.write = write; }
}
async function until(label, read, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const result = await read();
    if (result) return result;
    if (Date.now() >= deadline || (child && child.exitCode !== null)) throw new Error(`${label} failed: ${log.slice(-4000)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
try {
  const generated = await capture(scaffold, ['--name=scaffold-flow', '--template=worker-only', project]);
  a.check('the CLI accepts its documented flags and creates the Worker project', generated.code === 0);
  if (generated.code !== 0) throw new Error('scaffold failed');
  mkdirSync(join(project, 'node_modules'));
  symlinkSync(join(repo, 'packages/cli/node_modules/@nimbus-sh'), join(project, 'node_modules/@nimbus-sh'));
  for (const name of Object.keys(NIMBUS_REQUIRED_ALIASES)) {
    symlinkSync(join(repo, 'packages/worker/node_modules', name), join(project, 'node_modules', name));
  }
  const portServer = createServer();
  portServer.listen(0, '127.0.0.1');
  await once(portServer, 'listening');
  const port = portServer.address().port;
  await new Promise((resolve) => portServer.close(resolve));
  base = `http://127.0.0.1:${port}`;
  const secret = 'scaffold-probe-local-secret';
  token = await issueNimbusToken({ JWT_SECRET: secret }, { tn: 'scaffold', sub: 'tester' });
  child = spawn('node', [join(repo, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--port', String(port), '--var', `JWT_SECRET:${secret}`], {
    cwd: project, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const append = (chunk) => { log = (log + String(chunk)).slice(-32_000); };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.once('error', (error) => { append(error.message); });
  await until('generated Worker startup', async () => {
    try { return (await fetch(`${base}/`, { signal: AbortSignal.timeout(1000) })).status < 500; }
    catch (error) { if (error.code === 'ConnectionRefused' || error.code === 'ECONNREFUSED' || error.cause?.code === 'ECONNREFUSED' || error.name === 'TimeoutError') return false; throw error; }
  });
  const minted = await capture(newSession, [`--endpoint=${base}`, `--token=${token}`]);
  a.check('CLI session new talks to the generated Worker router', minted.code === 0);
  if (minted.code !== 0) throw new Error(`session creation failed: ${log.slice(-4000)}`);
  session = JSON.parse(minted.stdout);
  const output = [];
  socket = new WebSocket(`${base.replace('http:', 'ws:')}/s/${session.sessionId}/ws`, { headers: { Authorization: `Bearer ${token}` } });
  socket.on('message', (frame) => {
    const message = JSON.parse(frame.toString());
    if (message.type === 'output') output.push(message.data);
  });
  await Promise.race([once(socket, 'open'), new Promise((_, reject) => setTimeout(() => reject(new Error('generated Worker WebSocket did not open')), 30_000))]);
  socket.send(JSON.stringify({ type: 'input', data: 'node -e "console.log(6*7)"\r' }));
  await until('a Node command through the generated host registry', () => /(?:^|\n)42\r?\n/.test(stripAnsi(output.join(''))));
  a.check('the scaffold host classes run a real Node process and return its output', true);
} finally {
  if (socket && socket.readyState !== WebSocket.CLOSED) socket.close();
  try {
    if (session) {
      const response = await fetch(`${base}/s/${session.sessionId}/`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      const destroyed = await response.json();
      a.check('the scaffold session is destroyed through its public cleanup route', destroyed.ok === true && destroyed.result?.ok === true && typeof destroyed.result.destroyedAt === 'number');
    }
  } finally {
    if (child && child.exitCode === null) {
      const stopped = once(child, 'close');
      child.kill('SIGTERM');
      const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
      await stopped;
      clearTimeout(kill);
    }
    rmSync(root, { recursive: true, force: true });
  }
}
const result = a.summary();
process.exit(result.fail ? 1 : 0);
