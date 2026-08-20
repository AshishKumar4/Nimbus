#!/usr/bin/env bun
// The append-only event journal, specified from Proteus's EventLog
// (core/src/events/hub/log.ts) and its schema (hub/schema.ts):
//
//   - publish returns { id, admitted } — a dedupe hit returns the EXISTING id
//     with admitted:false (log.ts:53-58), and the dedupe is STORAGE-level: a
//     unique partial index on dedupe_key, not just a read-then-insert.
//   - pending reads are priority-ordered: higher priority first, arrival order
//     within a priority (log.ts pending(), PRIORITY_ORDER).
//   - deliveries hold LEASES that expire. Proteus binds a delivery by writing
//     consumed_at and needs a cold-start sweep (unbindStale, 10 minutes) to
//     recover rows a dead activation left bound. An expiring lease is that
//     recovery with no sweep: expiry alone makes the row claimable again.
//   - a lease that expired and was re-claimed is FENCED: the old holder's
//     done/defer/dismiss returns false and must not clobber the new claimant.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { journal } from '../../packages/fabric/src/journal.ts';

function createCtx(db = new Database(':memory:')) {
  return {
    db,
    storage: {
      sql: {
        exec(query, ...params) {
          if (/^\s*(CREATE|INSERT|UPDATE|DELETE|REPLACE|DROP)/i.test(query)) {
            db.query(query).run(...params);
            return [];
          }
          return db.query(query).all(...params);
        },
      },
    },
  };
}

const T0 = 5_000_000;

// ── 1. Publish, and the dedupe contract ─────────────────────────────────────

{
  const ctx = createCtx();
  const log = journal(ctx, 'events');
  const first = log.publish({ kind: 'email', from: 'a' }, { dedupeKey: 'email:msg-1', now: T0 });
  assert.equal(first.admitted, true);
  const dup = log.publish({ kind: 'email', from: 'b' }, { dedupeKey: 'email:msg-1', now: T0 + 1 });
  assert.equal(dup.admitted, false, 'a duplicate dedupe key is refused');
  assert.equal(dup.id, first.id, 'the refusal names the existing event');

  // Storage-level idempotency, not just a polite read: the unique partial
  // index is the property the consumer's schema comment calls mandatory.
  const indexes = ctx.db.query(
    `SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'journal_events'`,
  ).all().map((row) => row.sql ?? '');
  assert.ok(
    indexes.some((sql) => /UNIQUE/i.test(sql) && /dedupe_key IS NOT NULL/i.test(sql)),
    'dedupe is enforced by a unique partial index in storage',
  );

  // Events without a dedupe key are always admitted.
  const a = log.publish({ kind: 'chat' }, { now: T0 + 2 });
  const b = log.publish({ kind: 'chat' }, { now: T0 + 3 });
  assert.equal(a.admitted, true);
  assert.equal(b.admitted, true);
  assert.notEqual(a.id, b.id);
}

// ── 2. Priority-ordered claims, arrival order within a priority ─────────────

{
  const ctx = createCtx();
  const log = journal(ctx, 'events');
  log.publish({ n: 'background' }, { priority: 0, now: T0 });
  log.publish({ n: 'urgent' }, { priority: 2, now: T0 + 1 });
  log.publish({ n: 'normal-1' }, { priority: 1, now: T0 + 2 });
  log.publish({ n: 'normal-2' }, { priority: 1, now: T0 + 3 });

  const claims = log.claim({ leaseMs: 60_000, now: T0 + 10 });
  assert.deepEqual(claims.map((c) => c.payload.n), ['urgent', 'normal-1', 'normal-2', 'background']);
  for (const c of claims) c.lease.done();

  log.publish({ n: 'low' }, { priority: 0, now: T0 + 20 });
  log.publish({ n: 'high' }, { priority: 2, now: T0 + 21 });
  const urgentOnly = log.claim({ leaseMs: 60_000, minPriority: 1, now: T0 + 22 });
  assert.deepEqual(urgentOnly.map((c) => c.payload.n), ['high'], 'minPriority filters the read');

  const limited = log.claim({ leaseMs: 60_000, limit: 1, now: T0 + 23 });
  assert.equal(limited.length, 1);
}

// ── 3. An open lease hides the row; an expired lease is the recovery ────────

{
  const ctx = createCtx();
  const log = journal(ctx, 'events');
  const { id } = log.publish({ n: 1 }, { now: T0 });

  const [first] = log.claim({ leaseMs: 10_000, now: T0 + 1 });
  assert.equal(first.id, id);
  assert.equal(log.claim({ leaseMs: 10_000, now: T0 + 2 }).length, 0,
    'a leased row is invisible to the next claim');

  // The activation died. No sweep runs — expiry alone re-pends the row.
  const recovered = log.claim({ leaseMs: 10_000, now: T0 + 1 + 10_000 });
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].id, id, 'lease expiry alone recovers the delivery');

  // The dead holder's lease is fenced off the re-claimed row.
  assert.equal(first.lease.done(), false, 'a lost lease cannot complete the event');
  assert.equal(log.claim({ leaseMs: 10_000, now: T0 + 1 + 10_001 }).length, 0,
    'the failed done() did not clobber the new claimant');
  assert.equal(recovered[0].lease.done(), true, 'the live lease completes normally');

  assert.equal(log.claim({ leaseMs: 10_000, now: T0 + 100_000 }).length, 0,
    'a done event is never delivered again');
}

// ── 4. defer releases the lease and hides the row until its revisit time ────

{
  const ctx = createCtx();
  const log = journal(ctx, 'events');
  log.publish({ n: 1 }, { now: T0 });
  const [claim] = log.claim({ leaseMs: 60_000, now: T0 + 1 });
  assert.equal(claim.lease.defer(T0 + 5_000), true);
  assert.equal(log.claim({ leaseMs: 60_000, now: T0 + 2 }).length, 0, 'deferred is hidden');
  assert.equal(log.claim({ leaseMs: 60_000, now: T0 + 4_999 }).length, 0, 'still hidden before the revisit time');
  const revisit = log.claim({ leaseMs: 60_000, now: T0 + 5_000 });
  assert.equal(revisit.length, 1, 'a deferred event comes back at its revisit time');
  assert.equal(revisit[0].payload.n, 1);
}

// ── 5. dismiss is terminal ───────────────────────────────────────────────────

{
  const ctx = createCtx();
  const log = journal(ctx, 'events');
  log.publish({ n: 1 }, { now: T0 });
  const [claim] = log.claim({ leaseMs: 60_000, now: T0 + 1 });
  assert.equal(claim.lease.dismiss('superseded by a newer event'), true);
  assert.equal(log.claim({ leaseMs: 60_000, now: T0 + 100_000 }).length, 0, 'dismissed never returns');
}

// ── 6. The journal an instance left behind is the next instance's to claim ──

{
  const db = new Database(':memory:');
  const first = journal(createCtx(db), 'events');
  first.publish({ n: 'owed' }, { now: T0 });
  first.claim({ leaseMs: 30_000, now: T0 + 1 });

  // The instance reset. The replacement reads the same rows; the stranded
  // lease expires on its own — this is what replaces the unbindStale sweep.
  const second = journal(createCtx(db), 'events');
  assert.equal(second.claim({ leaseMs: 30_000, now: T0 + 2 }).length, 0,
    'a replacement instance still honours an unexpired lease');
  const recovered = second.claim({ leaseMs: 30_000, now: T0 + 1 + 30_000 });
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].payload.n, 'owed');
}

console.log('ok - fabric-journal (dedupe, priority claims, expiring leases, fencing, defer, dismiss, recovery)');
