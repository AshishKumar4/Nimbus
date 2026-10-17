// @serial
// @tier slow — drives a local workerd
// A guest reaches no more of the platform's RPC classes than their intended
// methods. Workers RPC exposes every string-named method of a WorkerEntrypoint,
// RpcTarget or Durable Object to whoever holds its stub; TypeScript `private`
// and a leading underscore hide nothing there. Through real Workers RPC, in
// workerd, a guest holding each class as a guest is given it calls its
// intended methods, which work, and each of its other methods, which are not
// there to call and reach nothing:
//
//   - CirrusHmrRPC (the real-Vite resident's env.CIRRUS_HMR). Red before:
//     `_stub()` answered the session's stub and its raw dispatch, and the
//     guest's dispatch acted as the kernel.
//   - SupervisorRPC (every process's env.SUPERVISOR). Red before: `_op` sent
//     any operation the session answers, past the wrapper that stamps its
//     arguments; `_network` answered the process's network unrecorded.
//   - NimbusLoaderRPC, NimbusLoadedWorker, NimbusLoadedEntrypoint (a
//     wrangler-dev guest's worker_loaders binding, and what it hands back).
//     Red before: `_props` answered the props it was minted with (its egress
//     among them), `_resolveEntrypoint` the raw loaded entrypoint.
//   - HostedSession (a scoped session an embedder's client holds). Red
//     before: `client()` answered the unscoped runtime it serves.
//   - NimbusFsJournalReader (an ended process's journal, held by the drain).
//     Red before: `journal()` answered functions that append to it.
//   - ProcessSupervisor (a one-shot's SUPERVISOR), NimbusLoadedWorker,
//     NimbusAssetsRPC, NimbusDurableObjectNamespace and NimbusDOStub: their
//     fields and other names answer nothing either.
//   - NimbusAssetsRPC reads as the process the host minted it for. Red
//     before: it read every asset as the session's user.
//   - NimbusKVNamespace, NimbusD1Binding, NimbusR2Bucket (a wrangler-dev
//     guest's KV, D1 and R2 bindings): each call reaches the session for the
//     store the binding was minted for, KV and R2 as the process the host
//     named, and they have no method but Cloudflare's API.
//
// "Not callable" is workerd's own refusal of a method the class does not
// have, never an error a method that was there threw.
//
// Runs lib/rpc-surface-workerd-entry.ts, bundled from source.

import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { wranglerNodeBuiltins } from './lib/wrangler-node-builtins.mjs';

const REPO = resolve(import.meta.dirname, '../..');
const DEADLINE_MS = 30_000;

