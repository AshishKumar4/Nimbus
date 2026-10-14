// @serial
// @tier slow — drives a local workerd
// A guest reaches no more of the platform's RPC classes than their intended
// methods. Workers RPC exposes every string-named method of a WorkerEntrypoint,
// RpcTarget or Durable Object to whoever holds its stub; TypeScript `private`
// and a leading underscore hide nothing there. Through real Workers RPC, in
// workerd, a guest holding each class as a guest is given it:
//
//   - CirrusHmrRPC (the real-Vite resident's env.CIRRUS_HMR): hmrSend and
//     hmrNextEvent reach the session as they should; `_stub` is not a method
//     a caller can name. Red before: `_stub()` answered the session's stub and
//     its raw dispatch, and the guest's dispatch acted as the kernel.
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
      durableObjectNamespaces = [(className = "Session", uniqueKey = "rpc-private-surface", enableSql = true)],
      durableObjectStorage = (inMemory = void),
      bindings = [(name = "NIMBUS_SESSION", durableObjectNamespace = "Session")],
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
/** The guest holding `session`'s CirrusHmrRPC calls `method`(...args). */
const asGuest = (session, method, args = []) => get('/call', { session, method, args: JSON.stringify(args) });
const asked = (session) => get('/asked', { session });

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

  // ── CirrusHmrRPC: nothing else is a method a guest can name ──────────────
  {
    const stub = await asGuest('hmr-private', '_stub');
    const envelopes = await asked('hmr-private');
    assert.deepEqual(envelopes, [], `the session was asked nothing by the guest: ${JSON.stringify(envelopes)}; _stub answered ${JSON.stringify(stub)}`);
    assert.equal(stub.ok, false, `_stub is not a method a guest can call: ${JSON.stringify(stub)}`);
    assert.match(stub.error, /does not implement|not a function|no such method|_stub/i, stub.error);
    console.log(`  ok  CirrusHmrRPC: _stub is not callable (${stub.error})`);
  }

  console.log('rpc-private-surface-workerd: ok');
} catch (error) {
  console.error(logs.slice(-4000));
  throw error;
} finally {
  child.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
}
