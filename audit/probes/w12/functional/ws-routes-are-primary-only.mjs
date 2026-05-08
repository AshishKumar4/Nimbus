#!/usr/bin/env bun
// W12 functional: WS upgrade paths classified primary-only-ws so a
// replica hibernation handler doesn't subscribe to streams it can't
// see appends to.

import { ok, eq, group, summary } from '../_tap.mjs';

let mod;
try { mod = await import('../../../../src/replica/routing.ts'); }
catch (e) { ok('replica-routing module imports', false, e.message); summary('w12/functional/ws-routes-are-primary-only'); }

const { classifyReplicaPolicy } = mod;

await group('all known WS upgrade paths are primary-only-ws', () => {
  eq('/ws', classifyReplicaPolicy('/ws', 'GET'), 'primary-only-ws');
  eq('/api/processes/1/logs', classifyReplicaPolicy('/api/processes/1/logs', 'GET'), 'primary-only-ws');
  eq('/api/processes/12345/logs', classifyReplicaPolicy('/api/processes/12345/logs', 'GET'), 'primary-only-ws');
  eq('/preview/__nimbus_hmr', classifyReplicaPolicy('/preview/__nimbus_hmr', 'GET'), 'primary-only-ws');
});

await group('paths that look WS-ish but aren\'t are NOT primary-only-ws', () => {
  // The matcher should only catch the exact patterns. /api/processes (no pid)
  // is the LIST endpoint and is replica-ok.
  eq('/api/processes (list, not WS)', classifyReplicaPolicy('/api/processes', 'GET'), 'replica-ok');
});

summary('w12/functional/ws-routes-are-primary-only');
