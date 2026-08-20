#!/usr/bin/env bun
// The durable retry outbox, specified from the two Proteus consumers that each
// built it by hand (cf-backend/src/email/outbox.ts and
// core/src/events/ingress/peer.ts):
//
//   - WRITE-AHEAD: the intent row is committed 'pending' before send runs.
//   - IDEMPOTENCY: a dedupe key already queued or sent is never re-queued and
//     never re-sent (email outbox: an existing 'sent' row short-circuits).
//   - DISPOSITION, not boolean: a resolved refusal is PERMANENT (dlq now), a
//     thrown send is TRANSIENT (backoff), a malformed row is POISON (dlq now).
//     peer.ts:476-526 is the source of that three-way split.
//   - BACKOFF: next = now + baseMs * 2**(attempts-1); dlq at maxAttempts.
//   - ORDERING: rows drain in id order; a transient failure blocks LATER rows
//     with the same order key (peer.ts head-of-line set), while a dlq'd row
//     does not block its key, and keyless rows never block each other (email).
//   - The drain registers with `timers` instead of owning an alarm, and it is
//     turn-bounded through a TurnBudget — both fabric additions the consumers
//     lacked (their drains are unbounded; the brief demands bounded).

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { outbox } from '../../packages/fabric/src/outbox.ts';
import { TIMER_REASONS_KEY } from '../../packages/fabric/src/timers.ts';
import { TurnBudget } from '../../packages/fabric/src/turn-budget.ts';

// ── Fixture: a DO ctx with synchronous SQL plus the timer KV surface ────────

function createCtx(db = new Database(':memory:')) {
  const kv = new Map();
  const alarms = [];
  return {
    db,
    kv,
    alarms,
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
      async get(key) { return kv.get(key); },
      async put(key, value) { kv.set(key, value); },
      async delete(key) { return kv.delete(key); },
      setAlarm(at) { alarms.push(at); },
    },
  };
}

const T0 = 1_000_000;

// ── 1. Write-ahead, delivery, and idempotency ───────────────────────────────

{
  const ctx = createCtx();
  const sent = [];
  const box = outbox({}, ctx, 'mail', {
    maxAttempts: 8,
    baseMs: 30_000,
    async send(message) { sent.push(message); return { status: 'sent' }; },
  });

  const first = await box.queue({ to: 'a', body: 'hello' }, { dedupeKey: 'k1', now: T0 });
  assert.equal(first.admitted, true);
  assert.equal(sent.length, 0, 'queue is write-ahead only; nothing sends until drain');
  assert.equal(box.nextRetryAt(), T0, 'a queued row is due immediately');

  const dup = await box.queue({ to: 'a', body: 'hello again' }, { dedupeKey: 'k1', now: T0 + 1 });
  assert.equal(dup.admitted, false, 'a dedupe key already queued is refused');
  assert.equal(dup.id, first.id, 'the refusal names the existing row');

  const result = await box.drain(T0);
  assert.equal(result.sent, 1);
  assert.deepEqual(sent, [{ to: 'a', body: 'hello' }]);
  assert.equal(box.nextRetryAt(), null, 'nothing pending after delivery');

  // The email outbox's short-circuit: a key already 'sent' is never re-sent.
  const again = await box.queue({ to: 'a', body: 'third' }, { dedupeKey: 'k1', now: T0 + 2 });
  assert.equal(again.admitted, false);
  await box.drain(T0 + 2);
  assert.equal(sent.length, 1, 'a sent dedupe key never reaches send again');
}

// ── 2. Transient failure: backoff, due-time gating, dead-letter ─────────────

