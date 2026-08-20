#!/usr/bin/env bun
// The storage-taxonomy expansion. The defect it fixes is agent-core's: every
// SQLite failure there flattens to 'protocol.invalid-state', so the 10 GB
// wall — where reads and DELETEs still work and there is a documented
// drain-to-recover path — is indistinguishable from a malformed statement.
// SQLITE_FULL and SQLITE_NOMEM are different conditions with opposite
// remedies (free space vs shrink the transaction), so they are different
// causes.

import assert from 'node:assert/strict';
import { classifyMessage, isOomCause } from '../../packages/platform/src/oom-classify.ts';
import {
  BLOCK_CONCURRENCY_CANCEL_MS,
  DO_STORAGE_LIMIT_BYTES,
  SQLITE_MAX_BOUND_PARAMETERS,
  SQLITE_MAX_ROW_BYTES,
  SQLITE_MAX_STATEMENT_BYTES,
  WS_ATTACHMENT_LIMIT_BYTES,
} from '../../packages/platform/src/limits.ts';

// The wall's observed wording (platform catalog do.storage.bytes) is its own
// cause now, not a nomem look-alike.
assert.equal(classifyMessage('database or disk is full: SQLITE_FULL'), 'sqlite_full');
assert.equal(classifyMessage('SQLITE_FULL'), 'sqlite_full');
assert.ok(isOomCause('sqlite_full'));

// NOMEM keeps its own signatures — a per-transaction memory condition.
assert.equal(classifyMessage('SQLITE_NOMEM'), 'sqlite_nomem');
assert.equal(classifyMessage('out of memory'), 'sqlite_nomem');

// The caps, as the catalog records them. Statement length is SQLite's
// compile-time SQLITE_MAX_SQL_LENGTH read as binary KiB; bound parameters is
// the cap a batched insert of more than 100/columns rows breaches.
assert.equal(SQLITE_MAX_STATEMENT_BYTES, 100 * 1024);
assert.equal(SQLITE_MAX_BOUND_PARAMETERS, 100);

// Size-accounting honesty: the 2 MB bound is per ROW (key included), not per
// value — the measured single-value ceiling is 2,199,981 bytes, ABOVE this
// constant, so budgeting per value against 2 MB is conservative and correct
// while budgeting per row against the value ceiling would not be.
assert.equal(SQLITE_MAX_ROW_BYTES, 2_000_000);
assert.ok(SQLITE_MAX_ROW_BYTES < 2_199_981);

// The 10 GB wall is decimal GB (documented), with the probed fit/fail window
// (10.58e9 fit, 11.6e9 failed) sitting above it — design to the documented
// figure, never to 10 GiB, which falls inside the window.
assert.equal(DO_STORAGE_LIMIT_BYTES, 10_000_000_000);
assert.ok(10 * 1024 ** 3 > DO_STORAGE_LIMIT_BYTES, '10 GiB is not a number to design to');

// The init-gate hazard: a blockConcurrencyWhile callback still pending ~30s
// resets the whole object (proven by probe; reset observed at 31s).
assert.equal(BLOCK_CONCURRENCY_CANCEL_MS, 30_000);

// Already landed with connections; asserted here so the limits table stays
// coherent as one surface.
assert.equal(WS_ATTACHMENT_LIMIT_BYTES, 16_384);

console.log('ok - platform-storage-taxonomy (sqlite_full split, statement/param/row caps, 10GB wall, 30s gate)');
