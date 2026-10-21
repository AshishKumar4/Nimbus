#!/usr/bin/env bun
// The public throwaway `up` command, after `wrangler preview` reports a
// deployment, reads the Preview's latest deployment until the API serves it,
// for as long as the upload took. When it never does, it uploads once more, saying so;
// when that one does not land either, the command fails saying what the API
// served instead, or that the API answered nothing in time, never with the
// abort of its own deadline. A Preview the command created keeps its
// signing secret through a miss, so a later `up` of the name, after the
// upload landed late, redeploys it instead of refusing a name it holds no
// secret for. The command runs unchanged in a checkout of its own; `wrangler
// preview` there is a stand-in that reports a deployment, numbered by the
// uploads, and the command's Cloudflare API requests reach the fixture server.
// Under no parent Worker at all, `up` makes the parent before it asks
// whether the Preview stands, as the API answers that read with the
// Worker's absence (10007) until there is one.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBoundedProcess } from '../../scripts/lib/bounded-process.mjs';

const REPO = join(import.meta.dirname, '..', '..');
const ACCOUNT = 'proof-account';
const TOKEN = 'proof-api-token';
const PREVIEW = 'tw-up-settle';
const NAME = 'nimbus-' + PREVIEW;
const PARENT_PATH = `/client/v4/accounts/${ACCOUNT}/workers/workers/nimbus-probe-previews`;
const PRESENCE_PATH = `${PARENT_PATH}/previews/${PREVIEW}`;
const LATEST_PATH = `${PRESENCE_PATH}/deployments/latest`;
const ABSENT = { success: false, result: null, errors: [{ code: 10025, message: 'no such Preview' }] };
const ok = (result) => ({ success: true, result, errors: [] });

/**
 * What the API answers for the Preview and its latest deployment: `stale`
 * (the deployment before), `silent` once an upload is in (no answer),
 * `second-lands` (the deployment before until the second upload, then that),
 * `new` (no Preview: 404), `landed` (the last upload), `presence-500` (the
 * Preview read fails), `latest-500` (it stands, and its latest read fails),
 * or `no-parent` (no parent Worker until `up` makes one, then no Preview
 * until the upload lands).
 */
