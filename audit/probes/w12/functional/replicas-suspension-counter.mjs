#!/usr/bin/env bun
// W12 functional: suspendReplicas() returns a release function;
// replicasSuspended() reflects nested counts.

import { ok, eq, group, summary } from '../_tap.mjs';

let mod;
try { mod = await import('../../../../src/replica/suspension.ts'); }
catch (e) { ok('replica-suspension module imports', false, e.message); summary('w12/functional/replicas-suspension-counter'); }

const { suspendReplicas, replicasSuspended, _resetSuspensionForTests } = mod;

if (typeof _resetSuspensionForTests === 'function') _resetSuspensionForTests();

await group('initial state', () => {
  eq('replicasSuspended() is false initially', replicasSuspended(), false);
});

await group('single suspend / release', () => {
  const release = suspendReplicas();
  eq('replicasSuspended() true while held', replicasSuspended(), true);
  ok('release is a function', typeof release === 'function');
  release();
  eq('replicasSuspended() false after release', replicasSuspended(), false);
});

await group('nested suspend / release (count semantics)', () => {
  const r1 = suspendReplicas();
  const r2 = suspendReplicas();
  const r3 = suspendReplicas();
  eq('still suspended (3 holders)', replicasSuspended(), true);
  r2();
  eq('still suspended (2 holders)', replicasSuspended(), true);
  r1();
  eq('still suspended (1 holder)', replicasSuspended(), true);
  r3();
  eq('not suspended (0 holders)', replicasSuspended(), false);
});

await group('double-release is idempotent', () => {
  const r = suspendReplicas();
  r();
  r();
  eq('still 0 holders after double-release', replicasSuspended(), false);
  // And a fresh suspend works correctly after.
  const r2 = suspendReplicas();
  eq('fresh suspend after double-release', replicasSuspended(), true);
  r2();
  eq('release back to 0', replicasSuspended(), false);
});

summary('w12/functional/replicas-suspension-counter');
