#!/usr/bin/env bun
// The two cross-DO call verbs. The rule that had to become a type instead of
// a comment (Proteus do-rpc.ts:12-17): "An operation that appends, sends,
// charges or mints is never wrapped: a dropped call there may already have
// run, so a retry is a correctness bug wearing resilience as a costume."
// `idempotent` retries the transient classes on a FRESH stub per attempt —
// Cloudflare documents that many exceptions leave a stub permanently broken —
// and `mutating` never retries anything: it classifies and surfaces a typed
// cause. Overloaded is never retried by either verb.

import assert from 'node:assert/strict';
import { DoCallError, idempotent, mutating } from '../../packages/fabric/src/do-calls.ts';

/** A stub mint that records every stub it made and each stub's disposal. */
function mintKit(behavior) {
  const stubs = [];
  return {
    stubs,
    resolve: () => {
      const stub = {
        disposed: false,
        [Symbol.dispose]() { this.disposed = true; },
        async ping(x) { return behavior(stubs.length, x); },
      };
      stubs.push(stub);
      return stub;
    },
  };
}

const FAST = { baseDelayMs: 1 };

// ── 1. Success: one stub, minted fresh, disposed after use ──────────────────

{
  const kit = mintKit(async (_n, x) => x * 2);
  const result = await idempotent('double', kit.resolve, (s) => s.ping(21), FAST);
  assert.equal(result, 42);
  assert.equal(kit.stubs.length, 1, 'success needs exactly one stub');
  assert.equal(kit.stubs[0].disposed, true, 'the verb disposes the stub it minted');
}

// ── 2. Transient failure: retried on a FRESH stub, broken one disposed ──────

{
  const kit = mintKit(async (n, x) => {
    if (n === 1) throw new Error('Network connection lost.');
    return x;
  });
  const result = await idempotent('read', kit.resolve, (s) => s.ping('v'), FAST);
  assert.equal(result, 'v');
  assert.equal(kit.stubs.length, 2, 'a broken stub stays broken; the retry minted a fresh one');
  assert.equal(kit.stubs[0].disposed, true, 'the broken stub was released');
  assert.equal(kit.stubs[1].disposed, true);
}

// ── 3. The runtime's own retryable flag is honoured ──────────────────────────

{
  const kit = mintKit(async (n) => {
    if (n === 1) {
      const e = new Error('transient by flag');
      e.retryable = true;
      throw e;
    }
    return 'ok';
  });
  assert.equal(await idempotent('flagged', kit.resolve, (s) => s.ping(), FAST), 'ok');
  assert.equal(kit.stubs.length, 2);
}

// ── 4. Overloaded is never retried, by either verb ──────────────────────────

{
  const kit = mintKit(async () => { throw new Error('Durable Object is overloaded.'); });
  await assert.rejects(
    idempotent('hot', kit.resolve, (s) => s.ping(), FAST),
    /overloaded/,
  );
  assert.equal(kit.stubs.length, 1, 'an overloaded refusal is never retried');
}

// ── 5. Permanent errors surface unchanged, once ─────────────────────────────

{
  const boom = new Error('no such row');
  const kit = mintKit(async () => { throw boom; });
  await assert.rejects(
    idempotent('read', kit.resolve, (s) => s.ping(), FAST),
    (e) => e === boom,
  );
  assert.equal(kit.stubs.length, 1, 'a permanent error earns no retry');
  assert.equal(kit.stubs[0].disposed, true);
}

// ── 6. Exhaustion: three attempts total, then the last error, unchanged ─────

{
  let thrown;
  const kit = mintKit(async () => {
    thrown = new Error('Network connection lost.');
    throw thrown;
  });
  await assert.rejects(
    idempotent('read', kit.resolve, (s) => s.ping(), FAST),
    (e) => e === thrown,
  );
  assert.equal(kit.stubs.length, 3, 'MAX_ATTEMPTS is 3, the consumer-proven bound');
}

// ── 7. mutating never retries a transient — the rule as a type ──────────────

