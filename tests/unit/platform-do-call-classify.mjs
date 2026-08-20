#!/usr/bin/env bun
// The Durable Object call classifier, specified from Proteus's hand-written
// do-rpc.ts (cf-backend/src/lib/do-rpc.ts:71-134) and the Cloudflare
// error-handling contract agent-core's backlog quotes: errors carry
// .retryable and .overloaded, a retryable error is retried on a FRESH stub,
// and an overloaded one must not be retried at all.
//
// The mechanics that matter, each proven at the consumer:
//   - prose patterns are tested against the WHOLE rendered cause chain,
//     because a wrapper (Proteus's SqlError) drops the .retryable property;
//   - the .retryable flag is read per link, cycle-guarded;
//   - overloaded vetoes retryable: an overloaded-and-retryable error is
//     overloaded (do-rpc.ts:127-129), read from the property OR the message.

import assert from 'node:assert/strict';
import { classifyDoCall, isRetryableDoCall } from '../../packages/platform/src/oom-classify.ts';

const cls = (error) => classifyDoCall(error);

// The three platform prose classes, at their observed wordings.
assert.equal(cls(new Error('Durable Object reset because its code was updated.')), 'superseded_isolate');
assert.equal(cls(new Error('This script has been upgraded to a newer version')), 'superseded_isolate');
assert.equal(cls(new Error('Network connection lost.')), 'connection_lost');
assert.equal(
  cls(new Error('Internal error while starting up Durable Object storage caused object to be reset; reference = x')),
  'storage_reset',
);
assert.equal(
  cls(new Error('Durable Object storage operation exceeded timeout which caused the object to be reset.')),
  'storage_reset',
);
// The live-write wording of the same storage condition — Nimbus measured a
// reset mid-write succeed 12/12 on retry (oom-classify.ts, isTransientDoReset).
assert.equal(
  cls(new Error('Internal error in Durable Object storage caused object to be reset; reference = y')),
  'storage_reset',
);

// The prose is matched across the rendered CAUSE CHAIN: a wrapper must not
// hide the platform's wording.
assert.equal(
  cls(new Error('query failed', { cause: new Error('Network connection lost.') })),
  'connection_lost',
);

// The .retryable flag, read per link — including on a wrapped inner error.
{
  const inner = new Error('transient by flag');
  inner.retryable = true;
  assert.equal(cls(inner), 'retryable_flag');
  assert.equal(cls(new Error('wrapped', { cause: inner })), 'retryable_flag');
}

// Overloaded is its own class and it VETOES retryable.
{
  const overloadedByMessage = new Error('Durable Object is overloaded.');
  assert.equal(cls(overloadedByMessage), 'overloaded');

  const overloadedByFlag = new Error('shed');
  overloadedByFlag.overloaded = true;
  assert.equal(cls(overloadedByFlag), 'overloaded');

  const both = new Error('shed under pressure');
  both.retryable = true;
  both.overloaded = true;
  assert.equal(cls(both), 'overloaded', 'retrying an overloaded object is what overloaded it');
}

// A cause cycle must not hang the walk.
{
  const a = new Error('a');
  const b = new Error('b', { cause: a });
  a.cause = b;
  assert.equal(cls(a), 'permanent');
}

// Everything else is permanent, including non-Error throws.
assert.equal(cls(new Error('no grant from receiver for cross-owner sender')), 'permanent');
assert.equal(cls('a bare string'), 'permanent');
assert.equal(cls(undefined), 'permanent');

// Resource kills must stay permanent here: a memory or CPU kill recurs on
// retry and must surface, not loop (the classifyMessage split's whole point).
assert.equal(cls(new Error("Durable Object's isolate exceeded its memory limit and was reset.")), 'permanent');
assert.equal(cls(new Error('Durable Object exceeded its CPU time limit and was reset.')), 'permanent');

// The retry predicate: the four transient classes retry, the rest never do.
assert.equal(isRetryableDoCall('superseded_isolate'), true);
assert.equal(isRetryableDoCall('connection_lost'), true);
assert.equal(isRetryableDoCall('storage_reset'), true);
assert.equal(isRetryableDoCall('retryable_flag'), true);
assert.equal(isRetryableDoCall('overloaded'), false);
assert.equal(isRetryableDoCall('permanent'), false);

console.log('ok - platform-do-call-classify (prose chain, per-link flags, overloaded veto, cycle guard)');