const dir = mkdtempSync(join(tmpdir(), 'nimbus-rpc-private-surface-'));
const bundled = await build({
  entryPoints: [join(import.meta.dirname, 'lib/rpc-surface-workerd-entry.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  keepNames: true,
  mainFields: ['module', 'main'],
  conditions: ['workerd', 'worker', 'import'],
  external: ['cloudflare:*', 'node:*'],
  nodePaths: [join(REPO, 'packages/worker/node_modules')],
  write: false,
  logLevel: 'error',
  plugins: [wranglerNodeBuiltins],
});
writeFileSync(join(dir, 'main.js'), bundled.outputFiles[0].text);

const require = createRequire(import.meta.url);
const workerd = createRequire(require.resolve('wrangler/package.json'))('workerd').default;
const free = net.createServer();
const listening = Promise.withResolvers();
free.listen(0, '127.0.0.1', listening.resolve);
await listening.promise;
const port = free.address().port;
const closed = Promise.withResolvers();
free.close(closed.resolve);
await closed.promise;
writeFileSync(join(dir, 'config.capnp'), `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "main", worker = (
      modules = [(name = "main.js", esModule = embed "main.js")],
      compatibilityDate = "2026-09-26",
      compatibilityFlags = ["enable_request_signal"],
      durableObjectStorage = (localDisk = "store"),
      durableObjectNamespaces = [
        (className = "Session", uniqueKey = "rpc-private-surface", enableSql = true),
        (className = "NimbusFsJournalReader", uniqueKey = "rpc-private-surface-reader", enableSql = true),
      ],
      bindings = [
        (name = "NIMBUS_SESSION", durableObjectNamespace = "Session"),
        (name = "READER", durableObjectNamespace = "NimbusFsJournalReader"),
        (name = "LOADER", workerLoader = ()),
      ],
    )),
    (name = "store", disk = (path = ${JSON.stringify(join(dir, 'store'))}, writable = true)),
  ],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")],
);`);
mkdirSync(join(dir, 'store'));
const child = spawn(workerd, ['serve', 'config.capnp', '--experimental'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
child.stdout.on('data', (d) => { logs += d; });
child.stderr.on('data', (d) => { logs += d; });

async function get(path, params = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}?${new URLSearchParams(params)}`, { signal: AbortSignal.timeout(DEADLINE_MS) });
  return response.json();
}
/** The guest holding `session`'s `kind` calls `method`(...args), with a Request last when `withRequest`. */
const asGuest = (session, method, args = [], kind = 'CirrusHmrRPC', withRequest = false) =>
  get('/call', { session, method, args: JSON.stringify(args), class: kind, ...(withRequest ? { request: '1' } : {}) });
const asked = (session) => get('/asked', { session });

/**
 * Each of `kind`'s `others` is no method a guest holding it can call, and
 * calling it reaches nothing of the session's.
 */
async function nothingElse(kind, others) {
  for (const [method, args = []] of others) {
    const session = `${kind}-${method}`;
    const called = await asGuest(session, method, args, kind);
    const envelopes = await asked(session);
    assert.deepEqual(envelopes, [], `${kind}.${method}: the session was asked nothing: ${JSON.stringify(envelopes)}; it answered ${JSON.stringify(called)}`);
    if (method.startsWith('read:')) {
      // A field is no RPC property: reading it answers nothing of the binding's.
      assert.ok(!called.ok || called.value === null || called.value === undefined, `${kind}.${method.slice(5)} answers nothing: ${JSON.stringify(called)}`);
      continue;
    }
    assert.equal(called.ok, false, `${kind}.${method} is not a method a guest can call: ${JSON.stringify(called)}`);
    // workerd's own refusal of a method the class does not have: any other
    // error (one the method threw) would mean it was there to call.
    assert.match(called.error, /does not implement the method/, `${kind}.${method}: ${called.error}`);
  }
  console.log(`  ok  ${kind}: ${others.map(([m]) => m).join(', ')} answer nothing`);
}
/** Fields every class is asked for, as a caller might read them. (A stub's `constructor` is its own class, not a call.) */
const COMMON = [['read:ctx'], ['read:env'], ['read:props']];

try {
  for (const until = Date.now() + 30_000; ;) {
    try {
      await fetch(`http://127.0.0.1:${port}/ready`);
      break;
    } catch {}
    if (child.exitCode !== null || Date.now() > until) throw new Error(`workerd did not start:\n${logs}`);
    await new Promise((r) => setTimeout(r, 100));
  }

  // ── CirrusHmrRPC: its intended methods reach the session ─────────────────
  {
    const events = await asGuest('hmr-intended', 'hmrNextEvent', [1]);
    assert.deepEqual(events, { ok: true, value: [] }, `hmrNextEvent: ${JSON.stringify(events)}`);
    const sent = await asGuest('hmr-intended', 'hmrSend', ['client', 'update']);
    assert.equal(sent.ok, true, `hmrSend: ${JSON.stringify(sent)}`);
    const envelopes = await asked('hmr-intended');
    assert.deepEqual(envelopes.map((e) => [e.op, e.args]), [['hmrNextEvent', [1]], ['hmrRelay', ['client', 'update']]]);
    console.log('  ok  CirrusHmrRPC: hmrNextEvent and hmrSend reach the session');
  }

  await nothingElse('CirrusHmrRPC', [['_stub'], ...COMMON]);

  // ── SupervisorRPC ─────────────────────────────────────────────────────────
  {
    const exists = await asGuest('sup-intended', 'exists', ['/home/user/x'], 'SupervisorRPC');
    assert.equal(exists.ok, true, `exists: ${JSON.stringify(exists)}`);
    const envelopes = await asked('sup-intended');
    assert.deepEqual(envelopes.map((e) => [e.op, e.pid, e.run]), [['exists', 7, 'run-7']], JSON.stringify(envelopes));
    console.log('  ok  SupervisorRPC: exists reaches the session as its process');
  }
  // The concrete bypass: a child spawned as another process's (its stdin and identity).
  {
    const forged = await asGuest('sup-forged-parent', '_op', ['cpSpawn', [{ command: 'cat', args: [], env: {}, cwd: '/', parentPid: 1 }]], 'SupervisorRPC');
    const envelopes = await asked('sup-forged-parent');
    assert.deepEqual(envelopes.filter((e) => e.op === 'cpSpawn').map((e) => e.args?.[0]?.parentPid), [],
      `no cpSpawn naming another parent reaches the session: ${JSON.stringify(envelopes)}; _op answered ${JSON.stringify(forged)}`);
    console.log('  ok  SupervisorRPC: no cpSpawn naming another parent reaches the session');
  }
  await nothingElse('SupervisorRPC', [
    ['_op', ['stdout', ['forged']]], ['_caller', [{ op: 'stdout' }]], ['_fsOp', ['exists', ['/x']]],
    ['_fsRead', ['exists', ['/x']]], ['_fsMutation', ['unlink', ['/x']]], ['_resent', [{ op: 'stdout' }, { kind: 'read' }]],
    ['_network'], ['_mutationOwner'], ['_hostIncarnation'], ['_reportingPid'], ['_pid'], ['_runId'],
    ['_call', [null]], ['_cacheRead', [{ readOnly: false }]], ['_infrastructureCache', ['stdout', []]], ...COMMON,
  ]);

  // ── ProcessSupervisor: the same surface, as a one-shot's capability ───────
  {
    const exists = await asGuest('psup-intended', 'exists', ['/home/user/x'], 'ProcessSupervisor');
    assert.equal(exists.ok, true, `exists: ${JSON.stringify(exists)}`);
    const envelopes = await asked('psup-intended');
    assert.deepEqual(envelopes.map((e) => [e.op, e.pid, e.run]), [['exists', 9, 'run-9']], JSON.stringify(envelopes));
    console.log('  ok  ProcessSupervisor: exists reaches the session as its process');
  }
  await nothingElse('ProcessSupervisor', [
    ['_op', ['stdout', ['forged']]], ['_fsMutation', ['unlink', ['/x']]], ['_network'], ['_cacheRead', [{ readOnly: false }]],
    ['_mutationOwner'], ['_pid'], ['read:#transport'], ...COMMON,
  ]);

  // ── the Worker Loader shim: NimbusLoaderRPC, NimbusLoadedWorker, NimbusLoadedEntrypoint ──
  {
    const served = await asGuest('loader-intended', 'fetch', [], 'NimbusLoadedEntrypoint', true);
    assert.deepEqual(served, { ok: true, value: { status: 200, body: 'guest' } }, `a loaded worker's entrypoint serves: ${JSON.stringify(served)}`);
    console.log('  ok  NimbusLoadedEntrypoint: fetch serves the loaded worker');
  }
  await nothingElse('NimbusLoaderRPC', [['_currentDepth'], ['_maxDepth'], ['_assertDepthOk'], ...COMMON]);
  await nothingElse('NimbusLoadedWorker', COMMON);
  await nothingElse('NimbusLoadedEntrypoint', [['_props'], ['_resolveEntrypoint'], ['_relayNestedRpcResponse', [null, null]], ['_callHttpHandler', [null, null]], ...COMMON]);

  // ── NimbusAssetsRPC: reads as the process the host named ──────────────────
  {
    const served = await asGuest('assets-intended', 'fetch', [], 'NimbusAssetsRPC', true);
    assert.deepEqual(served, { ok: true, value: { status: 200, body: '<h1>asset</h1>' } }, JSON.stringify(served));
    const envelopes = await asked('assets-intended');
    assert.deepEqual(envelopes.map((e) => [e.op, e.args, e.pid, e.cred]),
      [['readFileBytes', ['home/run-as/site/public/index.html'], undefined, { uid: 1001, gid: 1001, groups: [1001], umask: 18 }]],
      `the asset is read as the process the binding was minted for: ${JSON.stringify(envelopes)}`);
    console.log('  ok  NimbusAssetsRPC: fetch reads as the process the host named');
  }
  await nothingElse('NimbusAssetsRPC', COMMON);
  {
    const id = await asGuest('dons-intended', 'idFromName', ['room'], 'NimbusDurableObjectNamespace');
    assert.equal(id.ok, true, `idFromName: ${JSON.stringify(id)}`);
    assert.equal(typeof id.value, 'string');
    console.log('  ok  NimbusDurableObjectNamespace: idFromName answers');
  }
  await nothingElse('NimbusDurableObjectNamespace', COMMON);
  await nothingElse('NimbusDOStub', COMMON);

  // ── The storage bindings: each call is its own store's ────────────────────
  {
    const target = (store) => ({ root: 'home/run-as/app', store });
    const runAs = { uid: 1001, gid: 1001, groups: [1001], umask: 18 };
    const kv = await asGuest('kv-intended', 'get', ['k'], 'NimbusKVNamespace');
    assert.deepEqual(kv, { ok: true, value: 'kv answer' }, JSON.stringify(kv));
    assert.deepEqual((await asked('kv-intended')).map((e) => [e.op, e.args, e.pid, e.cred]),
      [['kvCall', [target('KV'), { method: 'get', key: 'k' }], undefined, runAs]], 'a KV call is its namespace\'s, as the process the host named');
    const d1 = await asGuest('d1-intended', 'query', [{ queries: [{ sql: 'SELECT 1' }] }], 'NimbusD1Binding');
    assert.deepEqual(d1, { ok: true, value: ['success', 'results'] }, JSON.stringify(d1));
    assert.deepEqual((await asked('d1-intended')).map((e) => [e.op, e.args, e.pid, e.cred]),
      [['d1Query', [target('db'), [{ sql: 'SELECT 1' }]], undefined, undefined]], 'a D1 query is its database\'s');
    const r2 = await asGuest('r2-intended', 'head', ['k'], 'NimbusR2Bucket');
    assert.deepEqual(r2, { ok: true, value: null }, JSON.stringify(r2));
    assert.deepEqual((await asked('r2-intended')).map((e) => [e.op, e.args, e.pid, e.cred]),
      [['r2Call', [target('BUCKET'), { method: 'head', key: 'k' }], undefined, runAs]], 'an R2 call is its bucket\'s, as the process the host named');
    console.log('  ok  NimbusKVNamespace, NimbusD1Binding, NimbusR2Bucket: each call reaches the session as its own store');
  }
  await nothingElse('NimbusKVNamespace', [['query', [{ queries: [] }]], ['getOn', ['k', []]], ...COMMON]);
  await nothingElse('NimbusD1Binding', [['prepare', ['SELECT 1']], ['exec', ['SELECT 1']], ['batch', [[]]], ['get', ['k']], ...COMMON]);
  await nothingElse('NimbusR2Bucket', [['createMultipartUpload', ['k']], ['query', [{ queries: [] }]], ...COMMON]);

  // ── HostedSession ──────────────────────────────────────────────────────────
  {
    const other = await asGuest('scoped-intended', '_rpcExecStream', ['ls', { shellId: 'other' }], 'HostedSession');
    assert.equal(other.ok, false);
    assert.match(other.error, /EPERM: this session runs commands only in shell 'scoped'/, other.error);
    console.log('  ok  HostedSession: a scoped call is refused another shell');
  }
  await nothingElse('HostedSession', [['client'], ['cred', [{ uid: 0, gid: 0, groups: [0], umask: 18 }]], ['exec', [{ shellId: 'scoped' }]], ['read:owner'], ['read:scope'], ...COMMON]);

  // ── NimbusFsJournalReader ──────────────────────────────────────────────────
  {
    const numberings = await asGuest('reader-intended', 'numberings', [], 'NimbusFsJournalReader');
    assert.deepEqual(numberings, { ok: true, value: [] }, JSON.stringify(numberings));
    console.log('  ok  NimbusFsJournalReader: numberings answers');
  }
  await nothingElse('NimbusFsJournalReader', [['journal'], ['read:ctx'], ['read:env']]);

  console.log('rpc-private-surface-workerd: ok');
} catch (error) {
  console.error(logs.slice(-4000));
  throw error;
} finally {
  child.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
}
