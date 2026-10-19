#!/usr/bin/env bun
// @tier slow — waits out the 30 s an upload has to show as a Preview's latest, twice
//
// The public throwaway `up` command, after `wrangler preview` reports a
// deployment, reads the Preview's latest deployment until the API serves it
// or 30 s have passed. When it never does, the command fails saying what the
// API served instead, or that the API answered nothing in time, never with
// the abort of its own deadline. The command runs unchanged in a checkout of
// its own; `wrangler preview` there is a stand-in that reports a deployment,
// and the command's Cloudflare API requests reach the fixture server.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..');
const ACCOUNT = 'proof-account';
const TOKEN = 'proof-api-token';
const PREVIEW = 'tw-up-settle';
const NAME = 'nimbus-' + PREVIEW;
const PARENT_PATH = `/client/v4/accounts/${ACCOUNT}/workers/workers/nimbus-probe-previews`;
const LATEST_PATH = `${PARENT_PATH}/previews/${PREVIEW}/deployments/latest`;
const ok = (result) => ({ success: true, result, errors: [] });

/** What the API answers for the Preview's latest deployment: `stale` (the deployment before), or `silent` once the upload is in (no answer). */
let mode = 'stale';
let latestReads = 0;
const unexpected = [];
const server = createServer((request, response) => {
  const json = (status, body) => response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  if (request.method === 'GET' && request.url === PARENT_PATH) return json(200, ok({ subdomain: { enabled: true, previews_enabled: true } }));
  if (request.method === 'GET' && request.url === LATEST_PATH) {
    latestReads++;
    // The first read is the one before the upload; it always answers.
    if (mode === 'silent' && latestReads > 1) return;
    return json(200, ok({ id: 'deployment-before', startup_time_ms: 5 }));
  }
  unexpected.push(`${request.method} ${request.url}`);
  return json(404, { success: false, result: null, errors: [{ code: 10000, message: 'not in the fixture' }] });
}).listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const root = mkdtempSync(join(tmpdir(), 'throwaway-up-settle-'));
const checkout = join(root, 'checkout');
const git = (...args) => {
  const done = spawnSync('git', args, { cwd: checkout, encoding: 'utf8' });
  assert.equal(done.status, 0, `git ${args.join(' ')}: ${done.stderr}`);
  return done.stdout.trim();
};
/** `dir` in the checkout as a directory of links to the repository's own entries, except `except`. */
const linkEntries = (dir, except = []) => {
  mkdirSync(join(checkout, dir), { recursive: true });
  for (const entry of readdirSync(join(REPO, dir))) if (!except.includes(entry)) symlinkSync(join(REPO, dir, entry), join(checkout, dir, entry));
};

