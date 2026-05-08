#!/usr/bin/env bun
// W12 e2e (local mock): a replica isolate receiving a primary-only
// route forwards the Request to ctx.storage.primary.fetch and returns
// the primary's response.
//
// Pure-mock; no server. Verifies the routing decision integration.

import { ok, eq, group, summary } from '../_tap.mjs';
import { makeReplicaCtx } from '../_mock-replica-ctx.mjs';

let mod;
try { mod = await import('../../../../src/replica/routing.ts'); }
catch (e) { ok('replica-routing module imports', false, e.message); summary('w12/e2e/delegate-roundtrip'); }

const { handleReplicaPreflight } = mod;
ok('handleReplicaPreflight is a function', typeof handleReplicaPreflight === 'function');

await group('primary-only route on replica → primary handles it', async () => {
  const ctx = makeReplicaCtx();
  const req = new Request('https://example.com/api/write-file', { method: 'POST', body: '{"path":"a","content":"hi"}' });
  const result = await handleReplicaPreflight(ctx, req, { isWarm: false });
  ok('result.delegated true', result.delegated === true);
  ok('result.response is a Response', result.response instanceof Response);
  const body = await result.response.json();
  eq('primary saw the URL', body.url, 'https://example.com/api/write-file');
  eq('primary handled', body.__primary, true);
  eq('primary recorded one call', ctx.storage.primary.calls.length, 1);
});

await group('replica-ok route on replica → handles locally (no delegate)', async () => {
  const ctx = makeReplicaCtx();
  const req = new Request('https://example.com/api/memory');
  const result = await handleReplicaPreflight(ctx, req, { isWarm: true });
  eq('not delegated', result.delegated, false);
  eq('no response prepared', result.response, null);
  eq('primary saw zero calls', ctx.storage.primary.calls.length, 0);
});

await group('replica-warm-only cold replica → delegates', async () => {
  const ctx = makeReplicaCtx();
  const req = new Request('https://example.com/preview/index.html');
  const result = await handleReplicaPreflight(ctx, req, { isWarm: false });
  eq('cold replica delegates /preview/', result.delegated, true);
  eq('primary saw one call', ctx.storage.primary.calls.length, 1);
});

await group('replica-warm-only warm replica → handles locally', async () => {
  const ctx = makeReplicaCtx();
  const req = new Request('https://example.com/preview/index.html');
  const result = await handleReplicaPreflight(ctx, req, { isWarm: true });
  eq('warm replica handles /preview/ locally', result.delegated, false);
  eq('primary saw zero calls', ctx.storage.primary.calls.length, 0);
});

await group('primary isolate handles everything locally', async () => {
  const { makePrimaryCtx } = await import('../_mock-replica-ctx.mjs');
  const ctx = makePrimaryCtx();
  // Primary doesn't even have a primary stub, so any "delegate" would crash.
  for (const url of ['/api/write-file', '/api/memory', '/preview/index.html', '/ws']) {
    const req = new Request('https://example.com' + url, { method: url === '/api/write-file' ? 'POST' : 'GET' });
    const result = await handleReplicaPreflight(ctx, req, { isWarm: true });
    eq(`primary delegated=false for ${url}`, result.delegated, false);
  }
});

summary('w12/e2e/delegate-roundtrip');
