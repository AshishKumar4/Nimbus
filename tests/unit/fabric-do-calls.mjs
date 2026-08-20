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

// ── 10. An async resolver composes (a placement pin resolves remotely) ──────

{
  const kit = mintKit(async () => 'pinned');
  const resolveAsync = async () => kit.resolve();
  assert.equal(await idempotent('pinnedRead', resolveAsync, (s) => s.ping(), FAST), 'pinned');
}

console.log('ok - fabric-do-calls (fresh-stub retry, overloaded refusal, mutating never retries, typed cause)');
