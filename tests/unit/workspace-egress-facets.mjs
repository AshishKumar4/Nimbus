#!/usr/bin/env bun
// Under a workspace egress, everything Nimbus loads or binds for the
// workspace takes it, and nothing more is loaded without it:
//
//   - git: every facet an operation loads (clone, fetch, pull, push, the
//     promisor's fetch-objects) states the egress as its globalOutbound, and
//     its SUPERVISOR binding carries it; without one, no globalOutbound;
//   - a pool (npm's resolve and install fanouts, the REPLs): each facet's
//     globalOutbound is the egress, its loader id is the egress's own, and a
//     peer's rebuilt network has the coordinator's identity;
//   - a process binding: SupervisorRPC's fetch, its plain TCP connect and its
//     WebSocket relay go out through the egress; its TLS socket is refused
//     by name and never opened;
//   - npm's packument read-through: under an egress the shared cache is
//     neither read nor written; the egress answers.

import assert from 'node:assert/strict';
import { mock } from 'bun:test';

mock.module('cloudflare:workers', () => ({
  WorkerEntrypoint: class { constructor(ctx, env) { this.ctx = ctx; this.env = env; } },
  RpcTarget: class {},
}));

import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { IsolatePool } from '../../packages/fabric/src/isolate-pool.ts';
import { supervisorBindingProps } from '../../packages/fabric/src/supervisor-props.ts';
import {
  EGRESS_TLS_REFUSAL, ISOLATE_NETWORK, networkRef, workspaceNetwork,
} from '../../packages/core/src/_shared/workspace-network.ts';
import { stagedAssets } from './lib/staged-assets.mjs';

const { SupervisorRPC } = await import('../../packages/worker/src/session/supervisor-rpc.ts');
const { execGitNetwork } = await import('../../packages/worker/src/git/network-facet.ts');
const { WebSocketRelay } = await import('../../packages/worker/src/session/ws-relay.ts');
const { R2CacheClient } = await import('../../packages/worker/src/npm/r2-cache.ts');

function recordingEgress() {
  const seen = [];
  return {
    seen,
    async fetch(request) {
      seen.push(`${request.method} ${request.url}`);
      return new Response('egress', { headers: { 'x-egress': 'yes' } });
    },
  };
}

// ── git: every facet load, under the egress ──────────────────────────────
{
  const egress = recordingEgress();
  const network = workspaceNetwork(egress);
  const loads = [];
  const boundProps = [];
  adoptCtxExports({ SupervisorRPC(options) { boundProps.push(options.props); return { [Symbol.dispose]() {} }; } });
  const entrypoint = {
    async fetch() {
      return Response.json({ success: true, filesWritten: 0, bytesWritten: 0, supervisorRpc: {}, metadataOverlay: {} });
    },
    [Symbol.dispose]() {},
  };
  const env = {
    ASSETS: stagedAssets,
    LOADER: { load(code) { loads.push(code); return { getEntrypoint: () => entrypoint, [Symbol.dispose]() {} }; } },
  };
  const ctx = { id: { toString: () => 'egress-git' } };
  for (const op of ['fetch', 'pull', 'push', 'fetch-objects']) {
    const before = loads.length;
    const result = await execGitNetwork(ctx, env, {
      op, dir: '/home/user/repo', pid: 42, remote: 'origin', url: 'https://example.test/r.git', oids: ['a'.repeat(40)],
    }, network);
    assert.equal(result.success, true, `${op}: ${result.error}`);
    assert.ok(loads.length > before, `${op} loaded no facet`);
    for (const code of loads.slice(before)) assert.equal(code.globalOutbound, egress, `${op}: a facet was loaded without the egress`);
  }
  assert.ok(boundProps.length > 0 && boundProps.every((props) => props.egress === egress && props.networkId === network.id),
    'a git SUPERVISOR binding lacked the egress');

  loads.length = 0;
  boundProps.length = 0;
  const plain = await execGitNetwork(ctx, env, { op: 'fetch', dir: '/home/user/repo', pid: 42 }, ISOLATE_NETWORK);
  assert.equal(plain.success, true, plain.error);
  assert.ok(loads.every((code) => !('globalOutbound' in code)), 'without an egress git stated a globalOutbound');
  assert.ok(boundProps.every((props) => !('egress' in props)), 'without an egress the binding carried one');
}