{
  const inner = new Error('Network connection lost.');
  const kit = mintKit(async () => { throw inner; });
  await assert.rejects(
    mutating('chargeAccount', kit.resolve, (s) => s.ping()),
    (e) => {
      assert.ok(e instanceof DoCallError, 'mutating surfaces a typed cause');
      assert.equal(e.operation, 'chargeAccount');
      assert.equal(e.verb, 'mutating');
      assert.equal(e.classification, 'connection_lost');
      assert.equal(e.cause, inner);
      assert.match(e.message, /Network connection lost/);
      assert.match(e.message, /may already have run/, 'the indeterminacy is named, not implied');
      return true;
    },
  );
  assert.equal(kit.stubs.length, 1, 'mutating NEVER retries; a dropped call may already have run');
  assert.equal(kit.stubs[0].disposed, true);
}

// ── 8. mutating on a permanent error still types the cause ──────────────────

{
  const inner = new Error('insufficient funds');
  const kit = mintKit(async () => { throw inner; });
  await assert.rejects(
    mutating('chargeAccount', kit.resolve, (s) => s.ping()),
    (e) => e instanceof DoCallError && e.classification === 'permanent' && e.cause === inner
      && !/may already have run/.test(e.message),
  );
}

// ── 9. mutating success passes the value through and disposes the stub ──────

{
  const kit = mintKit(async () => 'minted');
  assert.equal(await mutating('mint', kit.resolve, (s) => s.ping()), 'minted');
  assert.equal(kit.stubs[0].disposed, true);
}

// ── 10. A retry is observable through onRetry — never silently absorbed ─────
// Proteus's consumer proof: its hand-rolled seam logged every retry so a
// flaky object shows in Workers Logs, and `operation` exists to name it.
// Without the hook the parameter is dead weight on the retrying verb.

{
  const seen = [];
  const kit = mintKit(async (n) => {
    if (n === 1) throw new Error('Network connection lost.');
    return 'ok';
  });
  const policy = {
    baseDelayMs: 1,
    onRetry: (info) => seen.push(info),
  };
  assert.equal(await idempotent('flakyRead', kit.resolve, (s) => s.ping(), policy), 'ok');
  assert.equal(seen.length, 1, 'one retry, one report');
  assert.equal(seen[0].operation, 'flakyRead');
  assert.equal(seen[0].classification, 'connection_lost');
  assert.equal(seen[0].attempt, 1);
  assert.equal(seen[0].maxAttempts, 3);
  assert.match(seen[0].error.message, /Network connection lost/);
}

// ── 11. onRetry stays silent on success and on permanent failure ────────────

{
  const seen = [];
  const policy = { baseDelayMs: 1, onRetry: (info) => seen.push(info) };
  const clean = mintKit(async () => 'ok');
  assert.equal(await idempotent('clean', clean.resolve, (s) => s.ping(), policy), 'ok');
  const broken = mintKit(async () => { throw new Error('no such row'); });
  await assert.rejects(idempotent('perm', broken.resolve, (s) => s.ping(), policy));
  assert.equal(seen.length, 0, 'no retry happened, so nothing to report');
}

// ── 12. Exhaustion reports every retry it performed ─────────────────────────

{
  const seen = [];
  const kit = mintKit(async () => { throw new Error('Network connection lost.'); });
  await assert.rejects(
    idempotent('gone', kit.resolve, (s) => s.ping(), { baseDelayMs: 1, onRetry: (i) => seen.push(i) }),
  );
  assert.deepEqual(seen.map((i) => i.attempt), [1, 2], 'two retries before the third attempt threw');
}

// ── 13. An async resolver composes (a placement pin resolves remotely) ──────

{
  const kit = mintKit(async () => 'pinned');
  const resolveAsync = async () => kit.resolve();
  assert.equal(await idempotent('pinnedRead', resolveAsync, (s) => s.ping(), FAST), 'pinned');
}

// ── 14. A retry window closes retries by elapsed time, not attempt count ─────
// A caller whose callee dedupes repeats only for a bounded retention must
// stop repeating inside it, however long an attempt took to fail.

