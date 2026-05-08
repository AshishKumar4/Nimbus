#!/usr/bin/env bun
// W12 functional: tryEnableReplicas() + inspectReplicaState() shape.

import { ok, eq, group, summary } from '../_tap.mjs';
import {
  makePrimaryCtx, makeReplicaCtx, makeUnsupportedCtx,
} from '../_mock-replica-ctx.mjs';

let mod;
try { mod = await import('../../../../src/replica/routing.ts'); }
catch (e) { ok('replica-routing module imports', false, e.message); summary('w12/functional/replica-state-shape'); }

const { tryEnableReplicas, inspectReplicaState } = mod;

ok('tryEnableReplicas is a function', typeof tryEnableReplicas === 'function');
ok('inspectReplicaState is a function', typeof inspectReplicaState === 'function');

await group('SPEC API present (enableReplicas) — primary isolate', () => {
  const ctx = makePrimaryCtx();
  const r = tryEnableReplicas(ctx);
  eq('returns enabled state', r.state, 'enabled');
  eq('error is null', r.error, null);
  eq('enableReplicas was called once', ctx.storage._enableReplicasCalled, 1);
  const inspect = inspectReplicaState(ctx);
  eq('isReplica false on primary', inspect.isReplica, false);
});

await group('SPEC API present — replica isolate', () => {
  const ctx = makeReplicaCtx();
  const r = tryEnableReplicas(ctx);
  eq('state enabled on replica too', r.state, 'enabled');
  const inspect = inspectReplicaState(ctx);
  eq('isReplica true on replica', inspect.isReplica, true);
  ok('primary stub captured', typeof inspect.primary === 'object' && inspect.primary !== null);
});

await group('alternate API present (configureReadReplication)', () => {
  const ctx = makePrimaryCtx({ noEnableReplicasApi: true, alternateConfigureApi: true });
  const r = tryEnableReplicas(ctx);
  eq('state enabled-via-configure', r.state, 'enabled-via-configure');
  ok('configure was called with mode auto',
     ctx.storage._configureReadReplicationArgs &&
     ctx.storage._configureReadReplicationArgs.mode === 'auto');
});

await group('neither API present (pre-GA runtime)', () => {
  const ctx = makeUnsupportedCtx();
  const r = tryEnableReplicas(ctx);
  eq('state unsupported', r.state, 'unsupported');
  eq('error null when not throwing', r.error, null);
});

await group('enableReplicas throws — recoverable', () => {
  const ctx = makePrimaryCtx({ enableReplicasThrows: 'flag not enabled' });
  const r = tryEnableReplicas(ctx);
  eq('state error', r.state, 'error');
  ok('error message captured', String(r.error).includes('flag not enabled'));
});

await group('inspect — bookmark exposure', () => {
  const ctx = makePrimaryCtx({ bookmark: '0000-aabb-ccdd' });
  const inspect = inspectReplicaState(ctx);
  eq('bookmark surfaced', inspect.bookmark, '0000-aabb-ccdd');
  // Ctx without getCurrentBookmark API should report null.
  const ctx2 = makePrimaryCtx();
  const inspect2 = inspectReplicaState(ctx2);
  eq('bookmark null when API absent', inspect2.bookmark, null);
});

await group('inspect shape stability', () => {
  const ctx = makeReplicaCtx({ bookmark: 'bm1' });
  const i = inspectReplicaState(ctx);
  // The shape contract: { isReplica: boolean, primary: object|null, bookmark: string|null }
  ok('isReplica is boolean', typeof i.isReplica === 'boolean');
  ok('primary is object on replica', typeof i.primary === 'object' && i.primary !== null);
  ok('bookmark is string|null', typeof i.bookmark === 'string' || i.bookmark === null);
});

summary('w12/functional/replica-state-shape');
