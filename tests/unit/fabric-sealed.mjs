#!/usr/bin/env bun
// Prototype-chain RPC sealing, and the drift test that is the point of
// owning the surface constants.
//
// Cloudflare resolves stub.foo() on the receiver's prototype chain, and own
// instance properties are NOT reachable — workerd rejects them exactly as it
// rejects a missing name, including when the own property shadows a
// prototype method (Proteus rpc-surface.ts:4-22, proven against workerd via
// miniflare). Sealing shadows every non-allowlisted reachable member with a
// non-enumerable own property carrying the SAME descriptor, so in-process
// behaviour cannot change while the name stops resolving over RPC.
//
// The constants break whenever the SDK adds a cross-stub call — Proteus
// reverse-engineered its list from agents/dist by hand — so this file diffs
// them against the INSTALLED agents and partyserver packages: a version bump
// that changes the cross-stub set fails here, in CI, instead of leaking.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { plugin } from 'bun';
import {
  AGENTS_FACET_RPC_SURFACE,
  AGENTS_INVOKE_BRIDGES,
  PLATFORM_RPC_SURFACE,
  rpcReachableNames,
  sealRpcSurface,
} from '../../packages/fabric/src/sealed.ts';

/** workerd's resolution rule: found on the prototype chain, not shadowed by
 *  an own property, and not `constructor`. */
function rpcResolves(instance, name) {
  if (name === 'constructor') return false;
  if (Object.getOwnPropertyNames(instance).includes(name)) return false;
  let proto = Object.getPrototypeOf(instance);
  while (proto && proto !== Object.prototype) {
    if (Object.getOwnPropertyNames(proto).includes(name)) return true;
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}

// ── 1. Sealing mechanics, on a hierarchy shaped like the real hazard ────────

{
  class SdkBase {
    sql(query) { return `ran:${query}`; }
    get databaseSize() { return 42; }
  }
  class Mid extends SdkBase {
    helper() { return 'mid'; }
    allowed() { return `allowed:${this.secretValue()}`; }
  }
  class Leaf extends Mid {
    constructor() {
      super();
      this.ownState = () => 'own';
    }
    secretValue() { return 'leaf'; }
    overridden() { return `leaf:${super.helper?.() ?? 'none'}`; }
  }

  const instance = new Leaf();
  assert.ok(rpcResolves(instance, 'sql'), 'before sealing, the inherited SQL runner is one RPC away');

  sealRpcSurface(instance, ['allowed', 'fetch']);

  // From outside: only the surface resolves.
  assert.ok(rpcResolves(instance, 'allowed'));
  assert.equal(rpcResolves(instance, 'sql'), false, 'the arbitrary-SQL hazard is sealed');
  assert.equal(rpcResolves(instance, 'helper'), false);
  assert.equal(rpcResolves(instance, 'secretValue'), false);
  assert.equal(rpcResolves(instance, 'databaseSize'), false, 'accessors seal too');

  // In process: nothing changed.
  assert.equal(instance.sql('q'), 'ran:q', 'this.sql() still works in process');
  assert.equal(instance.sql, SdkBase.prototype.sql, 'the SAME function object, not a stand-in');
  assert.equal(instance.databaseSize, 42, 'accessors stay accessors');
  assert.equal(instance.allowed(), 'allowed:leaf', 'an allowed method still reaches sealed helpers');
  assert.equal(instance.overridden(), 'leaf:mid', 'super.* still reaches the prototype');
  assert.equal(instance.ownState(), 'own', 'own instance properties ride through untouched');

  // The shadows are non-enumerable and the prototype is untouched.
  assert.ok(!Object.keys(instance).includes('sql'));
  assert.ok(Object.getOwnPropertyNames(Leaf.prototype).includes('secretValue'));

  // A surface naming something the class lacks is silently a ceiling.
  sealRpcSurface(new Leaf(), ['allowed', 'notAThing']);
}

// ── 2. rpcReachableNames is the single reachable-set definition ──────────────

{
  class A { one() {} }
  class B extends A { two() {} }
  const b = new B();
  b.ownProp = 1;
  assert.deepEqual(rpcReachableNames(b), ['one', 'two'],
    'constructor and own properties are excluded; the chain is walked to Object.prototype');
}

// ── 3. Drift: the constants against the INSTALLED SDK packages ──────────────

plugin({
  name: 'cloudflare-shims',
  setup(build) {
    build.module('cloudflare:workers', () => ({
      loader: 'object',
      exports: {
        DurableObject: class DurableObject {
          constructor(ctx, env) { this.ctx = ctx; this.env = env; }
        },
        WorkerEntrypoint: class WorkerEntrypoint {},
        RpcTarget: class RpcTarget {},
        RpcStub: class RpcStub {},
        env: {},
        exports: {},
        waitUntil: () => {},
      },
    }));
    build.module('cloudflare:email', () => ({
      loader: 'object',
      exports: { EmailMessage: class EmailMessage {} },
    }));
  },
});

const { Server } = await import('partyserver');
const { Agent } = await import('agents');

const chainNames = (Class) => {
  const names = new Set();
  let proto = Class.prototype;
  while (proto && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) names.add(name);
    proto = Object.getPrototypeOf(proto);
  }
  return names;
};