{
  const realNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  try {
    const drop = () => Object.assign(new Error('Network connection lost.'), { retryable: true });
    const late = mintKit(async () => { now += 20_001; throw drop(); });
    const seen = [];
    await assert.rejects(
      idempotent('late', late.resolve, (s) => s.ping(), { baseDelayMs: 1, retryWindowMs: 20_000, onRetry: (i) => seen.push(i) }),
      /Network connection lost/,
    );
    assert.equal(late.stubs.length, 1, 'a failure that ended past the window was retried');
    assert.deepEqual(seen, [], 'a retry past the window was announced');

    const early = mintKit(async (n) => {
      now += 19_000;
      if (n === 1) throw drop();
      return 'second';
    });
    assert.equal(
      await idempotent('early', early.resolve, (s) => s.ping(), { baseDelayMs: 1, retryWindowMs: 20_000 }),
      'second',
    );
    assert.equal(early.stubs.length, 2, 'a failure inside the window was not retried');
  } finally {
    Date.now = realNow;
  }
}

// ── 15. Hedging: an attempt that has not answered is joined, not abandoned ───
// A call can also never answer: the platform left some reads to the session
// pending for minutes without delivering them. With `hedgeAfterMs`, an
// attempt still unanswered then is joined by the same call on a fresh stub,
// and the first answer is taken.

{
  const never = new Promise(() => {});
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const HEDGE = { baseDelayMs: 1, hedgeAfterMs: 20 };

  // An attempt that never answers: the hedge does.
  const hung = mintKit(async (n) => (n === 1 ? never : 'from-hedge'));
  assert.equal(await idempotent('stuck read', hung.resolve, (s) => s.ping(), HEDGE), 'from-hedge');
  assert.equal(hung.stubs.length, 2, 'the stuck attempt was not hedged on a fresh stub');
  assert.equal(hung.stubs[1].disposed, true);

  // The first attempt answers after the hedge did: one result, the hedge's,
  // and the late answer is disposed rather than kept or delivered.
  const answers = [];
  const answer = (from) => {
    const value = { from, disposed: false, [Symbol.dispose]() { this.disposed = true; } };
    answers.push(value);
    return value;
  };
  const late = mintKit(async (n) => {
    if (n === 1) await sleep(60);
    return answer(n);
  });
  const taken = await idempotent('late read', late.resolve, (s) => s.ping(), HEDGE);
  assert.equal(taken.from, 2, 'the answer taken was not the first to arrive');
  await sleep(80);
  assert.equal(answers.length, 2, 'both attempts ran');
  const lateAnswer = answers.find((value) => value.from === 1);
  assert.equal(lateAnswer.disposed, true, 'the late answer was kept');
  assert.equal(taken.disposed, false, 'the answer taken was disposed under its caller');
  assert.deepEqual(late.stubs.map((stub) => stub.disposed), [true, true], 'a stub was left undisposed');

  // Without the policy nothing is hedged, however long an attempt takes.
  const slow = mintKit(async () => { await sleep(60); return 'slow'; });
  assert.equal(await idempotent('unhedged', slow.resolve, (s) => s.ping(), FAST), 'slow');
  assert.equal(slow.stubs.length, 1, 'a call with no hedge policy was hedged');

  // Hedges are attempts: no more than maxAttempts are ever in flight.
  const stuck = mintKit(async () => never);
  const pending = idempotent('all stuck', stuck.resolve, (s) => s.ping(), HEDGE);
  let pendingSettled = false;
  pending.then(() => { pendingSettled = true; }, () => { pendingSettled = true; });
  await sleep(150);
  assert.equal(stuck.stubs.length, 3, `${stuck.stubs.length} attempts, not the 3 the cap allows`);
  assert.equal(pendingSettled, false, 'a call none of whose attempts answered settled');

  // A hedge dropped retryably while the first still hangs is retried.
  const dropped = mintKit(async (n) => {
    if (n === 1) return never;
    if (n === 2) throw Object.assign(new Error('Network connection lost.'), { retryable: true });
    return 'third';
  });
  assert.equal(await idempotent('hedge dropped', dropped.resolve, (s) => s.ping(), HEDGE), 'third');
  assert.equal(dropped.stubs.length, 3);

  // Attempts spent and all but one dropped: the one still in flight answers.
  const lastStanding = mintKit(async (n) => {
    if (n === 1) { await sleep(80); return 'first'; }
    throw Object.assign(new Error('Network connection lost.'), { retryable: true });
  });
  assert.equal(await idempotent('last standing', lastStanding.resolve, (s) => s.ping(), HEDGE), 'first');
  assert.equal(lastStanding.stubs.length, 3);

  // A hedge refused as overloaded does not preempt the attempt still in
  // flight: that one's success is the answer, and nothing is repeated after
  // the refusal.
  const overloaded = () => Object.assign(new Error('Durable Object is overloaded.'), { retryable: true, overloaded: true });
  const refused = mintKit(async (n) => {
    if (n === 1) { await sleep(60); return 'first'; }
    throw overloaded();
  });
  assert.equal(await idempotent('hedge refused', refused.resolve, (s) => s.ping(), HEDGE), 'first',
    'an overloaded hedge failed the call while an earlier attempt was still in flight');
  assert.equal(refused.stubs.length, 2, 'an overloaded answer was repeated');

  // When the attempt still in flight fails too, the last failure is the answer.
  const bothFail = mintKit(async (n) => {
    if (n === 1) { await sleep(60); throw new Error('no such row'); }
    throw overloaded();
  });
  await assert.rejects(idempotent('both fail', bothFail.resolve, (s) => s.ping(), HEDGE), /no such row/);
  assert.equal(bothFail.stubs.length, 2);

  // No hedge starts once the retry window has closed.
  const windowed = mintKit(async (n) => (n === 1 ? sleep(60).then(() => 'first') : 'hedge'));
  assert.equal(await idempotent('windowed', windowed.resolve, (s) => s.ping(), { ...HEDGE, retryWindowMs: 10 }), 'first');
  assert.equal(windowed.stubs.length, 1, 'a hedge started past the retry window');
}

