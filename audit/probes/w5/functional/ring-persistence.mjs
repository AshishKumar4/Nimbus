// W5 functional: ring buffer survives DO snapshot+rehydrate.
//
// Asserts:
//   - snapshotForStorage() returns a JSON-serializable blob
//   - rehydrateFromStorage(blob) restores ring + last frames
//   - snapshot is bounded (≤20 KB for a full 50-entry ring)

import { ok, eq, gte, lte, group, summary } from '../_tap.mjs';

let mod;
try {
  mod = await import('../../../../src/observability/oom-discriminator.ts');
} catch (e) {
  ok('oom-discriminator module exists', false, e.message);
  summary('w5/functional/ring-persistence');
}

const {
  recordFailure, getFailures, resetFailures,
  setLastRpcFrame, getLastRpcFrame,
  setLastFacetId, getLastFacetId,
  snapshotForStorage, rehydrateFromStorage,
} = mod;

group('persistence surface exists', () => {
  ok('snapshotForStorage is fn', typeof snapshotForStorage === 'function');
  ok('rehydrateFromStorage is fn', typeof rehydrateFromStorage === 'function');
});

group('snapshot → rehydrate round-trip', () => {
  resetFailures();
  for (let i = 0; i < 5; i++) {
    recordFailure({
      at: 1000 + i, phase: 'install', cause: i % 2 ? 'oom' : 'sqlite_nomem',
      rssEstimateBytes: i * 100,
      heapUsedBytes: 0, lruBytes: 0, inFlightBytes: 0,
      lastRpcFrame: null, lastFacetId: null,
      message: `entry ${i}`,
    });
  }
  setLastRpcFrame('writeBatch', 99);
  setLastFacetId('codeId-X', 2);

  const snap = snapshotForStorage();
  ok('snapshot is plain object', typeof snap === 'object' && snap !== null);
  ok('snapshot is JSON-serializable',
    typeof JSON.stringify(snap) === 'string');

  const json = JSON.stringify(snap);
  lte('snapshot ≤ 20 KB for 5 entries', json.length, 20 * 1024);

  // Wipe state, rehydrate.
  resetFailures();
  eq('after reset, no failures', getFailures().length, 0);
  eq('after reset, no rpc frame', getLastRpcFrame(), null);

  rehydrateFromStorage(snap);
  const fs = getFailures();
  eq('rehydrated 5 entries', fs.length, 5);
  // Newest first by 'at'.
  eq('newest at[0]', fs[0].at, 1004);
  eq('rehydrated rpc frame method', getLastRpcFrame()?.method, 'writeBatch');
  eq('rehydrated facet id', getLastFacetId()?.codeId, 'codeId-X');
});

group('rehydrate is fail-soft on garbage input', () => {
  resetFailures();
  rehydrateFromStorage(null);
  eq('null → no entries', getFailures().length, 0);
  rehydrateFromStorage({ failures: 'not-an-array' });
  eq('garbage → no entries', getFailures().length, 0);
  rehydrateFromStorage({ failures: [{ at: 'bad' }] });
  // Either the bad entry is dropped, or it's accepted but the function
  // didn't throw. Either is OK — fail-soft. We just assert no throw.
  ok('no throw on bad shape', true);
});

group('full 50-entry snapshot stays bounded', () => {
  resetFailures();
  for (let i = 0; i < 60; i++) {
    recordFailure({
      at: i, phase: 'install', cause: 'oom',
      rssEstimateBytes: 0, heapUsedBytes: 0, lruBytes: 0, inFlightBytes: 0,
      lastRpcFrame: null, lastFacetId: null,
      message: 'x'.repeat(180), // near the per-message cap
    });
  }
  const snap = snapshotForStorage();
  const bytes = JSON.stringify(snap).length;
  lte('snapshot ≤ 20 KB even with full ring', bytes, 20 * 1024);
  eq('only 50 entries kept', snap.failures.length, 50);
});

summary('w5/functional/ring-persistence');
