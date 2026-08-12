#!/usr/bin/env bun
// fanout-peer-cap — a fan-out may bound how many peer DOs one submitMany
// spreads across, without dropping tasks, reordering results, or lowering
// concurrency.
//
// Why this exists: the npm resolver dispatched ONE peer DO per package.
// Peers dispatch in phases of FANOUT_PHASE_SIZE and every phase is a hard
// barrier, so a layer of width W paid ⌈min(W,32)/4⌉ sibling-DO cold starts
// to perform W cached-packument reads. Measured on a 123-package install
// (@earendil-works/pi-coding-agent, 2026-08-11): 8 layers, 23 barriers,
// 27-34 s of resolve in which every single packument was a cache hit.
// Capping peers is what INSTALL_PEER_CAP already does on the write side.

import assert from 'node:assert/strict';
import {
  NimbusFanoutPool,
  FANOUT_PHASE_SIZE,
  MAX_PEER_FANOUT,
} from '../../packages/worker/src/loaders/fanout-pool.ts';

function makeEnv(seen) {
  return {
    LOADER: { get() { return {}; } },
    NIMBUS_SESSION: {
      idFromName(name) { return { toString: () => name, name }; },
      get(id) {
        return {
          async _rpcFanoutExecute(_fnSource, args) {
            seen.push({ peer: id.name, count: args.length });
            return { results: args };
          },
        };
      },
    },
  };
}
const ctx = { id: { toString: () => 'coord-do-id-abcdef' } };

/** Run `count` tasks through a pool and report peers used + barriers paid. */
async function dispatch(count, opts = {}) {
  const seen = [];
  const phases = [];
  const pool = new NimbusFanoutPool(makeEnv(seen), ctx, {
    tag: 'peer-cap-test',
    omitSupervisor: true,
    onDispatchPhase: (width) => phases.push(width),
    ...opts,
  });
  const tasks = Array.from({ length: count }, (_, i) => ({ key: `pkg-${i}`, args: i }));
  const results = await pool.submitMany(tasks, (x) => x);
  return {
    results,
    peers: new Set(seen.map((s) => s.peer)),
    barriers: phases.length,
    dispatched: seen.reduce((n, s) => n + s.count, 0),
  };
}

const WIDTH = 33; // a real resolve-layer width from the measured pi install

// ── Uncapped: one peer per task, and a barrier for every FANOUT_PHASE_SIZE
{
  const r = await dispatch(WIDTH);
  assert.deepEqual(r.results, Array.from({ length: WIDTH }, (_, i) => i),
    'uncapped: results in input order');
  assert.equal(r.dispatched, WIDTH, 'uncapped: every task dispatched exactly once');
  // Keys hash onto min(WIDTH, MAX_PEER_FANOUT) slots, so collisions leave
  // somewhat fewer distinct peers than tasks — but the fan-out is still
  // peer-per-task in shape, and far wider than any cap below.
  assert.ok(r.peers.size > FANOUT_PHASE_SIZE * 2,
    `uncapped: fans out past two phases (got ${r.peers.size} peers)`);
  assert.ok(r.peers.size <= Math.min(WIDTH, MAX_PEER_FANOUT),
    'uncapped: never exceeds MAX_PEER_FANOUT');
  assert.equal(r.barriers, Math.ceil(r.peers.size / FANOUT_PHASE_SIZE),
    'uncapped: barriers scale with peer count');
  console.log(`  uncapped: ${r.peers.size} peers, ${r.barriers} barriers for ${WIDTH} tasks`);
}

// ── Capped: same tasks, bounded peers, proportionally fewer barriers
{
  const CAP = 8;
  const r = await dispatch(WIDTH, { maxPeers: CAP });
  assert.deepEqual(r.results, Array.from({ length: WIDTH }, (_, i) => i),
    'capped: results still in input order');
  assert.equal(r.dispatched, WIDTH, 'capped: every task still dispatched exactly once');
  assert.ok(r.peers.size <= CAP, `capped: at most ${CAP} peers (got ${r.peers.size})`);
  assert.equal(r.barriers, Math.ceil(r.peers.size / FANOUT_PHASE_SIZE),
    'capped: barriers follow the capped peer count');
  assert.ok(r.barriers <= Math.ceil(CAP / FANOUT_PHASE_SIZE),
    `capped: ${WIDTH} tasks cost at most ${Math.ceil(CAP / FANOUT_PHASE_SIZE)} barriers`);
  console.log(`  capped@${CAP}: ${r.peers.size} peers, ${r.barriers} barriers for ${WIDTH} tasks`);
}

// ── The cap never invents peers for a fan-out narrower than it
{
  const r = await dispatch(6, { maxPeers: 8 });
  assert.equal(r.peers.size, 6, 'cap above task count leaves one peer per task');
  assert.equal(r.dispatched, 6, 'all tasks dispatched');
  console.log(`  narrow: ${r.peers.size} peers for 6 tasks (cap 8, unchanged)`);
}

// ── A cap of 1 collapses to a single peer running the whole layer
{
  const r = await dispatch(WIDTH, { maxPeers: 1 });
  assert.equal(r.peers.size, 1, 'cap of 1 uses exactly one peer');
  assert.equal(r.dispatched, WIDTH, 'that peer receives every task');
  assert.equal(r.barriers, 1, 'and the layer costs a single barrier');
  console.log(`  cap@1: 1 peer, 1 barrier, ${r.dispatched} tasks`);
}

console.log('fanout-peer-cap: PASS');