{
  const ctx = createCtx();
  let attempts = 0;
  const box = outbox({}, ctx, 'peer', {
    maxAttempts: 3,
    baseMs: 5_000,
    async send() { attempts++; throw new Error('network connection lost'); },
  });

  await box.queue({ n: 1 }, { now: T0 });
  await box.drain(T0);
  assert.equal(attempts, 1);
  assert.equal(box.nextRetryAt(), T0 + 5_000, 'first failure backs off baseMs * 2**0');

  await box.drain(T0 + 1_000);
  assert.equal(attempts, 1, 'a row before its next_attempt_at is not retried');

  await box.drain(T0 + 5_000);
  assert.equal(attempts, 2);
  assert.equal(box.nextRetryAt(), T0 + 5_000 + 10_000, 'second failure backs off baseMs * 2**1');

  const last = await box.drain(T0 + 15_000);
  assert.equal(attempts, 3);
  assert.equal(last.deadLettered, 1, 'maxAttempts exhausts into the dlq');
  assert.equal(box.nextRetryAt(), null);
  const dlq = box.dlq();
  assert.equal(dlq.length, 1);
  assert.equal(dlq[0].attemptCount, 3);
  assert.match(dlq[0].lastError, /network connection lost/);

  await box.drain(T0 + 60_000);
  assert.equal(attempts, 3, 'the dlq is terminal; nothing retries out of it');
}

// ── 3. A resolved 'retry' disposition is transient too ──────────────────────

{
  const ctx = createCtx();
  let calls = 0;
  const box = outbox({}, ctx, 'peer', {
    maxAttempts: 8,
    baseMs: 5_000,
    async send() { calls++; return { status: 'retry', reason: 'receiver mid-deploy' }; },
  });
  await box.queue({ n: 1 }, { now: T0 });
  const result = await box.drain(T0);
  assert.equal(result.retried, 1);
  assert.equal(box.nextRetryAt(), T0 + 5_000);
  await box.drain(T0 + 5_000);
  assert.equal(calls, 2);
}

// ── 4. Poison dead-letters immediately and never retries ────────────────────

{
  const ctx = createCtx();
  let calls = 0;
  const box = outbox({}, ctx, 'peer', {
    maxAttempts: 8,
    baseMs: 5_000,
    async send() { calls++; return { status: 'poison', reason: 'no grant from receiver' }; },
  });
  await box.queue({ n: 1 }, { now: T0 });
  const result = await box.drain(T0);
  assert.equal(result.deadLettered, 1);
  assert.equal(calls, 1);
  assert.equal(box.dlq()[0].lastError, 'no grant from receiver');
  await box.drain(T0 + 100_000);
  assert.equal(calls, 1, 'poison is dead-lettered on its first and only attempt');
}

// ── 5. Per-key ordering: transient blocks the key, dlq does not ─────────────

{
  const ctx = createCtx();
  const delivered = [];
  let failFirst = true;
  const box = outbox({}, ctx, 'peer', {
    maxAttempts: 8,
    baseMs: 5_000,
    orderBy: (message) => message.receiver,
    async send(message) {
      if (message.poison) return { status: 'poison', reason: 'refused' };
      if (message.fail && failFirst) { failFirst = false; throw new Error('transient'); }
      delivered.push(message.n);
      return { status: 'sent' };
    },
  });

  await box.queue({ receiver: 'r1', n: 1, fail: true }, { now: T0 });
  await box.queue({ receiver: 'r1', n: 2 }, { now: T0 + 1 });
  await box.queue({ receiver: 'r2', n: 3 }, { now: T0 + 2 });
  await box.drain(T0 + 3);
  assert.deepEqual(delivered, [3], 'a transient failure blocks its key; other keys proceed');

  await box.drain(T0 + 5_010);
  assert.deepEqual(delivered, [3, 1, 2], 'the retried head unblocks its key in id order');

  // A dead-lettered head must not block the queue behind it (peer.ts:476-482).
  await box.queue({ receiver: 'r3', n: 4, poison: true }, { now: T0 + 6_000 });
  await box.queue({ receiver: 'r3', n: 5 }, { now: T0 + 6_001 });
  await box.drain(T0 + 6_002);
  assert.deepEqual(delivered, [3, 1, 2, 5], 'a dlq row does not block its key');

  // A not-yet-due head also blocks its key (peer.ts:469-473).
  failFirst = true;
  await box.queue({ receiver: 'r4', n: 6, fail: true }, { now: T0 + 7_000 });
  await box.queue({ receiver: 'r4', n: 7 }, { now: T0 + 7_001 });
  await box.drain(T0 + 7_002);
  await box.drain(T0 + 7_003);
  assert.ok(!delivered.includes(7), 'a backed-off head still blocks rows queued behind it');
}

