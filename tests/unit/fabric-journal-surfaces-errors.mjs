#!/usr/bin/env bun
// The journal's storage writes are not best-effort: a failure must reach the
// caller, not be swallowed. `journal` wraps a put/sync rejection in
// 'resident launch journal write failed' with the storage error as `cause`,
// so a launch that cannot be journalled never starts and the caller reports
// the failure. `release` lets a delete/sync rejection propagate unchanged —
// a release that swallowed would leave a row the next instance recovers as
// an owed launch for a process the user watched end.
//
// The defect this pins: journal/release/supersede caught storage errors and
// only console.warn'd them — a failing DO storage wrote nothing, the launch
// ran anyway, and the reset the journal exists for then lost the resident
// silently.

import assert from 'node:assert/strict';
import { FencedWork } from '../../packages/fabric/src/fenced-work.ts';

const host = { generationBase: () => 0, waitUntil: () => {}, redrive: async () => {} };

const quietStorage = {
  async put() {},
  async delete() { return true; },
  async list() { return new Map(); },
  async sync() {},
};

// ── 1. A `put` rejection surfaces as a journal-write failure ────────────────
{
  const work = new FencedWork(
    { ...quietStorage, async put() { throw new Error('disk full'); } },
    host,
  );
  await assert.rejects(
    work.journal({ pid: 5, command: 'x', attempt: 0, phase: 'starting' }),
    (error) => {
      assert.equal(error.message, 'resident launch journal write failed');
      assert.equal(error.cause.message, 'disk full');
      return true;
    },
  );
}

// ── 2. A `sync` rejection after a successful put fails the same way ─────────
{
  const work = new FencedWork(
    { ...quietStorage, async sync() { throw new Error('flush refused'); } },
    host,
  );
  await assert.rejects(
    work.journal({ pid: 6, command: 'x', attempt: 0, phase: 'starting' }),
    (error) => {
      assert.equal(error.message, 'resident launch journal write failed');
      assert.equal(error.cause.message, 'flush refused');
      return true;
    },
  );
}

// ── 3. A `delete` rejection in release propagates unchanged ────────────────
{
  const work = new FencedWork(
    { ...quietStorage, async delete() { throw new Error('delete refused'); } },
    host,
  );
  await work.journal({ pid: 7, command: 'x', attempt: 0, phase: 'starting' });
  await assert.rejects(
    work.release(7),
    (error) => {
      assert.equal(error.message, 'delete refused');
      return true;
    },
  );
}

// ── 4. Releasing a pid this instance never journalled touches no storage ────
{
  let deletes = 0;
  const work = new FencedWork(
    { ...quietStorage, async delete() { deletes += 1; return true; } },
    host,
  );
  await work.release(8);
  assert.equal(deletes, 0);
}

console.log('ok - fabric-journal-surfaces-errors (journal/release reject on storage failure)');