// ── 16. onRetry: its own attempt's number, only when the retry starts, and a
// throw fails the call instead of hanging it ─────────────────────────────────

{
  const never = new Promise(() => {});
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const drop = () => Object.assign(new Error('Network connection lost.'), { retryable: true });
  const realRandom = Math.random;
  // Backoff is floor(random * 2**attempt * base): a fixed draw fixes the timeline.
  Math.random = () => 0.5;
  try {
    // Attempt 1 fails at 30 ms, after its hedge started attempt 2 at 20 ms;
    // attempt 2 fails at 35 ms. Attempt 1's retry (after 100 ms) is announced
    // as attempt 1's, though two attempts had started, and answers.
    const seen = [];
    const numbered = mintKit(async (n) => {
      if (n === 1) { await sleep(30); throw drop(); }
      if (n === 2) { await sleep(15); throw drop(); }
      return 'third';
    });
    const answer = await idempotent('numbered', numbered.resolve, (s) => s.ping(), {
      baseDelayMs: 100, hedgeAfterMs: 20, onRetry: (info) => seen.push(info.attempt),
    });
    assert.equal(answer, 'third');
    assert.deepEqual(seen, [1], `onRetry reported ${JSON.stringify(seen)}, not the failed attempt's own number`);

    // Attempt 1 fails at 30 ms; before its retry is due, attempt 2's hedge
    // started attempt 3, the last, which answers. No retry ran: none is announced.
    const unannounced = [];
    const hedgedPast = mintKit(async (n) => {
      if (n === 1) { await sleep(30); throw drop(); }
      if (n === 2) return never;
      return 'from-hedge';
    });
    assert.equal(await idempotent('hedged past', hedgedPast.resolve, (s) => s.ping(), {
      baseDelayMs: 100, hedgeAfterMs: 20, onRetry: (info) => unannounced.push(info.attempt),
    }), 'from-hedge');
    assert.deepEqual(unannounced, [], 'a retry that never started was announced');
  } finally {
    Math.random = realRandom;
  }

  // A logging hook that throws fails the call with its error.
  const flaky = mintKit(async (n) => {
    if (n === 1) throw drop();
    return 'unreached';
  });
  const sinkDown = new Error('log sink down');
  await assert.rejects(
    idempotent('hook throws', flaky.resolve, (s) => s.ping(), { baseDelayMs: 1, onRetry() { throw sinkDown; } }),
    (error) => error === sinkDown,
  );
  assert.equal(flaky.stubs.length, 1, 'the retry ran although its hook failed');
}

console.log('ok - fabric-do-calls (fresh-stub retry, overloaded refusal, mutating never retries, typed cause)');
