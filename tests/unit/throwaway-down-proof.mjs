#!/usr/bin/env bun
// The public throwaway `down` command keeps its signing receipt until the
// Cloudflare API proves the Preview is absent. Wrangler and the command run
// unchanged; only their Cloudflare API requests reach the fixture server.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..');
const ACCOUNT = 'proof-account';
const TOKEN = 'proof-api-token';
const PREVIEW = 'tw-down-proof';
const NAME = 'nimbus-' + PREVIEW;
const PREVIEW_PATH = `/client/v4/accounts/${ACCOUNT}/workers/workers/nimbus-probe-previews/previews/${PREVIEW}`;
const present = { status: 200, body: { success: true, result: { id: 'preview-id', name: PREVIEW }, errors: [] } };
const absent = { status: 404, body: { success: false, result: null, errors: [{ code: 10025, message: 'Preview not found' }] } };
const rejected = (status, code) => ({ status, body: { success: false, result: null, errors: [{ code, message: 'Fixture rejection' }] } });
const transport = { transport: true };

const root = mkdtempSync(join(tmpdir(), 'throwaway-down-proof-'));
const failures = [];
let answer = present;
let afterDelete = absent;
let events = [];
const server = createServer((request, response) => {
  if (request.url === '/preview-hostname') {
    events.push('hostname');
    response.writeHead(404).end();
    return;
  }
  assert.ok([PREVIEW_PATH, PREVIEW_PATH + '/deployments/latest'].includes(request.url), `all Cloudflare calls address only the fixture Preview, not ${request.url}`);
  assert.equal(request.headers.authorization, 'Bearer ' + TOKEN);
  events.push(request.method);
  if (request.method === 'DELETE') {
    answer = afterDelete;
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: true, result: null, errors: [] }));
    return;
  }
  assert.equal(request.method, 'GET');
  if (answer.transport) {
    request.socket.destroy();
    return;
  }
  if (answer.stall) return;
  response.writeHead(answer.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(answer.body));
}).listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