// ── A pool's facets ──────────────────────────────────────────────────────
{
  const egress = recordingEgress();
  const network = workspaceNetwork(egress);
  const configs = [];
  const loaderIds = [];
  const fakeWorker = { getEntrypoint: () => ({ async fetch() { return Response.json({ ok: true, value: 1 }); } }) };
  const env = {
    LOADER: {
      get(id, configCallback) { loaderIds.push(id); configs.push(configCallback); return fakeWorker; },
      load(config) { configs.push(() => config); return fakeWorker; },
    },
  };
  const ctx = { id: { toString: () => 'egress-pool-do' }, exports: {} };
  for (const [label, poolNetwork] of [['egress', network], ['none', ISOLATE_NETWORK]]) {
    configs.length = 0;
    loaderIds.length = 0;
    const pool = new IsolatePool(env, ctx, { tag: 'egress-test', concurrency: 1, omitSupervisor: true, network: poolNetwork });
    await pool.submit(async () => 1).catch(() => undefined);
    const resolved = await Promise.all(configs.map((make) => make()));
    assert.ok(resolved.length > 0, `${label}: the pool loaded nothing`);
    for (const config of resolved) {
      if (poolNetwork.egress) assert.equal(config.globalOutbound, egress, 'a pool facet was loaded without the egress');
      else assert.ok(!('globalOutbound' in config), 'under ISOLATE_NETWORK the pool stated a globalOutbound');
    }
    if (poolNetwork.egress) assert.ok(loaderIds.every((id) => id.endsWith(':' + network.id)), 'a pool loader id is not the egress\'s own: ' + loaderIds);
  }
  // A peer rebuilds the coordinator's network with its identity.
  const ref = networkRef(network);
  assert.equal(ref.egress, egress);
  assert.equal(workspaceNetwork(ref.egress, ref.id).id, network.id);
  assert.equal(networkRef(ISOLATE_NETWORK), undefined);
}

// ── A process binding's network ──────────────────────────────────────────
{
  const egress = recordingEgress();
  const network = workspaceNetwork(egress);
  const ctx = { id: { toString: () => 'egress-binding' } };
  const props = supervisorBindingProps(ctx, 7, { writerId: 'w', network });
  assert.equal(props.egress, egress);
  assert.equal(props.networkId, network.id);
  const plain = supervisorBindingProps(ctx, 7, { writerId: 'w', network: ISOLATE_NETWORK });
  assert.ok(!('egress' in plain) && !('networkId' in plain), 'without an egress the binding carried one');

  // The WebSocket relay opens a process's socket through the workspace's network.
  const opened = [];
  const relay = new WebSocketRelay(() => workspaceNetwork({
    async fetch(request) {
      opened.push(`${request.headers.get('upgrade')} ${request.url} ${request.headers.get('authorization')}`);
      return new Response('no', { status: 404 });
    },
    connect() { throw new Error('no TCP'); },
  }));
  const refused = await relay.open(7, 'wss://example.test/socket', [], [['Authorization', 'Bearer t']]);
  assert.equal(refused.refused.status, 404, 'the egress answered the upgrade');
  assert.deepEqual(opened, ['websocket https://example.test/socket Bearer t']);

  assert.match(EGRESS_TLS_REFUSAL, /TLS sockets are not available.*egress.*plain TCP only/);

  // SupervisorRPC: a process's fetch goes out through its binding's egress, every plan of it;
  // its TLS socket is refused by name, before the session is asked.
  const isolateFetch = globalThis.fetch;
  globalThis.fetch = async (input) => { throw new Error('the isolate network was used: ' + (input.url ?? input)); };
  try {
    for (const plan of [{ live: 'ticket' }, { unrecorded: true }]) {
      const asked = [];
      const rpc = new SupervisorRPC({ props: { doId: 's', pid: 7, writerId: 'a', egress, networkId: network.id } }, {
        NIMBUS_SESSION: { idFromName: (id) => id, idFromString: (id) => id, get: () => ({ supervisorOp: async (e) => {
          asked.push(e.args[0]);
          return e.args[0] === 'fetch' ? plan : true;
        } }) },
      });
      const before = egress.seen.length;
      const response = await rpc.fetch(new Request('https://example.test/child'));
      assert.equal(await response.text(), 'egress', JSON.stringify(plan));
      assert.deepEqual(egress.seen.slice(before), ['GET https://example.test/child'], JSON.stringify(plan));
      // An effect (not GET or HEAD) is recorded as one and goes out the same way.
      const posted = await rpc.fetch(new Request('https://example.test/effect', { method: 'POST', body: 'x' }));
      assert.equal(await posted.text(), 'egress');
      assert.equal(egress.seen.at(-1), 'POST https://example.test/effect');
      await assert.rejects(rpc.netTls('open', 'tok', { host: 'example.test', port: 443 }), (error) => error.message === EGRESS_TLS_REFUSAL);
      assert.ok(!asked.includes('netTls'), 'a TLS socket reached the session under an egress');
    }
  } finally {
    globalThis.fetch = isolateFetch;
  }
}

// ── npm's packument read-through ─────────────────────────────────────────
{
  const egress = recordingEgress();
  egress.fetch = async (request) => {
    egress.seen.push(`${request.method} ${request.url}`);
    return Response.json({ name: 'left-pad', versions: {}, 'dist-tags': {} });
  };
  const reads = [];
  const writes = [];
  const bucket = {
    async get(key) { reads.push(key); return null; },
    async put(key) { writes.push(key); },
    async head() { return null; },
  };
  const client = new R2CacheClient(bucket, bucket, false);
  const got = await client.readThroughPackument('left-pad', { retries: 0 }, workspaceNetwork(egress));
  assert.equal(got.source, 'network');
  assert.equal(JSON.parse(got.json).name, 'left-pad');
  assert.deepEqual(egress.seen, ['GET https://registry.npmjs.org/left-pad']);
  assert.deepEqual(reads, [], 'the shared cache was read under an egress');
  assert.deepEqual(writes, [], 'what the egress answered was written to the shared cache');
}

console.log('workspace-egress-facets: ok');
