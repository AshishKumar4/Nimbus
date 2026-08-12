#!/usr/bin/env bun
// The one-shot entry drain must not be a second, tighter timeout.
//
// A one-shot exec is ALREADY bounded by FACET_TIMEOUT_MS: the supervisor kills
// it with exit 124 and "[process killed: timeout after 30s]". Measured against
// a deployed Worker, floating async work of 5s / 15s / 25s completes and 40s
// is killed by that outer bound at exactly 30s — so the fixed 8s budget this
// used to carry was abandoning programs 22 seconds before anything actually
// required it, and nothing in the code said why 8s.
//
// What has to hold: the budget is DERIVED from the outer bound so it cannot
// drift from it, it gives back nearly the whole envelope, and it still stops
// early enough that the facet is alive to report the honest reason instead of
// being replaced by the supervisor's generic kill.

import assert from 'node:assert/strict';
import { FACET_TIMEOUT_MS } from '../../packages/core/src/constants.ts';
import {
  ONE_SHOT_ENTRY_DEADLINE_MS,
  ONE_SHOT_EXIT_RESERVE_MS,
  RESIDENT_BOOT_SETTLE_MS,
} from '../../packages/worker/src/facets/manager.ts';

// Derived, not chosen: raising or lowering the outer bound moves the budget
// with it, and no second number can silently disagree with the first.
assert.equal(
  ONE_SHOT_ENTRY_DEADLINE_MS,
  FACET_TIMEOUT_MS - ONE_SHOT_EXIT_RESERVE_MS,
  'the entry budget must be derived from FACET_TIMEOUT_MS, not chosen independently',
);

// It must end BEFORE the supervisor kill, or the "still in flight" reason is
// replaced by the generic "[process killed: timeout after 30s]".
assert.ok(
  ONE_SHOT_ENTRY_DEADLINE_MS < FACET_TIMEOUT_MS,
  `the entry budget (${ONE_SHOT_ENTRY_DEADLINE_MS}ms) must end before the kill at ${FACET_TIMEOUT_MS}ms`,
);

// The reserve has to cover the facet's whole post-drain tail: settling pending
// RPC, writing back __vfsWrites (bounded by MAX_RPC_SAFE_PAYLOAD_BYTES — a
// 20 MiB write-back measures ~1.5s on a deployed Worker), draining children,
// then reportExit.
assert.ok(
  ONE_SHOT_EXIT_RESERVE_MS >= 2_000,
  `${ONE_SHOT_EXIT_RESERVE_MS}ms is not enough for the facet to flush a full-size write-back and ` +
    'report its exit before the supervisor kill',
);

// And the drain must stop being the binding constraint — that is the whole
// point. Anything much tighter is the 8s bug again under a new number.
assert.ok(
  ONE_SHOT_ENTRY_DEADLINE_MS >= FACET_TIMEOUT_MS * 0.8,
  `the entry budget throws away ${FACET_TIMEOUT_MS - ONE_SHOT_ENTRY_DEADLINE_MS}ms of a program's ` +
    `${FACET_TIMEOUT_MS}ms lifetime — it is acting as a second, tighter timeout again`,
);

// A RESIDENT facet is a different question and must not be swept along with
// it: it keeps running after its boot call, and `spawnNode` awaits that call,
// so stretching its settle to the one-shot lifetime would let a server's idle
// keep-alive timer hold the shell prompt.
assert.ok(
  RESIDENT_BOOT_SETTLE_MS <= 2_000,
  `a resident facet settles its boot in ${RESIDENT_BOOT_SETTLE_MS}ms — spawnNode awaits it`,
);
assert.ok(
  RESIDENT_BOOT_SETTLE_MS < ONE_SHOT_ENTRY_DEADLINE_MS / 4,
  'the resident boot settle must stay clearly distinct from the one-shot lifetime budget',
);

console.log(
  `ok - facet-lifetime-budget (entry budget ${ONE_SHOT_ENTRY_DEADLINE_MS}ms of a ` +
    `${FACET_TIMEOUT_MS}ms lifetime, ${ONE_SHOT_EXIT_RESERVE_MS}ms reserved to report, ` +
    `resident boot settle ${RESIDENT_BOOT_SETTLE_MS}ms)`,
);
