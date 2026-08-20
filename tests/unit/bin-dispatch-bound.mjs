#!/usr/bin/env bun
// A bin invocation must always come back.
//
// The program itself is bounded — FACET_TIMEOUT_MS kills a one-shot facet and
// the session reports exit 124 with a reason. Nothing bounded the supervisor
// work around it (prefetch-bundle walk, ESM transform, artifact staging, the
// loader hop) and nothing bounded the staged-artifact dispatch at all, so a
// dispatch that never settled left `running` stuck true on the shell: every
// later keystroke swallowed, no prompt, no reason. Live-observed as a terminal
// that goes permanently silent (scratchpad/pi-help-lost-exit-hang.md).
//
// What has to hold: the bound exists, it is derived from the bound it sits
// outside so the two cannot disagree, it is generous enough that the heaviest
// bins we ship for stay well inside it, and expiry is reported rather than
// hung on — including not turning the abandoned work into an unhandled
// rejection, which would take the whole DO down instead.

import assert from 'node:assert/strict';
import {
  FACET_TIMEOUT_MS,
} from '../../packages/core/src/constants.ts';
import {
  BIN_DISPATCH_TIMEOUT_MS,
  awaitBinDispatch,
} from '../../packages/worker/src/shell/npm-bin-entrypoints.ts';

// ── the bound itself ────────────────────────────────────────────────────────

assert.equal(
  BIN_DISPATCH_TIMEOUT_MS,
  2 * FACET_TIMEOUT_MS,
  'the invocation bound must be derived from FACET_TIMEOUT_MS, not chosen independently',
);

// It has to sit OUTSIDE the program's own bound, or it pre-empts the honest
// "[process killed: timeout after 30s]" the facet path already produces.
assert.ok(
  BIN_DISPATCH_TIMEOUT_MS > FACET_TIMEOUT_MS,
  `the invocation bound (${BIN_DISPATCH_TIMEOUT_MS}ms) must outlive the program bound ` +
    `(${FACET_TIMEOUT_MS}ms) so the facet's own reason wins`,
);

// Measured against a deployed Worker: the heaviest npm bin observed
// (`pi --version`, a 17.4 MiB module map) returns in 16s and every staged
// opencode one-shot in 2-4s. Anything that would cut those is the bug again
// under a new number.
assert.ok(
  BIN_DISPATCH_TIMEOUT_MS >= 40_000,
  `${BIN_DISPATCH_TIMEOUT_MS}ms would abandon bins that are measured to succeed`,
);

// ── expiry is reported, not hung on ─────────────────────────────────────────

const never = new Promise(() => {});
const t0 = Date.now();
const expired = await awaitBinDispatch(never, 30);
assert.deepEqual(expired, { expired: true }, 'a dispatch that never settles must report expiry');
assert.ok(Date.now() - t0 < 2_000, 'expiry must be reported at the bound, not later');

// ── a dispatch that settles in time is passed through untouched ─────────────

assert.deepEqual(
  await awaitBinDispatch(Promise.resolve(0), 5_000),
  { expired: false, value: 0 },
  'exit 0 must survive the bound — a bound that swallows results is worse than none',
);

// A rejection is the caller's to report ("bin error: …"), not something the
// bound converts into a timeout.
await assert.rejects(
  () => awaitBinDispatch(Promise.reject(new Error('boom')), 5_000),
  /boom/,
  'a failing dispatch must still surface its own error',
);

// ── the abandoned work must not take the session down with it ───────────────
//
// Once we stop listening, work we walked away from can still reject. An
// unhandled rejection inside the supervisor DO is not a lost error message,
// it is a dead session — exactly the failure this bound exists to prevent.

let unhandled = null;
const onUnhandled = (e) => { unhandled = e; };
process.on('unhandledRejection', onUnhandled);

let rejectLate;
const late = new Promise((_resolve, reject) => { rejectLate = reject; });
assert.deepEqual(await awaitBinDispatch(late, 20), { expired: true });
rejectLate(new Error('late failure of an abandoned dispatch'));
await new Promise((r) => setTimeout(r, 200));
process.off('unhandledRejection', onUnhandled);
assert.equal(unhandled, null, 'an abandoned dispatch must not surface as an unhandled rejection');

console.log(
  `ok - bin-dispatch-bound (invocation bounded at ${BIN_DISPATCH_TIMEOUT_MS / 1000}s, ` +
    `outside the ${FACET_TIMEOUT_MS / 1000}s a program is given to run)`,
);
