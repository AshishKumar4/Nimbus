#!/usr/bin/env bun
// Every place facets are made states their network (Kinu ask 20; the egress
// review's last P2), so a facet working for a workspace cannot leave its
// egress by omission:
//
//   (1) IsolatePool, Fanout, loaderFacetHost and localFacetHost each refuse,
//       by name, to be made without a network: the workspace's, or
//       ISOLATE_NETWORK, which Nimbus's own work states;
//   (2) localFacetHost binds the network it is given: a facet's fetch goes
//       out through the egress (its body streamed, as a realm's fetch is,
//       runtime/realm-egress.ts), and its WebSocket, which cannot cross the
//       realm, is refused by name; with ISOLATE_NETWORK the facet's fetch is
//       its realm's own, and the egress sees nothing.
//
// Run by bun, it checks the source under Bun (where a facet is a process),
// then runs itself under node against the built package (packages/core/dist,
// packages/fabric/dist: rebuild first), where a facet is a worker thread.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const underBun = typeof process.versions.bun === 'string';
const core = underBun ? '../../packages/core/src' : '../../packages/core/dist';
const fabric = underBun ? '../../packages/fabric/src' : '../../packages/fabric/dist';
const ext = underBun ? 'ts' : 'js';
const { ISOLATE_NETWORK, workspaceNetwork } = await import(`${core}/_shared/workspace-network.${ext}`);
const { localFacetHost } = await import(`${core}/runtime/local-facet-host.${ext}`);
const { IsolatePool } = await import(`${fabric}/isolate-pool.${ext}`);
const { Fanout } = await import(`${fabric}/fanout.${ext}`);

// ── (1) no facet without a network ─────────────────────────────────────────
{
  const env = { LOADER: { load() { throw new Error('unused'); }, get() { throw new Error('unused'); } } };
  const ctx = { id: { toString: () => 'boundaries' }, waitUntil() {} };
  const refusal = (who) => ({ name: 'TypeError', message: `${who}: a network is required: the workspace's (workspace.network), or ISOLATE_NETWORK for Nimbus's own work` });
  assert.throws(() => new IsolatePool(env, ctx, { tag: 't', omitSupervisor: true }), refusal('IsolatePool'), '(1) IsolatePool');
  assert.throws(() => new Fanout(env, ctx, { tag: 't', omitSupervisor: true }), refusal('Fanout'), '(1) Fanout');
  assert.throws(() => localFacetHost(), refusal('localFacetHost'), '(1) localFacetHost');
  if (underBun) {
    const { loaderFacetHost } = await import('../../packages/worker/src/runtime/facet-loader-host.ts');
    assert.throws(() => loaderFacetHost(env, ctx), refusal('loaderFacetHost'), '(1) loaderFacetHost');
  }
  // Stated, each is made.
  new IsolatePool(env, ctx, { tag: 't', omitSupervisor: true, network: ISOLATE_NETWORK });
  new Fanout(env, ctx, { tag: 't', omitSupervisor: true, network: ISOLATE_NETWORK });
}

// ── (2) a local facet goes out through the network it is given ─────────────
{
  const egress = {
    seen: [],
    async fetch(request) {
      this.seen.push(`${request.method} ${new URL(request.url).pathname}`);
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('egress answered '));
          controller.enqueue(new TextEncoder().encode(new URL(request.url).pathname));
          controller.close();
        },
      }));
    },
    connect() { throw new Error('this egress carries no TCP'); },
  };
  const probe = async function probeNetwork(url) {
    let socket;
    try { new WebSocket('wss://facet.invalid/'); socket = 'opened'; } catch (error) { socket = error.message; }
    try { return { body: await (await fetch(url)).text(), socket }; } catch (error) { return { error: `${error.name}: ${error.message} (${error.cause?.message})`, socket }; }
  };

  const facet = localFacetHost(workspaceNetwork(egress)).open({ tag: 'egress-probe' });
  try {
    const through = await facet.submit(probe, 'https://facet.invalid/through-the-egress', { timeoutMs: 30_000 });
    assert.deepEqual(through, {
      body: 'egress answered /through-the-egress',
      socket: "Nimbus: WebSocket is not available to facet 'egress-probe' when the workspace's network goes through an egress",
    }, '(2) the facet went out through the egress, and its WebSocket was refused by name');
    assert.deepEqual(egress.seen, ['GET /through-the-egress']);
  } finally {
    facet.dispose();
  }

  // ISOLATE_NETWORK: the realm's own fetch, to a server of this process's.
  const server = createServer((req, res) => res.end(`own network ${req.url}`));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const own = localFacetHost(ISOLATE_NETWORK).open({ tag: 'own-probe' });
  try {
    const direct = await own.submit(async function direct(url) { return (await fetch(url)).text(); }, `http://127.0.0.1:${server.address().port}/direct`, { timeoutMs: 30_000 });
    assert.equal(direct, 'own network /direct', "(2) with ISOLATE_NETWORK the facet's fetch is its own");
    assert.deepEqual(egress.seen, ['GET /through-the-egress'], '(2) and the egress saw nothing of it');
  } finally {
    own.dispose();
    server.close();
  }
}

if (underBun) {
  const node = spawnSync('node', ['--no-warnings', fileURLToPath(import.meta.url)], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(node.status, 0, `under node:\n${node.stdout}${node.stderr}`);
  assert.match(node.stdout, /^ok - under node/m, node.stdout);
  console.log('ok - workspace-egress-boundaries (no pool, fanout or facet host without a network; a local facet goes out through its egress; under Bun and Node)');
} else {
  console.log('ok - under node');
}
