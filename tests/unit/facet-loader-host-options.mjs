#!/usr/bin/env bun
// facet-loader-host-options — the port's spec, as the loader pool reads it.
//
// `loaderFacetHost` is a rename and nothing else, which is exactly why it needs
// a test: every runtime that used to construct a NimbusIsolatePool by hand now
// states a FacetSpec instead, and a rename that lands one option in the wrong
// place is invisible until production behaves differently.
//
// Two mappings carry real consequences, and both are asserted here against
// what the pool actually built rather than against the adapter's source:
//
//   syscalls → omitSupervisor + supervisorPid. The supervisor derives the
//     WRITE credential from the pid, so a facet handed the capability without
//     one reads the session and silently writes nowhere. Ruby and CPython
//     depend on this being the invoking process's pid.
//
//   reuse → cacheScope. `session` (the default) bakes the owning DO id into
//     the loader cache key so a warm isolate can never answer for another
//     tenant. `global` is what lets clang's 31 MiB of compiled compiler stay
//     warm across sessions, and it is only safe because that facet holds no
//     supervisor and keeps nothing between calls.
//
// And one binding: the network. Every facet the host opens goes out through
// the workspace's (its egress as the facet's globalOutbound, its id in the
// loader id), whichever runtime opened it; the host a FacetManager's runtimes
// use (facetHostForManager: CPython, Ruby, Bash, Clang, the JS REPLs) takes
// the manager's network, and the REPLs that build their own pools take it
// from the same accessor.

import assert from 'node:assert/strict';

import { facetHostForManager, getFacetManagerLoaderHost, loaderFacetHost } from '../../packages/worker/src/runtime/facet-loader-host.ts';
import { adoptCtxExports, composeFabric } from '../../packages/fabric/src/composition.ts';
import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { ISOLATE_NETWORK, workspaceNetwork } from '../../packages/core/src/_shared/workspace-network.ts';

// The pool mints its SUPERVISOR through ctx.exports; without one it degrades
// to no binding at all, which would make the pid assertion below vacuous.
composeFabric({ supervisorEntrypoint: 'SupervisorRPC' });
adoptCtxExports({ SupervisorRPC: (options) => ({ supervisorProps: options.props }) });

const DO_ID = 'session-do-id-0123456789';

function harness() {
  const dispatched = [];
  const env = {
    LOADER: {
      load() { throw new Error('unused'); },
      get(id, build) {
        dispatched.push({ id, code: build() });
        return {
          getEntrypoint: () => ({ execute: async () => ({ ok: true }) }),
        };
      },
    },
  };
  return { env, ctx: { id: { toString: () => DO_ID }, waitUntil() {} }, dispatched };
}

const facetFn = async function probeFacetCall() { return { ok: true }; };

// ── A facet that acts on the session, as ruby and cpython open one ──────────
{
  const { env, ctx, dispatched } = harness();
  const facet = loaderFacetHost(env, ctx, ISOLATE_NETWORK).open({
    tag: 'probe-session',
    concurrency: 1,
    syscalls: { vfs: {}, pid: 4242 },
    preamble: 'const x = 1;',
  });
  await facet.submit(facetFn, {});

  assert.equal(dispatched.length, 1);
  const { id, code } = dispatched[0];
  assert.match(id, /^nfp:probe-session:session-do-i:/, 'the cache key is scoped to this session');
  assert.deepEqual((await code).env.SUPERVISOR.supervisorProps, { doId: DO_ID, pid: 4242, bindingKind: 'infrastructure', route: { supervisorEntrypoint: 'SupervisorRPC', hostNamespace: 'NIMBUS_SESSION', hostDispatchMethod: 'supervisorOp' } },
    'the capability is minted for the invoking process, not for pid 0');
  facet.dispose();
  console.log('  ok  syscalls become a supervisor bound to that pid, in a session-scoped slot');
}

// ── A sealed facet, as clang opens one ──────────────────────────────────────
{
  const { env, ctx, dispatched } = harness();
  const facet = loaderFacetHost(env, ctx, ISOLATE_NETWORK).open({
    tag: 'probe-sealed',
    concurrency: 1,
    reuse: 'global',
    preamble: 'const x = 1;',
  });
  await facet.submit(facetFn, {});

  assert.equal(dispatched.length, 1);
  const { id, code } = dispatched[0];
  assert.match(id, /^nfp:probe-sealed:global:/, 'a sealed facet is warm for every tenant');
  assert.equal((await code).env, undefined, 'and holds no capability over any session');
  facet.dispose();
  console.log('  ok  reuse:global drops the session from the cache key, with no supervisor bound');
}

// ── The network: every facet goes out through the workspace's ─────────────
{
  const egress = { fetch: async () => new Response('egress'), connect() { throw new Error('no TCP'); } };
  const network = workspaceNetwork(egress);
  /** What a facet opened by `host` was loaded with: its loader id and its config. */
  const loaded = async (host, harnessed) => {
    const facet = host.open({ tag: 'probe-network', concurrency: 1, syscalls: { vfs: {}, pid: 7 }, preamble: 'const x = 1;' });
    await facet.submit(facetFn, {});
    facet.dispose();
    assert.equal(harnessed.dispatched.length, 1);
    return { id: harnessed.dispatched[0].id, config: await harnessed.dispatched[0].code };
  };
  const managerOver = (harnessed, hooks) => new FacetManager(
    { ...harnessed.ctx, storage: { get: async () => undefined, put: async () => {}, delete: async () => false, list: async () => new Map() } },
    harnessed.env, new SessionProcessSupervisor(), new PortRegistry(), processHostFor, hooks,
  );

  {
    const harnessed = harness();
    const { id, config } = await loaded(loaderFacetHost(harnessed.env, harnessed.ctx, network), harnessed);
    assert.equal(config.globalOutbound, egress, 'the facet goes out through the egress');
    assert.ok(id.includes(network.id), `its loader id is the egress's own (${id})`);
    assert.equal(config.env.SUPERVISOR.supervisorProps.egress, egress, 'and so do its supervisor calls');
  }
  {
    const harnessed = harness();
    const manager = managerOver(harnessed, { network: () => network });
    assert.equal(getFacetManagerLoaderHost(manager).network, network, "the manager's runtimes build pools over its network");
    const { id, config } = await loaded(facetHostForManager(manager), harnessed);
    assert.equal(config.globalOutbound, egress, "a facet a manager's runtime opens goes out through the egress");
    assert.ok(id.includes(network.id), `its loader id is the egress's own (${id})`);
  }
  {
    const harnessed = harness();
    const { config } = await loaded(facetHostForManager(managerOver(harnessed, {})), harnessed);
    assert.equal('globalOutbound' in config, false, "without an egress the loader's default stands");
  }
  console.log("  ok  every facet the host opens goes out through the workspace's network, a manager's runtimes' too");
}

console.log('facet-loader-host-options: ok');