try {
  // A checkout of its own: the deploy scripts as they are, the two app configs,
  // and the repository's code and dependencies linked in. Its upload reads
  // apps/probe and packages/worker/public, so those are its own and committed.
  for (const dir of ['tests/behavioral', 'apps/probe', 'apps/hosted-demo', 'tmp']) mkdirSync(join(checkout, dir), { recursive: true });
  for (const file of ['_throwaway-target.mjs', '_deploy-target.mjs']) copyFileSync(join(REPO, 'tests/behavioral', file), join(checkout, 'tests/behavioral', file));
  for (const file of ['_driver.mjs', '_mint-probe-token.mjs', '_ledger.mjs', '_session-transport.mjs']) symlinkSync(join(REPO, 'tests/behavioral', file), join(checkout, 'tests/behavioral', file));
  for (const app of ['probe', 'hosted-demo']) {
    copyFileSync(join(REPO, 'apps', app, 'wrangler.jsonc'), join(checkout, 'apps', app, 'wrangler.jsonc'));
    symlinkSync(join(REPO, 'apps', app, 'node_modules'), join(checkout, 'apps', app, 'node_modules'));
  }
  symlinkSync(join(REPO, 'scripts'), join(checkout, 'scripts'));
  linkEntries('packages', ['worker']);
  linkEntries('packages/worker', ['public']);
  mkdirSync(join(checkout, 'packages/worker/public'));
  writeFileSync(join(checkout, 'packages/worker/public/.keep'), '');
  linkEntries('node_modules', ['.bin']);
  linkEntries('node_modules/.bin', ['wrangler']);
  // `wrangler preview` stands in reporting a deployment, as the real one prints it.
  writeFileSync(join(checkout, 'node_modules/.bin/wrangler'), `#!/bin/sh
[ "$1" = preview ] || exit 1
echo '{"deployment":{"id":"deployment-uploaded"},"preview":{"urls":["https://${PREVIEW}-nimbus-probe-previews.proof.workers.dev"]}}'
`);
  chmodSync(join(checkout, 'node_modules/.bin/wrangler'), 0o755);
  writeFileSync(join(checkout, '.gitignore'), 'node_modules\n.wrangler\ntmp\nstate\ndrive.mjs\n');
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=proof', '-c', 'user.email=proof@proof', 'commit', '-qm', 'the checkout up uploads from');

  // A release of that commit, as CI keeps one.
  const release = join(root, 'release');
  mkdirSync(release);
  const module = 'export default { fetch() { return new Response("proof"); } };\n';
  writeFileSync(join(release, 'apps-probe.js'), module);
  writeFileSync(join(release, 'release.json'), JSON.stringify({
    commit: git('rev-parse', 'HEAD'), job: 'proof', assets: {},
    bundles: { 'apps/probe': { main: 'index.js', file: 'apps-probe.js', sha256: createHash('sha256').update(module).digest('hex') } },
  }));
  // This checkout already holds the Preview's secret, so `up` may redeploy it.
  mkdirSync(join(checkout, '.wrangler/throwaway-targets'), { recursive: true });
  writeFileSync(join(checkout, '.wrangler/throwaway-targets', NAME + '.json'), JSON.stringify({
    name: NAME, preview: PREVIEW, parent: 'nimbus-probe-previews', base: null, secret: 'the-held-signing-secret', secretPushed: true, createdAt: '2026-10-17T00:00:00.000Z',
  }), { mode: 0o600 });
  writeFileSync(join(checkout, 'drive.mjs'), `
const realFetch = globalThis.fetch;
const origin = ${JSON.stringify(origin)};
globalThis.fetch = (input, options) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin === 'https://api.cloudflare.com') return realFetch(origin + url.pathname + url.search, options);
  throw new Error('unexpected external request to ' + url.origin);
};
await import('./tests/behavioral/_throwaway-target.mjs');
`);
  const up = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['drive.mjs', 'up', '--name', NAME, '--bundle', release], {
      cwd: checkout,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: TOKEN, XDG_STATE_HOME: join(checkout, 'state'), TMPDIR: join(checkout, 'tmp'), WRANGLER_SEND_METRICS: 'false' },
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, output }));
  });

  for (const [name, settled, expected] of [
    ['the API keeps serving the deployment before', 'stale', /did not land: 30 s after the upload, the API serves deployment-before as the latest, not deployment-uploaded/],
    ['the API answers no read in time', 'silent', /did not land: the API answered no read of its latest deployment within 30 s of the upload/],
  ]) {
    mode = settled;
    latestReads = 0;
    const started = Date.now();
    const { status, output } = await up();
    assert.notEqual(status, 0, `${name}: up fails\n${output}`);
    assert.match(output, expected, `${name}: up says what the API served\n${output}`);
    assert.doesNotMatch(output, /AbortError|TimeoutError|operation was aborted/, `${name}: never its own deadline's abort\n${output}`);
    assert.ok(Date.now() - started >= 30_000, `${name}: it waited the 30 s out`);
    if (settled === 'stale') assert.ok(latestReads > 3, `${name}: it kept reading until the deadline (${latestReads} reads)`);
    console.log(`  ok  ${name}: up fails saying so, after ${Math.round((Date.now() - started) / 1000)} s and ${latestReads} reads`);
  }
  assert.deepEqual(unexpected, [], 'up asked the API nothing else');
} finally {
  server.close();
  server.closeAllConnections();
  rmSync(root, { recursive: true, force: true });
}
console.log('throwaway-up-settle: ok');
