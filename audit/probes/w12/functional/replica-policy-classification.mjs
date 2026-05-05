#!/usr/bin/env bun
// W12 functional: classifyReplicaPolicy() routes table.
//
// Drives the contract for src/replica-routing.ts. Asserts each known
// route from W12-plan §2 maps to the right policy. New routes added
// without policy assignment fail this test (drift detector).

import { ok, eq, group, summary } from '../_tap.mjs';

let mod;
try {
  mod = await import('../../../../src/replica-routing.ts');
} catch (e) {
  ok('replica-routing module imports', false, e.message);
  summary('w12/functional/replica-policy-classification');
}

const { classifyReplicaPolicy } = mod;
ok('classifyReplicaPolicy is a function', typeof classifyReplicaPolicy === 'function');

await group('replica-ok routes', () => {
  eq('/api/memory GET → replica-ok', classifyReplicaPolicy('/api/memory', 'GET'), 'replica-ok');
  eq('/api/_diag/memory GET → replica-ok', classifyReplicaPolicy('/api/_diag/memory', 'GET'), 'replica-ok');
  eq('/api/_diag/anything-else GET → replica-ok', classifyReplicaPolicy('/api/_diag/foo', 'GET'), 'replica-ok');
  eq('/api/processes GET → replica-ok', classifyReplicaPolicy('/api/processes', 'GET'), 'replica-ok');
  eq('/api/stats GET → replica-ok', classifyReplicaPolicy('/api/stats', 'GET'), 'replica-ok');
});

await group('replica-warm-only routes', () => {
  eq('/preview/ → replica-warm-only', classifyReplicaPolicy('/preview/', 'GET'), 'replica-warm-only');
  eq('/preview → replica-warm-only', classifyReplicaPolicy('/preview', 'GET'), 'replica-warm-only');
  eq('/preview/index.html → replica-warm-only', classifyReplicaPolicy('/preview/index.html', 'GET'), 'replica-warm-only');
  eq('/preview/src/App.tsx → replica-warm-only', classifyReplicaPolicy('/preview/src/App.tsx', 'GET'), 'replica-warm-only');
});

await group('primary-only-ws routes', () => {
  eq('/ws GET → primary-only-ws', classifyReplicaPolicy('/ws', 'GET'), 'primary-only-ws');
  eq('/api/processes/123/logs → primary-only-ws',
     classifyReplicaPolicy('/api/processes/123/logs', 'GET'), 'primary-only-ws');
  eq('/api/processes/45/logs → primary-only-ws',
     classifyReplicaPolicy('/api/processes/45/logs', 'GET'), 'primary-only-ws');
  eq('/preview/__nimbus_hmr → primary-only-ws',
     classifyReplicaPolicy('/preview/__nimbus_hmr', 'GET'), 'primary-only-ws');
});

await group('primary-only routes (writes + test endpoints + worker + port + supervisor-rpc)', () => {
  eq('/api/write-file POST → primary-only', classifyReplicaPolicy('/api/write-file', 'POST'), 'primary-only');
  eq('/api/mkdir POST → primary-only', classifyReplicaPolicy('/api/mkdir', 'POST'), 'primary-only');
  eq('/api/start-vite POST → primary-only', classifyReplicaPolicy('/api/start-vite', 'POST'), 'primary-only');
  eq('/api/supervisor-rpc POST → primary-only', classifyReplicaPolicy('/api/supervisor-rpc', 'POST'), 'primary-only');
  eq('/api/_test/hib/simulate POST → primary-only', classifyReplicaPolicy('/api/_test/hib/simulate', 'POST'), 'primary-only');
  eq('/api/_test/spawn-emitter POST → primary-only', classifyReplicaPolicy('/api/_test/spawn-emitter', 'POST'), 'primary-only');
  eq('/api/_test/log-tail GET → primary-only', classifyReplicaPolicy('/api/_test/log-tail', 'GET'), 'primary-only');
  eq('/worker/ → primary-only', classifyReplicaPolicy('/worker/', 'GET'), 'primary-only');
  eq('/worker → primary-only', classifyReplicaPolicy('/worker', 'GET'), 'primary-only');
  eq('/worker/api/foo → primary-only', classifyReplicaPolicy('/worker/api/foo', 'GET'), 'primary-only');
  eq('/port/3000/ → primary-only', classifyReplicaPolicy('/port/3000/', 'GET'), 'primary-only');
  eq('/port/8080/anything → primary-only', classifyReplicaPolicy('/port/8080/anything', 'GET'), 'primary-only');
});

await group('unknown routes default to primary-only (safe default)', () => {
  eq('/totally-unknown → primary-only', classifyReplicaPolicy('/totally-unknown', 'GET'), 'primary-only');
  eq('/ → primary-only', classifyReplicaPolicy('/', 'GET'), 'primary-only');
  eq('/random/path → primary-only', classifyReplicaPolicy('/random/path', 'POST'), 'primary-only');
});

await group('write methods on otherwise-replica-ok routes are still primary-only', () => {
  // POST/PUT/DELETE on any read-eligible route should escape to primary-only.
  eq('/api/memory POST → primary-only', classifyReplicaPolicy('/api/memory', 'POST'), 'primary-only');
  eq('/api/stats DELETE → primary-only', classifyReplicaPolicy('/api/stats', 'DELETE'), 'primary-only');
  eq('/api/processes PUT → primary-only', classifyReplicaPolicy('/api/processes', 'PUT'), 'primary-only');
});

summary('w12/functional/replica-policy-classification');
