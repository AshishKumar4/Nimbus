#!/usr/bin/env bun
/**
 * process-journals — the session's book of the residents whose write log may
 * still hold changes (packages/worker/src/session/process-journals.ts).
 *
 * A row is written when a resident's facet opens and deleted once a drain
 * empties its log. Rows a previous incarnation left (it was evicted, it
 * crashed with residents running) are drained at the next start, before any
 * process runs: every name is reserved from minting first, and a log that
 * cannot be read is said, named, and kept for the start after. Red before:
 * nothing recorded which facets held a log, and a session that restarted
 * minted their names again, which deletes what they stored.
 */

import assert from 'node:assert/strict';
import { ProcessJournals } from '../../packages/worker/src/session/process-journals.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const cred = (uid) => ({ uid, gid: uid, groups: [uid] });

// ── Booked at open, gone once drained; what is pending survives a restart ──
{
  const sql = createSqliteVfsTestHarness().sql;
  const book = new ProcessJournals(() => sql);
  book.opened('proc-slot-0', 101, cred(1000));
  book.opened('proc-slot-1', 102, cred(1001));
  book.opened('proc-slot-2', 103, cred(1000));
  book.settled(102);
  assert.equal(book.of(102), undefined);
  assert.deepEqual(book.of(103), { facet: 'proc-slot-2', pid: 103, cred: cred(1000) });
  // A new incarnation reads the same SQLite.
  const again = new ProcessJournals(() => sql);
  assert.deepEqual(again.pending().map((row) => row.pid), [101, 103]);
}

// ── At start: every name reserved first, each drained in order; a failure kept, named ──
{
  const sql = createSqliteVfsTestHarness().sql;
  new ProcessJournals(() => sql).opened('proc-slot-0', 201, cred(1000));
  new ProcessJournals(() => sql).opened('proc-slot-4', 202, cred(1000));
  new ProcessJournals(() => sql).opened('proc-slot-7', 203, cred(1002));
  const book = new ProcessJournals(() => sql);
  const reserved = new Set();
  const drained = [];
  const logged = [];
  const run = book.drainPending({
    reserved,
    drain: async (row) => {
      if (drained.length === 0) assert.deepEqual([...reserved].sort(), ['proc-slot-0', 'proc-slot-4', 'proc-slot-7'], 'a name was drained before every pending one was reserved');
      drained.push(row.pid);
      if (row.pid === 202) throw new Error('the facet did not answer');
      assert.deepEqual(row.cred, row.pid === 203 ? cred(1002) : cred(1000));
    },
    log: (message) => logged.push(message),
  });
  // Reserved before anything is awaited: no start can mint them meanwhile.
  assert.equal(reserved.size, 3);
  await run;
  assert.deepEqual(drained, [201, 202, 203]);
  assert.deepEqual([...reserved], ['proc-slot-4']);
  assert.deepEqual(book.pending().map((row) => row.pid), [202]);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /pid 202/);
  assert.match(logged[0], /'proc-slot-4'/);
  assert.match(logged[0], /the facet did not answer/);
  assert.match(logged[0], /kept/);
}

console.log('process-journals: ok');