let mode = 'stale';
let parentMade = false;
const NO_WORKER = { success: false, result: null, errors: [{ code: 10007, message: 'This Worker does not exist on your account.' }] };
let latestReads = 0;
let checkout = null;
const uploads = () => { try { return Number(readFileSync(join(checkout, 'uploads'), 'utf8')); } catch { return 0; } };
const unexpected = [];
const server = createServer((request, response) => {
  const json = (status, body) => response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  const parent = mode !== 'no-parent' || parentMade;
  if (request.method === 'GET' && request.url === PARENT_PATH) {
    return parent ? json(200, ok({ subdomain: { enabled: true, previews_enabled: true } })) : json(404, NO_WORKER);
  }
  if (request.method === 'POST' && request.url === `/client/v4/accounts/${ACCOUNT}/workers/workers` && mode === 'no-parent') {
    parentMade = true;
    return json(200, ok({ id: 'nimbus-probe-previews' }));
  }
  if (request.method === 'GET' && request.url === PRESENCE_PATH) {
    if (!parent) return json(404, NO_WORKER);
    if (mode === 'no-parent') return json(404, ABSENT);
    if (mode === 'presence-500') return json(500, { success: false, result: null, errors: [{ code: 10013, message: 'an internal error' }] });
    return mode === 'new' ? json(404, ABSENT) : json(200, ok({ id: 'preview-id' }));
  }
  if (request.method === 'GET' && request.url === LATEST_PATH) {
    latestReads++;
    // The first read is the one before the upload; it always answers.
    if (mode === 'silent' && latestReads > 1) return;
    if (mode === 'latest-500') return json(500, { success: false, result: null, errors: [{ code: 10013, message: 'an internal error' }] });
    if (mode === 'new' || (mode === 'no-parent' && uploads() === 0)) return json(404, ABSENT);
    if (mode === 'landed' || mode === 'no-parent' || (mode === 'second-lands' && uploads() >= 2)) return json(200, ok({ id: `deployment-uploaded-${uploads()}`, startup_time_ms: 5 }));
    return json(200, ok({ id: 'deployment-before', startup_time_ms: 5 }));
  }
  unexpected.push(`${request.method} ${request.url}`);
  return json(404, { success: false, result: null, errors: [{ code: 10000, message: 'not in the fixture' }] });
}).listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const root = mkdtempSync(join(tmpdir(), 'throwaway-up-settle-'));
checkout = join(root, 'checkout');
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
  // A checkout of its own: the deploy scripts as they are, the two app configs
  // and the probe target vars, and the repository's code and dependencies linked in. Its upload reads
  // apps/probe and packages/worker/public, so those are its own and committed.
  for (const dir of ['tests/behavioral', 'apps/probe', 'apps/hosted-demo', 'tmp']) mkdirSync(join(checkout, dir), { recursive: true });
  for (const file of ['_throwaway-target.mjs', '_deploy-target.mjs']) copyFileSync(join(REPO, 'tests/behavioral', file), join(checkout, 'tests/behavioral', file));
  for (const file of ['_driver.mjs', '_mint-probe-token.mjs', '_ledger.mjs', '_session-transport.mjs']) symlinkSync(join(REPO, 'tests/behavioral', file), join(checkout, 'tests/behavioral', file));
  for (const app of ['probe', 'hosted-demo']) {
    copyFileSync(join(REPO, 'apps', app, 'wrangler.jsonc'), join(checkout, 'apps', app, 'wrangler.jsonc'));
    symlinkSync(join(REPO, 'apps', app, 'node_modules'), join(checkout, 'apps', app, 'node_modules'));
  }
  copyFileSync(join(REPO, 'apps/probe/probe-target-vars.json'), join(checkout, 'apps/probe/probe-target-vars.json'));
  symlinkSync(join(REPO, 'scripts'), join(checkout, 'scripts'));
  linkEntries('packages', ['worker']);
  linkEntries('packages/worker', ['public']);
  mkdirSync(join(checkout, 'packages/worker/public'));
  writeFileSync(join(checkout, 'packages/worker/public/.keep'), '');
  linkEntries('node_modules', ['.bin']);
  linkEntries('node_modules/.bin', ['wrangler']);
  // `wrangler preview` stands in reporting a deployment, as the real one prints it, numbered by the uploads.
  writeFileSync(join(checkout, 'node_modules/.bin/wrangler'), `#!/bin/sh
[ "$1" = preview ] || exit 1
# Failing before its deployment, as wrangler does when it cannot assemble one: no id, no secret sent.
[ -f '${join(checkout, 'noid')}' ] && { echo 'wrangler failed before its deployment' >&2; exit 1; }
n=$(( $(cat '${join(checkout, 'uploads')}' 2>/dev/null || echo 0) + 1 ))
echo $n > '${join(checkout, 'uploads')}'
echo '{"deployment":{"id":"deployment-uploaded-'$n'"},"preview":{"urls":["https://${PREVIEW}-nimbus-probe-previews.proof.workers.dev"]}}'
`);
  chmodSync(join(checkout, 'node_modules/.bin/wrangler'), 0o755);
  writeFileSync(join(checkout, '.gitignore'), 'node_modules\n.wrangler\ntmp\nstate\ndrive.mjs\nuploads\n');
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
  const recordPath = join(checkout, '.wrangler/throwaway-targets', NAME + '.json');
  const holdSecret = () => {
    mkdirSync(join(checkout, '.wrangler/throwaway-targets'), { recursive: true });
    writeFileSync(recordPath, JSON.stringify({
      name: NAME, preview: PREVIEW, parent: 'nimbus-probe-previews', base: null, secret: 'the-held-signing-secret', secretPushed: true, createdAt: '2026-10-17T00:00:00.000Z',
    }), { mode: 0o600 });
  };
  const record = () => JSON.parse(readFileSync(recordPath, 'utf8'));
  holdSecret();
  writeFileSync(join(checkout, 'drive.mjs'), `
const realFetch = globalThis.fetch;
const origin = ${JSON.stringify(origin)};
globalThis.fetch = (input, options) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin === 'https://api.cloudflare.com') return realFetch(origin + url.pathname + url.search, options);
  // A landed Preview's readiness is past what this test proves: up ends there, its record written.
  if (url.hostname.endsWith('.proof.workers.dev')) { console.error('readiness: past the fixture'); process.exit(3); }
  throw new Error('unexpected external request to ' + url.origin);
};
await import('./tests/behavioral/_throwaway-target.mjs');
`);
  // Bounded, so a wait that never ends fails here and the fixture is still cleaned up.
  const up = () => runBoundedProcess(process.execPath, ['drive.mjs', 'up', '--name', NAME, '--bundle', release], {
    cwd: checkout,
    timeoutMs: 180_000,
    name: 'throwaway up',
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: TOKEN, XDG_STATE_HOME: join(checkout, 'state'), TMPDIR: join(checkout, 'tmp'), WRANGLER_SEND_METRICS: 'false' },
  });

  // No parent Worker at all: up makes it before it asks whether the Preview stands.
  {
    mode = 'no-parent';
    rmSync(recordPath, { force: true });
    rmSync(join(checkout, 'uploads'), { force: true });
    const { code, stdout, stderr } = await up();
    const output = `${stdout}${stderr}`;
    assert.equal(code, 3, `up reaches readiness\n${output}`);
    assert.match(output, /creating the Preview parent Worker nimbus-probe-previews/, `it makes the parent\n${output}`);
    assert.match(output, /deployment deployment-uploaded-1 is live/, `and deploys the Preview, new\n${output}`);
    console.log('  ok  no parent Worker: up makes it, then deploys the Preview');
    // The cases below redeploy a Preview this checkout holds the secret of.
    holdSecret();
    rmSync(join(checkout, 'uploads'), { force: true });
  }

  for (const [name, settled, expected] of [
    ['the API keeps serving the deployment before', 'stale', /did not land, twice: [\d.]+ s, as long as the upload took after it, the API serves deployment-before as the latest, not deployment-uploaded-\d/],
    ['the API answers no read in time', 'silent', /did not land, twice: the API answered no read of its latest deployment within [\d.]+ s, as long as the upload took/],
  ]) {
    mode = settled;
    latestReads = 0;
    const started = Date.now();
    const { code, signal, reason, stdout, stderr } = await up();
    const output = `${stdout}${stderr}`;
    assert.ok(code !== 0 && code !== null && signal === null, `${name}: up fails by itself, in time (${reason})\n${output}`);
    assert.match(output, /WARNING: Preview tw-up-settle of nimbus-probe-previews did not land: .*Uploading it once more\./, `${name}: up says it uploads once more\n${output}`);
    assert.match(output, expected, `${name}: up says what the API served\n${output}`);
    assert.doesNotMatch(output, /AbortError|TimeoutError|operation was aborted/, `${name}: never its own deadline's abort\n${output}`);
    // The read before the uploads, and at least one after each.
    assert.ok(latestReads >= 3, `${name}: it read after each upload (${latestReads} reads)`);
    console.log(`  ok  ${name}: up fails saying so, after ${Math.round((Date.now() - started) / 1000)} s and ${latestReads} reads`);
  }

  // The first upload does not land and the second does: up goes on with the second.
  {
    mode = 'second-lands';
    rmSync(join(checkout, 'uploads'), { force: true });
    const { code, stdout, stderr } = await up();
    const output = `${stdout}${stderr}`;
    assert.equal(code, 3, `up reaches readiness\n${output}`);
    assert.match(output, /WARNING: .*did not land: [\d.]+ s, as long as the upload took after it, the API serves deployment-before as the latest, not deployment-uploaded-1.*Uploading it once more/, `the first miss is said\n${output}`);
    assert.match(output, /deployment deployment-uploaded-2 is live at https:\/\/tw-up-settle-nimbus-probe-previews\.proof\.workers\.dev/, `up goes on with the second upload\n${output}`);
    assert.deepEqual([record().versionId, record().secret], ['deployment-uploaded-2', 'the-held-signing-secret'], 'and records it, with the secret it held');
    console.log('  ok  a second upload that lands: up goes on with it');
  }

  // The API errs on whether the Preview stands, or on its latest deployment:
  // up refuses, uploading nothing, rather than read an error as absence.
  for (const [settled, expected] of [
    ['presence-500', /cannot tell whether Preview tw-up-settle stands: Preview tw-up-settle: HTTP 500/],
    ['latest-500', /the latest deployment of Preview tw-up-settle answered HTTP 500/],
  ]) {
    mode = settled;
    const held = record();
    const before = uploads();
    const { code, stdout, stderr } = await up();
    const output = `${stdout}${stderr}`;
    assert.ok(code !== 0 && code !== 3, `${settled}: up refuses\n${output}`);
    assert.match(output, expected, `${settled}: up says why\n${output}`);
    assert.equal(uploads(), before, `${settled}: and uploads nothing`);
    assert.deepEqual(record(), held, `${settled}: and changes no record`);
    console.log(`  ok  ${settled}: up refuses, uploading nothing`);
  }

  // A new Preview whose uploads fail before their deployment (no id): nothing
  // proves a secret reached it, so none is recorded as pushed.
  {
    mode = 'new';
    rmSync(recordPath, { force: true });
    writeFileSync(join(checkout, 'noid'), '');
    const { stdout, stderr } = await up();
    rmSync(join(checkout, 'noid'));
    const output = `${stdout}${stderr}`;
    assert.match(output, /did not land, twice: `wrangler preview` reported no deployment id/, output);
    assert.equal(record().secretPushed, false, 'no secret is recorded as pushed by an upload that reported no deployment');
    console.log('  ok  a new Preview whose uploads fail before deploying: no secret recorded as pushed');
  }

  // A Preview this run creates, whose uploads land only after up gave up:
  // the next up of the name keeps the secret those uploads carried.
  {
    mode = 'new';
    rmSync(recordPath, { force: true });
    rmSync(join(checkout, 'uploads'), { force: true });
    const missed = await up();
    assert.match(`${missed.stdout}${missed.stderr}`, /did not land, twice: [\d.]+ s, as long as the upload took after it, the API serves no deployment as the latest/, `${missed.stdout}${missed.stderr}`);
    const kept = record();
    assert.equal(kept.secretPushed, true, 'the secret of a Preview this run created is kept through the miss');
    mode = 'landed';
    const { code, stdout, stderr } = await up();
    const output = `${stdout}${stderr}`;
    assert.equal(code, 3, `up reaches readiness\n${output}`);
    assert.doesNotMatch(output, /no live signing secret/, `the next up does not refuse the name\n${output}`);
    assert.match(output, /deployment deployment-uploaded-3 is live/, `it redeploys it\n${output}`);
    assert.equal(record().secret, kept.secret, 'with the secret its uploads carried');
    console.log('  ok  a new Preview that lands late: the next up redeploys it with its secret');
  }
  assert.deepEqual(unexpected, [], 'up asked the API nothing else');
} finally {
  server.close();
  server.closeAllConnections();
  rmSync(root, { recursive: true, force: true });
}
console.log('throwaway-up-settle: ok');
