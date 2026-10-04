#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import * as policy from '../../packages/worker/src/runtime/stop-replay-policy.ts';
import { ReplayJournal } from '../../packages/worker/src/runtime/stop-replay-journal.ts';
import * as sessionRpc from '../../packages/worker/src/session/rpc.ts';
import { R2CacheClient } from '../../packages/worker/src/npm/r2-cache.ts';
mock.module('cloudflare:workers', () => ({ WorkerEntrypoint: class { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } }));
const { SupervisorRPC } = await import('../../packages/worker/src/session/supervisor-rpc.ts');
const selected = process.env.NIMBUS_SURFACE_CASE;
const tests = {};
tests.coverage = async () => {
  const explicit = policy.REPLAY_PUBLIC_METHOD_POLICY ?? {};
  for (const name of Object.getOwnPropertyNames(SupervisorRPC.prototype)) {
    if (name === 'constructor' || name.startsWith('_')) continue;
    const method = Object.getOwnPropertyDescriptor(SupervisorRPC.prototype, name).value;
    assert.equal(typeof method, 'function');
    const rule = explicit[name] ?? (policy.operationPolicy(name) ? { kind: 'op' } : undefined);
    assert.ok(rule, 'unclassified public SupervisorRPC method: ' + name);
    if (rule.kind === 'op') assert.match(String(method), /this\._(?:op|fsOp|fsRead|fsMutation|resent)\s*\(/, name + ' must route through a caller-stamping helper');
  }
};
function bound(journal, bucket) {
  const ctx = { props: { doId: 's', pid: 7, writerId: 'a' } };
  const host = { env: { NPM_PACKUMENT_CACHE: bucket, NPM_TARBALL_CACHE: bucket },
    facetManager: { journalRecording: () => journal.recording },
  };
  const methods = { getPackument: '_rpcGetPackument', getCachedTarball: '_rpcGetCachedTarball', putCachedTarball: '_rpcPutCachedTarball' };
  const env = { ...host.env, NIMBUS_SESSION: { idFromName: (id) => id, idFromString: (id) => id, get: () => ({
    supervisorOp: (e) => journal.handle(e.op, e.args, e.run, async () => {
      const fn = sessionRpc[methods[e.op]];
      assert.equal(typeof fn, 'function', 'session implementation of ' + e.op);
      return fn(host, ...e.args, e.pid, e.run);
    }),
  }) } };
  return { rpc: new SupervisorRPC(ctx, env), ctx };
}
tests.cache = async () => {
  const j = new ReplayJournal(() => {}); j.start('a');
  let json = '{"name":"pkg","v":1}';
  const bucket = { get: async () => ({ text: async () => json, uploaded: new Date(), customMetadata: { expiresAt: String(Date.now() + 3600000) } }) };
  const { rpc, ctx } = bound(j, bucket);
  assert.equal((await rpc.getPackument('pkg')).json, json);
  j.stopped(); j.start('b'); ctx.props.writerId = 'b'; json = '{"name":"pkg","v":2}';
  await assert.rejects(rpc.getPackument('pkg'), /answered differently/, 'direct packument observations must cross the journal');
  const write = new ReplayJournal(() => {}); write.start('a');
  let wrote = false;
  const { rpc: writer } = bound(write, { put: async () => {
    assert.equal(write.replayable, false, 'disqualify before the cache write, not after'); wrote = true;
  } });
  const bytes = new TextEncoder().encode('ABCD');
  const sri = 'sha256-' + Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('base64');
  assert.equal(await writer.putCachedTarball(sri, bytes), true); assert.equal(wrote, true);
  const tar = new ReplayJournal(() => {}); tar.start('a');
  let present = true;
  const { rpc: reader, ctx: tarCtx } = bound(tar, { get: async () => present ? { arrayBuffer: async () => bytes.slice().buffer } : null });
  assert.deepEqual((await reader.getCachedTarball(sri)).bytes, bytes);
  tar.stopped(); tar.start('b'); tarCtx.props.writerId = 'b'; present = false;
  await assert.rejects(reader.getCachedTarball(sri), /answered differently/, 'tarball hit changing to a miss is an observation');
};
tests.preparation = async () => {
  for (const [path, offset, close] of [['/other', 0, false], ['/input', 9, false], ['/input', 0, true]]) {
    const j = new ReplayJournal(() => {});
    j.bindStdinFile?.({ path: '/input', offset: 0, limit: 65536 });
    j.start('a'); if (close) j.prepared?.('a');
    await j.handle('stdinFileRead', [path, offset, 4], 'a', async () => ({ data: new Uint8Array([65]), size: 4 }));
    j.stopped(); j.start('b'); if (close) j.prepared?.('b');
    await assert.rejects(j.handle('stdinFileRead', [path, offset, 4], 'b', async () => ({ data: new Uint8Array([66]), size: 4 })), /answered differently/,
      'wrong path/offset/phase cannot borrow the fd-0 exemption');
  }
  const legit = new ReplayJournal(() => {});
  legit.bindStdinFile({ path: '/input', offset: 3, limit: 8 }); legit.start('a');
  const take = (offset, data, size = 11) => legit.handle('stdinFileRead', ['/input', offset, 4], 'a', async () => ({ data: new Uint8Array(data), size }));
  await take(3, [1, 2, 3, 4]);
  await take(7, [5, 6, 7, 8]);
  legit.stopped(); legit.start('b');
  // Only the old stdin read tape owns these two preparation replies.
  await legit.boundary('b');
  assert.equal(legit.diverged, null);
};
tests.readOnlyParity = async () => {
  const savedCaches = globalThis.caches, savedFetch = globalThis.fetch;
  const bytes = new TextEncoder().encode('ABCD');
  const sri = 'sha256-' + Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('base64');
  const json = '{"name":"pkg","v":1}';
  try {
    for (const mode of ['r2', 'l2', 'network']) {
      const answers = [];
      for (const readOnly of [false, true]) {
        let writes = 0;
        globalThis.caches = { default: {
          match: async (request) => mode === 'l2' ? new Response(request.url.includes('/t/') ? bytes : json, { headers: { 'cache-control': 'max-age=3600' } }) : undefined,
          put: async () => { writes++; },
        } };
        const bucket = {
          get: async () => mode === 'network' ? null : ({ arrayBuffer: async () => bytes.slice().buffer, text: async () => json,
            uploaded: new Date(), customMetadata: { expiresAt: String(Date.now() + 3600000) } }),
          put: async () => { writes++; },
        };
        globalThis.fetch = async () => new Response(json);
        const tar = new R2CacheClient(bucket, bucket, readOnly);
        const cached = await tar.getTarball(sri);
        const pack = new R2CacheClient(bucket, bucket, readOnly);
        const resolved = await pack.readThroughPackument('pkg', { retries: 0 });
        answers.push({ bytes: cached, tarEvents: tar._cacheEvents, ...resolved, events: pack._cacheEvents });
        if (readOnly) assert.equal(writes, 0, 'recording reads must not write shared caches');
      }
      assert.deepEqual(answers[1], answers[0], mode + ': suppressing fills must not change a current hit/miss, bytes, metadata or events');
    }
  } finally { globalThis.caches = savedCaches; globalThis.fetch = savedFetch; }
};
for (const [name, test] of Object.entries(tests)) if (!selected || selected === name) { await test(); console.log('sync-stdin-rpc-surface: ' + name + ' ok'); }