// ── 6. A row that fails to parse is poison, not a crash ─────────────────────

{
  const ctx = createCtx();
  let calls = 0;
  const box = outbox({}, ctx, 'peer', {
    maxAttempts: 8,
    baseMs: 5_000,
    async send() { calls++; return { status: 'sent' }; },
  });
  await box.queue({ n: 1 }, { now: T0 });
  // Corrupt the stored payload the way a schema drift would.
  ctx.db.query(`UPDATE outbox_peer SET message = '{not json'`).run();
  const result = await box.drain(T0);
  assert.equal(result.deadLettered, 1);
  assert.equal(calls, 0, 'an unparseable row never reaches send');
}

// ── 7. The outbox registers with timers instead of owning an alarm ──────────

{
  const ctx = createCtx();
  const host = {};
  const box = outbox(host, ctx, 'mail', {
    maxAttempts: 8,
    baseMs: 30_000,
    async send() { throw new Error('down'); },
  });
  assert.equal(box.reason, 'outbox:mail');

  await box.queue({ n: 1 }, { now: T0 });
  assert.equal(ctx.kv.get(TIMER_REASONS_KEY)['outbox:mail'], T0,
    'queue arms the shared reason map, not its own alarm');
  assert.ok(ctx.alarms.length > 0, 'the shared map re-arms the platform alarm');

  // The dispatch-side handler drains and re-arms through its return value —
  // never by calling schedule() from inside the dispatcher's chain.
  const rearm = await box.handler()(T0);
  assert.deepEqual(rearm, { rearmAt: T0 + 30_000 }, 'the handler re-arms at nextRetryAt');
}

// ── 8. The drain is turn-bounded through a TurnBudget ───────────────────────

{
  const ctx = createCtx();
  let turns = 0;
  const scheduler = {
    async nextTurn(chunkEnded) { turns++; void chunkEnded; },
  };
  const box = outbox({}, ctx, 'bulk', {
    maxAttempts: 8,
    baseMs: 5_000,
    async send() { return { status: 'sent' }; },
  });
  const payload = 'x'.repeat(2_000);
  for (let i = 0; i < 10; i++) await box.queue({ i, payload }, { now: T0 + i });
  const budget = new TurnBudget(scheduler, 4_000);
  const result = await box.drain(T0 + 100, { budget });
  budget.settle();
  assert.equal(result.sent, 10, 'a paced drain still delivers everything');
  assert.ok(turns >= 4, `a 20KB backlog against a 4KB chunk crosses turns (saw ${turns})`);
}

// ── 9. A replacement instance retries pending and never re-sends sent ───────

{
  const db = new Database(':memory:');
  const sent = [];
  const make = (ctx) => outbox({}, ctx, 'peer', {
    maxAttempts: 8,
    baseMs: 5_000,
    async send(message) {
      if (message.fail) throw new Error('transient');
      sent.push(message.n);
      return { status: 'sent' };
    },
  });

  const first = make(createCtx(db));
  await first.queue({ n: 1 }, { now: T0 });
  await first.queue({ n: 2, fail: true }, { now: T0 + 1 });
  await first.drain(T0 + 2);
  assert.deepEqual(sent, [1]);

  // The instance is gone; a fresh one over the same storage owes the retry.
  const second = make(createCtx(db));
  assert.equal(second.nextRetryAt(), T0 + 2 + 5_000);
  await second.drain(T0 + 2 + 5_000);
  assert.equal(sent.filter((n) => n === 1).length, 1, 'sent rows stay sent across instances');

  // Ids stay monotonic across the replacement, so ordering holds.
  const maxBefore = db.query(`SELECT MAX(id) AS m FROM outbox_peer`).all()[0].m;
  const reAdmitted = await second.queue({ n: 3 }, { now: T0 });
  assert.ok(reAdmitted.id > maxBefore,
    'a replacement instance with a lagging clock never mints an id below an existing one');
}

