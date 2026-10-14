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
//
// Runs lib/rpc-surface-workerd-entry.ts, bundled from source.

import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

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
      durableObjectStorage = (inMemory = void),
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
  ],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")],
);`);
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
    assert.equal(called.ok, false, `${kind}.${method} is not a method a guest can call: ${JSON.stringify(called)}`);
    assert.match(called.error, /does not implement|not a function|no such method|has no/i, `${kind}.${method}: ${called.error}`);
  }
  console.log(`  ok  ${kind}: ${others.map(([m]) => m).join(', ')} are not callable`);
}

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

  await nothingElse('CirrusHmrRPC', [['_stub']]);

  // ── SupervisorRPC ─────────────────────────────────────────────────────────
  {
    const exists = await asGuest('sup-intended', 'exists', ['/home/user/x'], 'SupervisorRPC');
    assert.equal(exists.ok, true, `exists: ${JSON.stringify(exists)}`);
    const envelopes = await asked('sup-intended');
    assert.deepEqual(envelopes.map((e) => [e.op, e.pid, e.run]), [['exists', 7, 'run-7']], JSON.stringify(envelopes));
    console.log('  ok  SupervisorRPC: exists reaches the session as its process');
  }
  await nothingElse('SupervisorRPC', [
    ['_op', ['stdout', ['forged']]], ['_caller', [{ op: 'stdout' }]], ['_fsOp', ['exists', ['/x']]],
    ['_fsRead', ['exists', ['/x']]], ['_fsMutation', ['unlink', ['/x']]], ['_resent', [{ op: 'stdout' }, { kind: 'read' }]],
    ['_network'], ['_mutationOwner'], ['_hostIncarnation'], ['_reportingPid'], ['_pid'], ['_runId'],
    ['_call', [null]], ['_cacheRead', [{ readOnly: false }]], ['_infrastructureCache', ['stdout', []]],
  ]);

  // ── the Worker Loader shim: NimbusLoaderRPC, NimbusLoadedWorker, NimbusLoadedEntrypoint ──
  {
    const served = await asGuest('loader-intended', 'fetch', [], 'NimbusLoadedEntrypoint', true);
    assert.equal(served.ok, true, `a loaded worker's entrypoint serves: ${JSON.stringify(served)}`);
    console.log('  ok  NimbusLoadedEntrypoint: fetch serves the loaded worker');
  }
  await nothingElse('NimbusLoaderRPC', [['_currentDepth'], ['_maxDepth'], ['_assertDepthOk']]);
  await nothingElse('NimbusLoadedEntrypoint', [['_props'], ['_resolveEntrypoint'], ['_relayNestedRpcResponse', [null, null]], ['_callHttpHandler', [null, null]]]);

  // ── HostedSession ──────────────────────────────────────────────────────────
  {
    const other = await asGuest('scoped-intended', '_rpcExecStream', ['ls', { shellId: 'other' }], 'HostedSession');
    assert.equal(other.ok, false);
    assert.match(other.error, /EPERM: this session runs commands only in shell 'scoped'/, other.error);
    console.log('  ok  HostedSession: a scoped call is refused another shell');
  }
  await nothingElse('HostedSession', [['client'], ['cred', [{ uid: 0, gid: 0, groups: [0], umask: 18 }]], ['exec', [{ shellId: 'scoped' }]]]);

  // ── NimbusFsJournalReader ──────────────────────────────────────────────────
  {
    const numberings = await asGuest('reader-intended', 'numberings', [], 'NimbusFsJournalReader');
    assert.deepEqual(numberings, { ok: true, value: [] }, JSON.stringify(numberings));
    console.log('  ok  NimbusFsJournalReader: numberings answers');
  }
  await nothingElse('NimbusFsJournalReader', [['journal']]);

  console.log('rpc-private-surface-workerd: ok');
} catch (error) {
  console.error(logs.slice(-4000));
  throw error;
} finally {
  child.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
}
