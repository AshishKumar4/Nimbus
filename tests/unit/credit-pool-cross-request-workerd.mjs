// @serial
// @tier slow — drives a local workerd
// The isolate's supervisor budget, across requests in workerd itself: a
// request waits for a share of it and its client leaves; another request
// gives the budget back, which wakes the gone request's waiter. workerd
// cancels that waiter's continuation (a promise resolved from another
// request, whose own request has ended). The credit must not be held by
// it: a later ask for the whole budget is served within its 5 s. Credit
// handed to such a waiter was held for the isolate's life, and that ask,
// and every one like it, waited forever.

import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { servePlainWorkerd } from './lib/plain-workerd.mjs';

const REPO = resolve(import.meta.dirname, '../..');
const bundled = await build({
  entryPoints: [join(import.meta.dirname, 'lib/credit-cross-request-workerd-entry.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  external: ['cloudflare:*', 'node:*'],
  nodePaths: [join(REPO, 'packages/worker/node_modules')],
  write: false,
  logLevel: 'error',
});
const served = await servePlainWorkerd({
  name: 'credit-cross-request',
  files: { 'main.js': bundled.outputFiles[0].text },
  readyPath: '/ready',
  config: ({ port }) => `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "main", worker = (
      modules = [(name = "main.js", esModule = embed "main.js")],
      compatibilityDate = "2026-09-26",
      compatibilityFlags = ["enable_request_signal"],
    )),
  ],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")],
);`,
});

const get = async (path) => (await fetch(`${served.base}${path}`, { signal: AbortSignal.timeout(20_000) })).json();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  const held = await get('/hold');
  assert.equal(held.current, held.capacity, 'one request holds the whole budget');
  const leaving = new AbortController();
  const waiting = fetch(`${served.base}/wait`, { signal: leaving.signal }).catch(() => null);
  for (let i = 0; i < 100 && (await get('/stats')).queued === 0; i++) await sleep(50);
  assert.equal((await get('/stats')).queued, 1, 'the next request waits for a share');
  leaving.abort();
  await waiting;
  // Long enough for workerd to see the client gone and end that request.
  await sleep(500);
  const released = await get('/release');
  assert.equal(released.current, 0, 'given back, the budget is handed to no one: the waiter takes its share itself');
  const whole = await get('/whole');
  assert.equal(whole.granted, true, `an ask for the whole budget is served after the gone waiter's turn lapses: ${JSON.stringify(whole)}`);
  assert.equal((await get('/stats')).current, 0, 'nothing is held after');
  assert.match(served.logs(), /different request context/, 'workerd did cancel the gone request\'s continuation: the case this test is for');
  console.log('credit-pool-cross-request-workerd: ok');
} finally {
  await served.stop();
}