// ── 10. A reentrant drain is a no-op ────────────────────────────────────────

{
  const ctx = createCtx();
  let inFlight = 0;
  let overlapped = false;
  const box = outbox({}, ctx, 'peer', {
    maxAttempts: 8,
    baseMs: 5_000,
    async send() {
      inFlight++;
      if (inFlight > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return { status: 'sent' };
    },
  });
  await box.queue({ n: 1 }, { now: T0 });
  await box.queue({ n: 2 }, { now: T0 + 1 });
  const [a, b] = await Promise.all([box.drain(T0 + 2), box.drain(T0 + 2)]);
  assert.equal(overlapped, false, 'the alarm and an inline drain must not interleave sends');
  assert.equal(a.sent + b.sent, 2);
}

// ── 11. drain({ context }) reaches send — the per-call transport binding ────
// Proteus's ported EmailOutbox resolves its send_email binding per call and
// had to smuggle it through an instance field (`this.binding`), nulled in a
// finally. The policy closure is fixed at construction; the binding is not.

{
  const ctx = createCtx();
  const seen = [];
  const box = outbox({}, ctx, 'mail', {
    maxAttempts: 8,
    baseMs: 30_000,
    async send(message, info, context) {
      seen.push({ n: message.n, attempt: info.attempt, transport: context.transport });
      return { status: 'sent' };
    },
  });
  await box.queue({ n: 1 }, { now: T0 });
  await box.drain(T0, { context: { transport: 'binding-A' } });
  await box.queue({ n: 2 }, { now: T0 + 1 });
  await box.drain(T0 + 1, { context: { transport: 'binding-B' } });
  assert.deepEqual(seen, [
    { n: 1, attempt: 1, transport: 'binding-A' },
    { n: 2, attempt: 1, transport: 'binding-B' },
  ], 'each drain hands its own context to send');
}

// ── 12. status(id) / find(dedupeKey): the per-key read model ─────────────────
// Both ported consumers reached into fabric's table with raw SQL to answer
// "what happened to this message" — the email outbox to report sent/deduped/
// failed per key, the peer transport to correlate a reply with the stored
// ask. The record returns the stored message, not just the state.

{
  const ctx = createCtx();
  let fail = true;
  const box = outbox({}, ctx, 'mail', {
    maxAttempts: 8,
    baseMs: 30_000,
    async send(message) {
      if (message.fail && fail) throw new Error('provider 5xx');
      return { status: 'sent' };
    },
  });

  assert.equal(box.find('nothing'), null);
  assert.equal(box.status('nothing'), null);

  const ok = await box.queue({ n: 1 }, { now: T0 });
  const flaky = await box.queue({ n: 2, fail: true }, { dedupeKey: 'alert-1', now: T0 + 1 });
  await box.drain(T0 + 1);

  assert.deepEqual(box.status(ok.id), {
    id: ok.id, state: 'sent', message: { n: 1 }, dedupeKey: null, attemptCount: 1, lastError: null,
  });
  const pending = box.find('alert-1');
  assert.deepEqual(pending, {
    id: flaky.id, state: 'pending', message: { n: 2, fail: true },
    dedupeKey: 'alert-1', attemptCount: 1, lastError: 'provider 5xx',
  });
  assert.deepEqual(box.status(flaky.id), pending, 'both reads name the same row');

  fail = false;
  await box.drain(T0 + 30_001);
  assert.equal(box.find('alert-1').state, 'sent');
  assert.equal(box.find('alert-1').lastError, null, 'delivery clears the error');
}

// ── 13. The scheduler seam: the consumer owns the alarm ──────────────────────
// Proteus's DO alarm belongs to the Agents SDK and agent-core's to its own
// reconciler; neither can give fabric the alarm slot. The ported EmailOutbox
// faked a timer storage whose get/put/delete throw and re-armed by hand after
// every drain. With the seam, fabric hands every next due time to the
// consumer's schedule and touches no timer storage at all.

{
  const db = new Database(':memory:');
  const sqlOnlyCtx = {
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
  const armed = [];
  let fail = true;
  const box = outbox(sqlOnlyCtx, 'email', {
    maxAttempts: 8,
    baseMs: 30_000,
    async schedule(at) { armed.push(at); },
    async send() {
      if (fail) throw new Error('provider down');
      return { status: 'sent' };
    },
  });

  await box.queue({ n: 1 }, { now: T0 });
  assert.deepEqual(armed, [T0], 'queue hands the due time to the consumer, not to timer storage');

  await box.drain(T0);
  assert.deepEqual(armed, [T0, T0 + 30_000], 'a drain that leaves rows pending re-arms itself');

  fail = false;
  await box.drain(T0 + 30_000);
  assert.deepEqual(armed, [T0, T0 + 30_000], 'a drained-empty outbox arms nothing');

  assert.throws(() => box.handler(), /scheduler seam/,
    'there is no timer dispatcher to hand a handler to');
}

// ── 14. onDuplicate: 'retry-now' — the caller-driven re-ask ─────────────────
// The monitor's alert-once contract: a re-ask for an unsent key is new
// intent. It must deliver now (not at the backed-off instant) and resurrect
// a dead letter, so a failed alert is retried by every sweep until it lands,
// past any attempt budget. The port restored this with a raw UPDATE on
// fabric's table; a monitor test caught the lost behavior.

{
  const ctx = createCtx();
  let fail = true;
  let attempts = 0;
  const box = outbox({}, ctx, 'mail', {
    maxAttempts: 2,
    baseMs: 30_000,
    async send() {
      attempts++;
      if (fail) throw new Error('provider down');
      return { status: 'sent' };
    },
  });

  // Backed-off pending key: the re-ask clamps it due NOW.
  await box.queue({ n: 1 }, { dedupeKey: 'alert', now: T0 });
  await box.drain(T0);
  assert.equal(box.nextRetryAt(), T0 + 30_000);
  const reAsk = await box.queue({ n: 1 }, { dedupeKey: 'alert', now: T0 + 5, onDuplicate: 'retry-now' });
  assert.equal(reAsk.admitted, false, 'the row is the existing one, not a duplicate');
  assert.equal(box.nextRetryAt(), T0 + 5, 'the re-ask clamps the retry instant to now');
  // The reason map may hold an EARLIER already-due deadline (EDF fold keeps
  // the sooner of the two); what matters is that delivery stays owed by now.
  assert.ok(ctx.kv.get(TIMER_REASONS_KEY)['outbox:mail'] <= T0 + 5, 'delivery stays armed');
  await box.drain(T0 + 5);
  assert.equal(attempts, 2);

  // Dead-lettered key: the re-ask resurrects it past the attempt budget.
  assert.equal(box.find('alert').state, 'dlq');
  await box.queue({ n: 1 }, { dedupeKey: 'alert', now: T0 + 10, onDuplicate: 'retry-now' });
  assert.equal(box.find('alert').state, 'pending', 'a re-asked dead letter is pending again');
  fail = false;
  await box.drain(T0 + 10);
  assert.equal(box.find('alert').state, 'sent', 'the resurrected row delivers');
  assert.equal(attempts, 3);

  // Sent key: final. A re-ask never re-sends.
  await box.queue({ n: 1 }, { dedupeKey: 'alert', now: T0 + 20, onDuplicate: 'retry-now' });
  await box.drain(T0 + 20);
  assert.equal(attempts, 3, 'a sent dedupe key never reaches send again, re-ask or not');
}

console.log('ok - fabric-outbox (write-ahead, dedupe, disposition, backoff, ordering, timers, pacing, recovery)');
