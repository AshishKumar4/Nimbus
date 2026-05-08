// W5 functional: /api/_diag/memory v2 schema.
//
// Asserts the W5-augmented response shape via the discriminator/ring
// modules directly (the HTTP handler is a thin Response.json wrapper —
// shape assertions on the underlying functions cover the contract).

import { ok, eq, gte, group, summary } from '../_tap.mjs';

let mod;
try {
  mod = await import('../../../../src/observability/oom-discriminator.ts');
} catch (e) {
  ok('oom-discriminator module exists', false, e.message);
  summary('w5/functional/diag-shape');
}

const {
  recordFailure, getFailures, resetFailures,
  setLastRpcFrame, getLastRpcFrame,
  setLastFacetId, getLastFacetId,
} = mod;

group('module surface', () => {
  ok('recordFailure is fn', typeof recordFailure === 'function');
  ok('getFailures is fn', typeof getFailures === 'function');
  ok('resetFailures is fn', typeof resetFailures === 'function');
  ok('setLastRpcFrame is fn', typeof setLastRpcFrame === 'function');
  ok('getLastRpcFrame is fn', typeof getLastRpcFrame === 'function');
  ok('setLastFacetId is fn', typeof setLastFacetId === 'function');
  ok('getLastFacetId is fn', typeof getLastFacetId === 'function');
});

group('initial state', () => {
  resetFailures();
  eq('failures empty', getFailures(), []);
  eq('last RPC frame null', getLastRpcFrame(), null);
  eq('last facet id null', getLastFacetId(), null);
});

group('recordFailure shape', () => {
  recordFailure({
    at: Date.now(), phase: 'install', cause: 'sqlite_nomem',
    rssEstimateBytes: 1234, heapUsedBytes: 5678,
    lruBytes: 999, inFlightBytes: 111,
    lastRpcFrame: null, lastFacetId: null,
    message: 'test',
  });
  const fs = getFailures();
  eq('one entry', fs.length, 1);
  eq('cause', fs[0].cause, 'sqlite_nomem');
  eq('phase', fs[0].phase, 'install');
  eq('message', fs[0].message, 'test');
});

group('ring buffer caps at 50', () => {
  resetFailures();
  for (let i = 0; i < 75; i++) {
    recordFailure({
      at: i, phase: 'rpc', cause: 'unknown',
      rssEstimateBytes: 0, heapUsedBytes: 0, lruBytes: 0, inFlightBytes: 0,
      lastRpcFrame: null, lastFacetId: null,
    });
  }
  const fs = getFailures();
  eq('size capped at 50', fs.length, 50);
  // newest first
  eq('newest at[0] is i=74', fs[0].at, 74);
});

group('setLastRpcFrame / getLastRpcFrame round-trip', () => {
  setLastRpcFrame('writeBatch', 12345);
  const f = getLastRpcFrame();
  eq('method', f?.method, 'writeBatch');
  eq('payloadBytes', f?.payloadBytes, 12345);
  ok('atMs is recent', typeof f?.atMs === 'number' && f.atMs > 0);
});

group('setLastFacetId / getLastFacetId round-trip', () => {
  setLastFacetId('nfp:install:abc:slot-0', 0);
  const f = getLastFacetId();
  eq('codeId', f?.codeId, 'nfp:install:abc:slot-0');
  eq('slotIndex', f?.slotIndex, 0);
});

summary('w5/functional/diag-shape');
