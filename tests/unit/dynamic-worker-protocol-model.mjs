#!/usr/bin/env bun
// The Dynamic Worker ledger's deadlock protocol, checked exhaustively at a
// small scope: the real ledger, fake processes, and every interleaving of
// reports, news (produced, sent and delivered out of order, waking its guest
// or not), child exits, refused spawns, admissions and refusals, up to the
// order of moves only one guest can see (lib/ledger-protocol-model.mjs).
//
// What must hold, in every run:
//   - never a refusal while any process holding a worker can still make
//     progress;
//   - always a refusal when all of them are truly stuck: every run ends with
//     every process done.
//
// Scope: every family of one or two guest holders (side by side, or one
// under the other) with up to two children each of three kinds (a child
// queued for a worker, a builtin running in the session, a shell line over a
// queued program). Three holders: dynamic-worker-protocol-model-three.
//
// The checker's teeth: three protocols each broken one way, on the current
// ledger, are each caught. Run against the protocol of f5faea96e (through an
// adapter for its API), the model found its three holes: a report sent
// before news and taken after it (finish:10 → finish:20 →
// deliverReport:20 → output:20 → deliverReport:10, refused 21 while 10 had
// news to act on); a reply delivered before an earlier one, the later
// number acknowledged; and `sh -c` over a queued program, which ended stuck.

import assert from 'node:assert/strict';
import { CURRENT_PROTOCOL, describe, explore } from './lib/ledger-protocol-model.mjs';

const KINDS = ['q', 'b', 's'];
/** Every multiset of up to `n` child kinds. */
function childSets(n) {
  const sets = [[]];
  for (let size = 1; size <= n; size++) {
    const grow = (from, acc) => {
      if (acc.length === size) { sets.push(acc); return; }
      for (let k = from; k < KINDS.length; k++) grow(k, [...acc, KINDS[k]]);
    };
    grow(0, []);
  }
  return sets;
}

/** [family, focus] pairs: focus is the one holder whose news and reports race (null: all of them). */
const cases = [];
for (const a of childSets(2)) {
  cases.push([[{ parent: 'R', children: a }], null]);
  for (const b of childSets(2)) {
    cases.push([[{ parent: 'R', children: a }, { parent: 'R', children: b }], null]);
    cases.push([[{ parent: 'R', children: a }, { parent: 0, children: b }], null]);
  }
}
let states = 0;
const t0 = Date.now();
for (const [family, focus] of cases) {
  const result = await explore(CURRENT_PROTOCOL, family, { focus, maxStates: 500_000 });
  states += result.states;
  if (result.found.length > 0) {
    const [f] = result.found;
    assert.fail(`${JSON.stringify(family)} (focus ${focus}): ${f.violation}\n  ${describe(f.path)}`);
  }
}
console.log(`  ${cases.length} families, ${states} states, ${Date.now() - t0} ms: no violation`);

// ── the checker's teeth ──────────────────────────────────────────────────────
const mutants = {
  // The guest acknowledges the highest number it has received, claiming the
  // replies still in flight below it.
  'acknowledges the highest number, not the contiguous run': {
    ...CURRENT_PROTOCOL,
    apply(guest, carried) { for (const n of carried) if (n > guest.ack.frontier) guest.ack.frontier = n; },
    family: [{ parent: 'R', children: ['q'] }, { parent: 0, children: ['q'] }, { parent: 0, children: ['q'] }],
    focus: 10,
    expect: /refused .* while a holder could still make progress/,
  },
  // The session takes a report as current when it arrives, whatever news
  // was issued after it was sent.
  'takes a late report as current': {
    ...CURRENT_PROTOCOL,
    deliverReport(ctx, pid, report) {
      const issued = this.ledger.loaderLedgerStats(ctx).news[pid]?.issued ?? 0;
      this.ledger.setProcessBlocked(ctx, pid, { ...report, frontier: issued });
    },
    family: [{ parent: 'R', children: ['q'] }, { parent: 0, children: ['q'] }],
    focus: null,
    expect: /refused .* while a holder could still make progress/,
  },
  // The wait-for edges are the pids a guest names: a shell child is opaque.
  'builds edges from guest-named pids': {
    ...CURRENT_PROTOCOL,
    graph: (run) => ({ children: (pid) => run.children(pid), awaits: () => null }),
    family: [{ parent: 'R', children: ['s'] }],
    focus: null,
    expect: /ended stuck with no refusal/,
  },
};
for (const [name, mutant] of Object.entries(mutants)) {
  const { found } = await explore(mutant, mutant.family, { focus: mutant.focus, maxStates: 500_000 });
  assert.ok(found.length > 0, `the model catches a protocol that ${name}`);
  assert.match(found[0].violation, mutant.expect, `${name}: ${found[0].violation}`);
  console.log(`  caught: a protocol that ${name} (${found[0].violation}; ${describe(found[0].path)})`);
}

console.log('ok - dynamic-worker-protocol-model (no refusal while a holder can progress, and one whenever all are stuck, over every interleaving; three broken protocols caught)');
