#!/usr/bin/env bun
// host-namespace-routing — every execution path that reaches the host DO
// resolves it through the COMPOSED namespace (composeFabric({hostNamespace})),
// never the literal env.NIMBUS_SESSION. A workspace host that names its own
// binding (the acceptance fixture names it WORKSPACES) must still get npm
// shards, peer hosts, fanout, assets and HMR relay — no functionality
// refusals.
//
// Why this exists: bindings.ts, fanout.ts, process-host.ts and
// real-vite-hmr.ts hardcoded env.NIMBUS_SESSION while SupervisorRPC alone
// used hostNamespace() — a host that renamed the binding got a supervisor
// that answered and a fan-out that refused. The behavioral part below
// drives Fanout through a WORKSPACES-only env; the seam part pins every
// site so a reintroduced literal fails this file.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Fanout } from '../../packages/fabric/src/fanout.ts';
import { composeFabric, hostNamespace } from '../../packages/fabric/src/composition.ts';

const ctx = { id: { toString: () => 'host-namespace-test-do' }, waitUntil() {} };

// ── 1. Fanout peer dispatch honors a composed WORKSPACES namespace ──────────
{
  composeFabric({ hostNamespace: 'WORKSPACES' });
  assert.equal(hostNamespace(), 'WORKSPACES');

  const seen = [];
  const env = {
    LOADER: { get() { return {}; } },
    // Deliberately NO NIMBUS_SESSION: routing through the literal name must
    // fail loudly, not silently degrade to the default.
    WORKSPACES: {
      idFromName(name) { return { toString: () => name, name }; },
      idFromString(id) { return { toString: () => id, name: id }; },
      get(id) {
        return {
          async supervisorOp(envelope) {
            const [_fnSource, args] = envelope.args;
            seen.push({ peer: id.name, count: args.length });
            return { results: args };
          },
        };
      },
    },
  };

  const pool = new Fanout(env, ctx, { tag: 'ns-test', omitSupervisor: true });
  const tasks = Array.from({ length: 5 }, (_, i) => ({ key: `t-${i}`, args: i }));
  const results = await pool.submitMany(tasks, (x) => x);
  assert.equal(results.length, 5, 'every task answered through the composed namespace');
  assert.ok(seen.length > 0, 'peer dispatch ran — the WORKSPACES stub was used');
}

// ── 2. No live env.NIMBUS_SESSION dereference survives in routed paths ──────
{
  const sites = [
    'packages/fabric/src/bindings.ts',
    'packages/fabric/src/fanout.ts',
    'packages/fabric/src/process-host.ts',
    'packages/worker/src/facets/real-vite-hmr.ts',
  ];
  for (const site of sites) {
    const source = readFileSync(new URL(`../../${site}`, import.meta.url), 'utf8');
    // Strip comments: the literal name may be QUOTED to document the
    // default, only a live property access is a routing bug.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    assert.doesNotMatch(
      code,
      /\benv\.NIMBUS_SESSION\b|\.NIMBUS_SESSION\b(?!\s*[:?])/,
      `${site}: a live .NIMBUS_SESSION dereference bypasses the composed namespace`,
    );
    assert.match(
      code,
      /\bhostNamespace(?:Binding)?\(/,
      `${site}: namespace resolution must go through the composed binding`,
    );
  }
}

console.log('host-namespace-routing: all checks passed');
