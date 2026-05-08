#!/usr/bin/env bun
// W12 functional: shouldDelegateToPrimary() decision matrix.
//
// Combines isReplica × policy × isWarm to decide whether to forward
// the Request to ctx.storage.primary or handle locally.

import { ok, eq, group, summary } from '../_tap.mjs';

let mod;
try { mod = await import('../../../../src/replica/routing.ts'); }
catch (e) { ok('replica-routing module imports', false, e.message); summary('w12/functional/should-delegate-decision'); }

const { shouldDelegateToPrimary, classifyReplicaPolicy } = mod;
ok('shouldDelegateToPrimary is a function', typeof shouldDelegateToPrimary === 'function');

await group('not a replica → never delegate', () => {
  for (const p of ['/api/memory', '/api/write-file', '/preview/index.html', '/ws', '/port/3000/']) {
    const policy = classifyReplicaPolicy(p, 'GET');
    const d = shouldDelegateToPrimary({ isReplica: false, policy, isWarm: true });
    eq(`primary handles ${p} (policy=${policy})`, d, false);
  }
});

await group('replica + replica-ok → never delegate', () => {
  const policy = classifyReplicaPolicy('/api/memory', 'GET');
  eq('replica-ok policy', policy, 'replica-ok');
  eq('replica handles locally', shouldDelegateToPrimary({ isReplica: true, policy, isWarm: false }), false);
  eq('warm replica handles locally', shouldDelegateToPrimary({ isReplica: true, policy, isWarm: true }), false);
});

await group('replica + primary-only → always delegate', () => {
  const policy = classifyReplicaPolicy('/api/write-file', 'POST');
  eq('primary-only policy', policy, 'primary-only');
  eq('replica delegates', shouldDelegateToPrimary({ isReplica: true, policy, isWarm: true }), true);
  eq('cold replica also delegates', shouldDelegateToPrimary({ isReplica: true, policy, isWarm: false }), true);
});

await group('replica + primary-only-ws → always delegate (WS upgrade goes to primary)', () => {
  const policy = classifyReplicaPolicy('/ws', 'GET');
  eq('primary-only-ws policy', policy, 'primary-only-ws');
  eq('replica delegates WS upgrade', shouldDelegateToPrimary({ isReplica: true, policy, isWarm: false }), true);
});

await group('replica + replica-warm-only → delegate iff cold', () => {
  const policy = classifyReplicaPolicy('/preview/index.html', 'GET');
  eq('replica-warm-only policy', policy, 'replica-warm-only');
  eq('cold replica delegates', shouldDelegateToPrimary({ isReplica: true, policy, isWarm: false }), true);
  eq('warm replica handles locally', shouldDelegateToPrimary({ isReplica: true, policy, isWarm: true }), false);
});

await group('suspended replicas always delegate', () => {
  // While npm install / git clone runs on primary, replicas defer to avoid
  // SPEC's "Network connection lost" replication errors during write bursts.
  const policy = classifyReplicaPolicy('/api/memory', 'GET');
  eq('replica-ok policy', policy, 'replica-ok');
  eq('suspended replica delegates even on replica-ok',
     shouldDelegateToPrimary({ isReplica: true, policy, isWarm: true, suspended: true }), true);
});

summary('w12/functional/should-delegate-decision');
