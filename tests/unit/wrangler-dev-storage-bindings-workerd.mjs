// @serial
// @tier slow — drives a local workerd
// A user Worker under Nimbus's `wrangler dev` uses its KV, D1 and R2
// bindings as on Cloudflare, checked as a differential: the same Worker
// (tests/behavioral/wrangler/new/_storage-bindings-worker.mjs) runs with
// real local bindings (Miniflare, the workerd embedding `wrangler dev` runs
// a Worker in on a workstation: workerd's own KV, D1 and R2 clients over
// Cloudflare's local stores) and under Nimbus on the real workerd
// (lib/workerd-probe.mjs: apps/probe, its session Durable Object, the LOADER
// that makes the inner Worker), and both must answer exactly what the shared
// file records, but for the difference it names (nimbusAnswer). Covered:
// KV get (each type, bulk), put (each value, metadata, expiry), delete, list
// (pages) and getWithMetadata; D1 prepare, bind (each type), first, all,
// run, raw, batch (and its rollback), exec, withSession, the statement's
// fields, errors and meta fields; R2 put (each value, metadata, checksums,
// conditions), head, get (ranges, conditions), the body methods,
// writeHttpMetadata, list (pages, delimiter, include, startAfter) and
// delete; validation errors of each; and what a later request reads.
//
// Before: the binding was a class instance in the loader's env, and the
// build failed with "Could not serialize object of type "D1Emulator"".
//
// Runs the worker built in the tree: rebuild the generated artifacts before
// testing a change (dist-integrity).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { startLocalProbe } from './lib/workerd-probe.mjs';
import { WORKER, WRANGLER_CONFIG, expectedAnswer, nimbusAnswer } from '../behavioral/wrangler/new/_storage-bindings-worker.mjs';

const STEPS = [1, 2];

/**
 * Runs WORKER under Miniflare with WRANGLER_CONFIG's bindings, in Node (the
 * runtime it supports), and answers the JSON of each step's GET, in order.
 */
async function withLocalBindings() {
  const miniflare = createRequire(createRequire(import.meta.url).resolve('wrangler/package.json')).resolve('miniflare');
  const dir = mkdtempSync(join(tmpdir(), 'nimbus-storage-bindings-'));
  // Miniflare's own options for one Worker, as `wrangler dev` makes them from the config.
  const options = {
    name: WRANGLER_CONFIG.name,
    modules: true,
    script: WORKER,
    compatibilityDate: WRANGLER_CONFIG.compatibility_date,
    kvNamespaces: Object.fromEntries(WRANGLER_CONFIG.kv_namespaces.map((b) => [b.binding, b.id])),
    d1Databases: Object.fromEntries(WRANGLER_CONFIG.d1_databases.map((b) => [b.binding, b.database_id])),
    r2Buckets: Object.fromEntries(WRANGLER_CONFIG.r2_buckets.map((b) => [b.binding, b.bucket_name])),
  };
  writeFileSync(join(dir, 'run.mjs'), `import { Miniflare, convertV4MiniflareOptions } from ${JSON.stringify(pathToFileURL(miniflare).href)};
const mf = new Miniflare(convertV4MiniflareOptions(${JSON.stringify(options)}));
try {
  const answers = [];
  for (const step of ${JSON.stringify(STEPS)}) {
    const response = await mf.dispatchFetch('http://localhost/?step=' + step);
    const body = await response.text();
    if (response.status !== 200) throw new Error('step ' + step + ': ' + response.status + ' ' + body);
    answers.push(JSON.parse(body));
  }
  process.stdout.write(JSON.stringify(answers));
} finally {
  await mf.dispose();
}
`);
  const child = spawn('node', [join(dir, 'run.mjs')], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
  try {
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 0, `Miniflare exited ${code}:\n${stderr.slice(-4000)}`);
    return JSON.parse(stdout);
  } finally {
    clearTimeout(timer);
    rmSync(dir, { recursive: true, force: true });
  }
}

// Cloudflare's answers: the shared file records them.
const local = await withLocalBindings();
for (const [index, step] of STEPS.entries()) {
  assert.deepEqual(local[index], expectedAnswer(step), `local bindings answer step ${step} as the shared file records\n${JSON.stringify(local[index])}`);
}

console.log('wrangler-dev-storage-bindings-workerd: starting local workerd');
const probe = await startLocalProbe({ runtimes: [] });
process.env.BASE = probe.base;
process.env.NIMBUS_PROBE_TOKEN = probe.token;
const { mintSession, deleteSession, Terminal, requestHeaders, stripAnsi } = await import('../behavioral/_driver.mjs');
const sid = await mintSession();
const terminal = new Terminal(sid);
try {
  await terminal.connect();
  await terminal.waitForPrompt(60_000);
  await terminal.run('mkdir -p /home/user/storage/src', 10_000);
  const write = async (path, content) => {
    const response = await fetch(`${probe.base}/s/${sid}/api/write-file`, {
      method: 'POST',
      headers: requestHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ path, content }),
    });
    assert.equal(response.status, 200, `write ${path}: ${await response.text()}`);
  };
  await write('/home/user/storage/wrangler.jsonc', JSON.stringify(WRANGLER_CONFIG));
  await write('/home/user/storage/src/index.js', WORKER);
  await terminal.run('cd /home/user/storage', 10_000);
  terminal.reset();
  terminal.cmd('wrangler dev');
  await terminal.waitFor((b) => /Worker built|Failed to start/.test(stripAnsi(b)), 120_000, 'wrangler dev build');
  assert.match(stripAnsi(terminal.buf), /Worker built/, stripAnsi(terminal.buf).slice(-1500));
  for (const step of STEPS) {
    const response = await fetch(`${probe.base}/s/${sid}/worker/?step=${step}`, { headers: requestHeaders() });
    const body = await response.text();
    assert.equal(response.status, 200, body.slice(0, 1500));
    assert.match(response.headers.get('content-type') ?? '', /^application\/json/, `step ${step} answered ${response.headers.get('content-type')}: ${body.slice(0, 1500)}\n${stripAnsi(terminal.buf).slice(-1500)}`);
    const answer = JSON.parse(body);
    assert.deepEqual(answer, nimbusAnswer(expectedAnswer(step)), `Nimbus answers step ${step} as Cloudflare does\n${body}`);
  }
  terminal.send('\x03');
  await terminal.waitForPrompt(30_000);
} finally {
  await terminal.close().catch(() => {});
  await deleteSession(sid).catch(() => {});
  await probe.stop();
}
console.log('wrangler-dev-storage-bindings-workerd: KV, D1 and R2 under wrangler dev answer as local bindings do');