// 3a. Every platform-surface name must exist on the installed classes — a
// rename or removal invalidates the constant and must fail here.
{
  const serverNames = chainNames(Server);
  const agentNames = chainNames(Agent);
  for (const name of PLATFORM_RPC_SURFACE) {
    assert.ok(serverNames.has(name), `PLATFORM_RPC_SURFACE '${name}' is gone from partyserver Server`);
    assert.ok(agentNames.has(name), `PLATFORM_RPC_SURFACE '${name}' is gone from agents Agent`);
  }
  // 3b. Every allowed facet-surface name must still be defined on Agent.
  for (const name of [...AGENTS_FACET_RPC_SURFACE, ...AGENTS_INVOKE_BRIDGES]) {
    assert.ok(agentNames.has(name), `'${name}' is gone from agents Agent — the surface constant is stale`);
  }
}

// 3c. Every _cf_ name the installed dist calls CROSS-STUB must be classified:
// allowed on the facet surface, or a named invoke bridge. A new unclassified
// name is exactly the drift this test exists to catch.
{
  // Receivers that are a `this` alias through a closure are self-calls, not
  // cross-stub calls. Verified by reading the pinned dist: `const owner =
  // this` in _cf_parentAgentFacetProxy (agents@0.20.1 index.js:4287).
  const LOCAL_THIS_ALIASES = new Set(['_cf_isWebSocketUpgradeRequest']);

  const distDir = join(import.meta.dir, '../../node_modules/agents/dist');
  const crossStub = new Set();
  for (const file of readdirSync(distDir).filter((f) => f.endsWith('.js'))) {
    const source = readFileSync(join(distDir, file), 'utf8');
    for (const match of source.matchAll(/\._cf_([A-Za-z0-9_]+)\(/g)) {
      const receiverTail = source.slice(Math.max(0, match.index - 4), match.index);
      if (receiverTail !== 'this') crossStub.add(`_cf_${match[1]}`);
    }
  }
  assert.ok(crossStub.size >= 20, `the dist scan found only ${crossStub.size} names — discovery is broken, not clean`);

  const classified = new Set([...AGENTS_FACET_RPC_SURFACE, ...AGENTS_INVOKE_BRIDGES, ...LOCAL_THIS_ALIASES]);
  const unclassified = [...crossStub].filter((name) => !classified.has(name)).sort();
  assert.deepEqual(unclassified, [],
    'the installed agents package calls _cf_ methods the surface constants do not classify — '
      + 're-derive AGENTS_FACET_RPC_SURFACE against this version');

  // And nothing allowed may be a bridge: the two sets are disjoint by design.
  for (const name of AGENTS_FACET_RPC_SURFACE) {
    assert.ok(!AGENTS_INVOKE_BRIDGES.includes(name), `'${name}' cannot be both allowed and a bridge`);
  }
}

// 3d. Sealing a real Agent-shaped receiver hides the documented hazard while
// the SDK's cross-stub protocol keeps resolving.
{
  const instance = Object.create(Agent.prototype);
  assert.ok(rpcResolves(instance, 'sql'), 'Agent.sql is the arbitrary-SQL hazard from the evidence');
  sealRpcSurface(instance, [...PLATFORM_RPC_SURFACE, ...AGENTS_FACET_RPC_SURFACE]);
  assert.equal(rpcResolves(instance, 'sql'), false, 'sealed');
  assert.equal(rpcResolves(instance, '_cf_invokeSubAgentPath'), false, 'the invoke bridges are sealed');
  assert.ok(rpcResolves(instance, 'fetch'));
  assert.ok(rpcResolves(instance, '_cf_initAsFacet'), 'the SDK facet protocol survives sealing');
}

console.log('ok - fabric-sealed (shadow mechanics, reachable set, installed-SDK drift diff, Agent.sql sealed)');