try {
  for (const dir of ['tests/behavioral', 'apps/probe', 'apps/hosted-demo', '.wrangler/throwaway-targets', 'tmp']) mkdirSync(join(root, dir), { recursive: true });
  for (const file of ['_throwaway-target.mjs', '_deploy-target.mjs']) copyFileSync(join(REPO, 'tests/behavioral', file), join(root, 'tests/behavioral', file));
  for (const file of ['_driver.mjs', '_mint-probe-token.mjs', '_ledger.mjs', '_session-transport.mjs']) symlinkSync(join(REPO, 'tests/behavioral', file), join(root, 'tests/behavioral', file));
  for (const dir of ['scripts', 'packages', 'node_modules', 'apps/probe/node_modules', 'apps/hosted-demo/node_modules']) symlinkSync(join(REPO, dir), join(root, dir));
  copyFileSync(join(REPO, 'apps/probe/wrangler.jsonc'), join(root, 'apps/probe/wrangler.jsonc'));
  writeFileSync(join(root, 'drive.mjs'), `
const realFetch = globalThis.fetch;
const origin = ${JSON.stringify(origin)};
// FIXTURE_UNRESOLVED: how many API calls this host's resolver cannot make (getaddrinfo EAI_AGAIN).
let unresolved = Number(process.env.FIXTURE_UNRESOLVED ?? 0);
globalThis.fetch = (input, options) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin === 'https://api.cloudflare.com' && unresolved > 0) {
    unresolved--;
    return Promise.reject(Object.assign(new TypeError('getaddrinfo EAI_AGAIN api.cloudflare.com'), { code: 'EAI_AGAIN' }));
  }
  if (url.origin === 'https://api.cloudflare.com') return realFetch(origin + url.pathname + url.search, options);
  if (url.origin === origin) return realFetch(input, options);
  throw new Error('unexpected external request to ' + url.origin);
};
await import('./tests/behavioral/_throwaway-target.mjs');
`);
  const receipt = join(root, '.wrangler/throwaway-targets', NAME + '.json');
  const deleted = join(root, 'state/nimbus/deleted-previews.json');
  const recorded = JSON.stringify({ name: NAME, preview: PREVIEW, base: origin + '/preview-hostname', secret: 'the-held-signing-secret', secretPushed: true, createdAt: '2026-10-07T00:00:00.000Z' });
  const run = (command = 'down', { args = [], unresolved = 0, timeoutMs = 120_000 } = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['drive.mjs', command, '--name', NAME, ...args], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FIXTURE_UNRESOLVED: String(unresolved), CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_API_BASE_URL: origin + '/client/v4', XDG_STATE_HOME: join(root, 'state'), TMPDIR: join(root, 'tmp'), WRANGLER_SEND_METRICS: 'false' },
    });
    let output = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; stderr += chunk; });
    // A hang fails here, not in the runner: the child is killed and the run rejected.
    const deadline = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`drive.mjs ${command} did not end within ${timeoutMs} ms:\n${output}`)); }, timeoutMs);
    child.on('error', reject);
    child.on('close', (status, signal) => {
      clearTimeout(deadline);
      if (signal) reject(new Error(`drive.mjs ${command} ended by ${signal}:\n${output}`));
      else resolve({ status, output, stderr });
    });
  });

  const unknown = [
    ['HTTP 401', rejected(401, 10000)],
    ['HTTP 429', rejected(429, 10100)],
    ['HTTP 500', rejected(500, 10000)],
    ['HTTP 404', rejected(404, 10007)],
    ['HTTP 401', rejected(401, 10025)],
    ['transport error', transport],
  ];
  const cases = [
    { name: 'deleted: exact Preview-not-found', before: present, after: absent, confirmed: true },
    { name: 'already absent', before: absent, after: absent, confirmed: true },
    { name: 'still exists', before: present, after: present, confirmed: false, detail: 'HTTP 200' },
    ...unknown.flatMap(([detail, response]) => [
      { name: 'lookup: ' + detail + (response.body?.errors[0].code === 10025 ? ' with 10025' : ''), before: response, after: absent, confirmed: false, detail },
      { name: 'confirmation: ' + detail + (response.body?.errors[0].code === 10025 ? ' with 10025' : ''), before: present, after: response, confirmed: false, detail },
    ]),
  ];
  for (const test of cases) {
    events = [];
    answer = test.before;
    afterDelete = test.after;
    rmSync(deleted, { force: true });
    writeFileSync(receipt, recorded, { mode: 0o600 });
    const result = await run();
    try {
      if (test.confirmed) {
        assert.equal(result.status, 0, result.output);
        assert.equal(existsSync(receipt), false, 'only confirmed deletion releases the signing receipt');
        if (test.before === present) {
          const tombstone = JSON.parse(readFileSync(deleted, 'utf8')).previews[0];
          assert.equal(tombstone.preview, PREVIEW);
          assert.equal(tombstone.id, 'preview-id');
          assert.equal(tombstone.base, origin + '/preview-hostname');
        } else {
          assert.equal(existsSync(deleted), false, 'an already absent Preview creates no new deletion record');
        }
      } else {
        assert.notEqual(result.status, 0, result.output);
        assert.equal(readFileSync(receipt, 'utf8'), recorded, 'an unconfirmed deletion preserves the exact receipt and secret');
        assert.equal(existsSync(deleted), false, 'an unconfirmed deletion is not recorded as a deleted Preview');
        assert.ok(result.output.includes(NAME) && result.output.includes(test.detail), result.output);
        assert.ok(!events.includes('hostname'), 'a hostname 404 cannot stand in for the API proof');
        if (test.before !== present) assert.ok(!events.includes('DELETE'), 'an unknown lookup does not delete a target');
      }
      if (test.before === present) assert.ok(events.includes('DELETE'), 'the real wrangler command called the fixture Cloudflare API');
      console.log('  ok  ' + test.name);
    } catch (error) {
      failures.push(`${test.name}: ${error.message}\n${result.output}`);
    }
  }
  // A command that fails says why on its last line: what a caller that keeps only the tail quotes.
  answer = transport;
  const unread = await run('version');
  const lastLine = unread.stderr.trimEnd().split('\n').at(-1);
  assert.notEqual(unread.status, 0, unread.output);
  assert.match(lastLine, /^version failed: \S/, `the cause is the last line, not ${JSON.stringify(lastLine)}`);
  console.log('  ok  a failed read ends with its cause: ' + lastLine);

  // A read the resolver could not make is made again until its caller's deadline; any other failure is not.
  const latest = { status: 200, body: { success: true, result: { id: 'deployment-id' }, errors: [] } };
  answer = latest;
  const resolved = await run('version', { args: ['--until', String(Date.now() + 30_000)], unresolved: 1 });
  assert.equal(resolved.status, 0, resolved.output);
  assert.match(resolved.output, /deployment-id/, 'read again once the resolver answers');
  const pastDeadline = await run('version', { unresolved: 1 });
  assert.notEqual(pastDeadline.status, 0, 'with no deadline left, the read fails');
  assert.match(pastDeadline.stderr.trimEnd().split('\n').at(-1), /^version failed: getaddrinfo EAI_AGAIN/, pastDeadline.output);
  answer = rejected(401, 10000);
  events = [];
  const refused = await run('version', { args: ['--until', String(Date.now() + 30_000)] });
  assert.notEqual(refused.status, 0, 'an answer the API gave is not read again');
  assert.equal(events.filter((e) => e === 'GET').length, 1, 'a refusal is asked once');
  answer = transport;
  events = [];
  const dropped = await run('version', { args: ['--until', String(Date.now() + 30_000)] });
  assert.notEqual(dropped.status, 0, 'a connection dropped after it reached the API is not read again');
  assert.equal(events.filter((e) => e === 'GET').length, 1, 'a dropped connection is asked once');
  // The deadline bounds each attempt too: an answer that never comes ends with it.
  answer = { stall: true };
  const stalled = await run('version', { args: ['--until', String(Date.now() + 3_000)], timeoutMs: 20_000 });
  assert.notEqual(stalled.status, 0, 'a read that does not answer by the deadline fails, at its deadline');
  answer = latest;
  const malformed = await run('version', { args: ['--until', 'Infinity'], unresolved: 1, timeoutMs: 20_000 });
  assert.match(malformed.stderr.trimEnd().split('\n').at(-1), /^version failed: --until takes a time in epoch ms/, malformed.output);
  console.log('  ok  only a read the resolver could not make is made again, until its deadline');

  // A failed command leaves a usable receipt: its next down can finish.
  answer = present;
  afterDelete = absent;
  const retried = await run();
  assert.equal(retried.status, 0, retried.output);
  assert.equal(existsSync(receipt), false, 'the retained receipt is released only after a successful retry');
  assert.deepEqual(failures, [], 'Preview deletion requires 404/code 10025, preserving signing receipts on every other answer');
} finally {
  server.closeAllConnections();
  server.close();
  rmSync(root, { recursive: true, force: true });
}
console.log('throwaway-down-proof OK');
