#!/usr/bin/env bun
// oom-classify-cpu-vs-memory — the failure ring must not report a CPU kill
// as a memory kill.
//
// The pre-fix classifier folded CPU exhaustion into the 'oom' bucket
// (`if (m.includes('exceeded cpu')) return 'oom'`), so anyone reading an
// 'oom' count was reading memory+CPU merged while believing it was a memory
// signal — the exact wrong turn the `pi --help` hang investigation would
// have taken.
//
// The two conditions ARE separable: workerd carries distinct trace outcomes
// (`exceededMemory` / `exceededCpu`) and words the two message families
// disjointly.
//
// Provenance of the strings asserted below, since it is what makes this
// test worth trusting:
//   - verified present in the workerd binary shipped in node_modules:
//     "Worker has exceeded memory limit.", the broken.exceededMemory
//     storage-cache break, "Memory limit exceeded", the two execution-time
//     strings, "Python Worker exceeded CPU time limit", and both
//     DiffieHellman key-generation strings.
//   - from Nimbus's own captures: "Worker exceeded memory limit." (see
//     diag-counters.ts DiagCounters docs and tests/unit/
//     process-fabric-scheduler.mjs) and "Durable Object's isolate exceeded
//     its memory limit and was reset." (tests/unit/
//     fanout-peer-reset-retry.mjs).
//   - "Worker exceeded CPU time limit." and "Durable Object exceeded its
//     CPU time limit and was reset." are NOT in the OSS binary — CPU
//     enforcement lives in Cloudflare's closed-source limit enforcer — so
//     they are asserted from documented production phrasing, not local
//     verification.

import assert from 'node:assert/strict';
import {
  classifyError, classifyMessage, isOomCause, isTransientDoReset,
} from '../../packages/platform/src/oom-classify.ts';

// ── Memory kills land in 'oom' ──────────────────────────────────────────
// Verbatim `broken.exceededMemory` actor break.
assert.equal(classifyMessage(
  "broken.exceededMemory; jsg.Error: Durable Object's isolate exceeded its memory limit"
  + ' due to overflowing the storage cache. This could be due to writing too many values'
  + ' to storage without stopping to wait for writes to complete, or due to reading too'
  + ' many values in a single operation (e.g. a large list()). All objects in the isolate'
  + ' were reset.'), 'oom');
// The plain Worker memory kill. Pre-fix this fell through to 'unknown': the
// rule matched 'worker exceeded memory' but the real string says "has".
assert.equal(classifyMessage('Worker has exceeded memory limit.'), 'oom');
// The RangeError form.
assert.equal(classifyMessage('Memory limit exceeded'), 'oom');
// The long-standing DO reset phrasing must keep working.
assert.equal(classifyMessage(
  "Durable Object's isolate exceeded its memory limit and was reset"), 'oom');
// The string the process-fabric tests raise as a peer OOM.
assert.equal(classifyMessage('Worker exceeded memory limit.'), 'oom');
// A memory-worded sibling of a CPU string: the split must key on the
// resource named, not on the surrounding sentence.
assert.equal(classifyMessage(
  'DiffieHellman init failed: key generation exceeded memory limit'), 'oom');

// ── CPU kills land in 'cpu_exceeded', never 'oom' ───────────────────────
// Worker scope. Pre-fix this WAS the merge: 'exceeded cpu' matched and
// returned 'oom', so a CPU kill was counted as a memory kill.
assert.equal(classifyMessage('Worker exceeded CPU time limit.'), 'cpu_exceeded');
// Durable Object scope. Pre-fix this was 'unknown' — the rule looked for
// 'exceeded cpu' and the DO string says 'exceeded its CPU'. So the bucket
// was simultaneously over- and under-inclusive.
assert.equal(classifyMessage(
  'Durable Object exceeded its CPU time limit and was reset.'), 'cpu_exceeded');
assert.equal(classifyMessage('Python Worker exceeded CPU time limit'), 'cpu_exceeded');
assert.equal(classifyMessage(
  'DiffieHellman init failed: key generation exceeded CPU limit'), 'cpu_exceeded');

// ── Wall-clock handler timeouts are NOT CPU ─────────────────────────────
// "Actor exceeded event execution time" is the caller-configurable
// setHibernatableWebSocketEventTimeout() bound; the alarm string is its
// twin. A handler blocked on I/O trips these without burning CPU, so
// claiming them as CPU would repeat the merge being undone here.
assert.equal(classifyMessage(
  'broken.dropped; jsg.Error: Actor exceeded event execution time and was disconnected.'),
  'unknown');
assert.equal(classifyMessage(
  'broken.dropped; worker_do_not_log; jsg.Error: Alarm exceeded its allowed execution time'),
  'unknown');

// The buckets are disjoint: no memory string classifies as CPU and vice
// versa. This is the invariant the merge violated.
const MEMORY_KILLS = [
  'Worker exceeded memory limit.',
  'Worker has exceeded memory limit.',
  'Memory limit exceeded',
  "Durable Object's isolate exceeded its memory limit and was reset.",
  "D1 DB's isolate exceeded its memory limit and was reset.",
];
const CPU_KILLS = [
  'Worker exceeded CPU time limit.',
  'Durable Object exceeded its CPU time limit and was reset.',
  'D1 DB exceeded its CPU time limit and was reset.',
];
for (const s of MEMORY_KILLS) assert.equal(classifyMessage(s), 'oom', s);
for (const s of CPU_KILLS) assert.equal(classifyMessage(s), 'cpu_exceeded', s);

// ── The new value is a first-class member of the union ──────────────────
// oom-discriminator.parseFailure() gates rehydration on isOomCause(); a
// value missing from OOM_CAUSES would be silently dropped from the ring on
// every DO wake, so the split must be registered, not just returned.
assert.equal(isOomCause('cpu_exceeded'), true);
assert.equal(isOomCause('oom'), true);
assert.equal(isOomCause('cpu'), false);

// ── Error instances classify the same as their message ──────────────────
assert.equal(
  classifyError(new Error('Durable Object exceeded its CPU time limit and was reset.')),
  'cpu_exceeded');
assert.equal(classifyError(new Error('Worker has exceeded memory limit.')), 'oom');

// ── A resource kill is never a transient reset ──────────────────────────
// fanout-pool retries on isTransientDoReset(). Both kills recur on retry,
// so they must surface rather than loop. Note the CPU string ends in "and
// was reset" — the retry predicate must not be fooled by that into
// treating it as a code-rollover reset.
assert.equal(isTransientDoReset(
  'Durable Object exceeded its CPU time limit and was reset.'), false);
assert.equal(isTransientDoReset('Worker has exceeded memory limit.'), false);

// ── Unrelated buckets are untouched by the split ────────────────────────
assert.equal(classifyMessage('SQLITE_NOMEM: out of memory'), 'sqlite_nomem');
assert.equal(classifyMessage('Cannot deserialize cloned data'), 'clone_refused');
assert.equal(classifyMessage('TimeoutError: facet RPC exceeded 30000ms'), 'rpc_timeout');
assert.equal(classifyMessage('Too many subrequests.'), 'subrequest_cap');
assert.equal(classifyMessage('actor was condemned'), 'condemnation');
assert.equal(classifyMessage('hard evict'), 'hard_evict');
assert.equal(classifyMessage('something else entirely'), 'unknown');

console.log('oom-classify-cpu-vs-memory: OK');
