#!/usr/bin/env bun
// Someone who ran `npm install @nimbus-sh/fabric` gets working machinery.
//
// The live half of this proof ran once against production workerd (a
// throwaway worker exercised the alarm mux, the generation clock, the launch
// journal across a real ctx.abort(), and a IsolatePool facet — see
// scratchpad/fabric-extraction/consumer-proof-outputs.md for the transcript).
// This test keeps the consumer SHAPE proven on every sweep: out of tarballs,
// from a directory that is not this repo, through the `import` condition —
// dist, the bytes we would actually publish — under plain node.
//
// `npm pack --ignore-scripts`, same reasoning as runtime-npm-package-consumer:
// dist matching src is scripts/dist-integrity.mjs's invariant, and a test that
// silently rebuilds the tree it is testing papers over a stale dist.
//
// Needs the network for fabric's zod dependency.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');

/**
 * What the consumer runs under node. The root export documents that it
 * resolves only on workerd; everything a non-workerd consumer would touch is
 * a subpath module, exercised here against plain objects — the same
 * structural typing the fabric's own harness tests rely on.
 */
const CONSUMER = `import assert from 'node:assert/strict';

// The root export pulls cloudflare:workers and says so; node proves it.
await assert.rejects(import('@nimbus-sh/fabric'), /cloudflare/);

// ── Timer multiplexer ──────────────────────────────────────────────────────
const { TIMER_REASONS_KEY, timers } = await import('@nimbus-sh/fabric/timers.js');
const { GENERATION_KEY, adoptGeneration, generation } =
  await import('@nimbus-sh/fabric/generation.js');

// Live production DO storage keys — the values are a compatibility contract.
assert.equal(TIMER_REASONS_KEY, 'w1_next_alarm_reasons');
assert.equal(GENERATION_KEY, 'w9_isolate_gen');

const kv = new Map();
const alarmsSet = [];
const ctx = {
  storage: {
    get: async (key) => kv.get(key),
    put: async (key, value) => { kv.set(key, value); },
    delete: async (key) => kv.delete(key),
    setAlarm(when) { alarmsSet.push(when); },
  },
};

const host = {};
const now = Date.now();
await timers(host, ctx).schedule('later', now + 60_000);
await timers(host, ctx).schedule('due', now - 10);
// EDF: the real alarm sits at the earliest deadline across reasons.
assert.equal(alarmsSet.at(-1), now - 10);

const fired = [];
await timers(host, ctx).dispatch({
  due: () => { fired.push('due'); },
  later: () => { fired.push('later'); },
});
assert.deepEqual(fired, ['due'], 'only the past-deadline reason fires');
assert.deepEqual(Object.keys(kv.get(TIMER_REASONS_KEY)), ['later'], 'the future reason survives');
assert.equal(alarmsSet.at(-1), now + 60_000, 're-armed at the remaining deadline');

// Unknown reasons are dropped and a drained map is deleted, not re-armed.
kv.set(TIMER_REASONS_KEY, { ghost: now - 5 });
await timers(host, ctx).dispatch({});
assert.equal(kv.has(TIMER_REASONS_KEY), false, 'drained map deleted (hibernation-eligible)');

// ── Generation clock ───────────────────────────────────────────────────────
// Two ctx objects over one storage model two incarnations of one object.
const incarnationA = { storage: ctx.storage };
await adoptGeneration(incarnationA);
await adoptGeneration(incarnationA);   // idempotent per incarnation
assert.equal(generation(incarnationA), 1);
const incarnationB = { storage: ctx.storage };
await adoptGeneration(incarnationB);   // a fresh isolate bumps
assert.equal(generation(incarnationB), 2);
assert.equal(kv.get(GENERATION_KEY), 2);

// ── Launch journal ─────────────────────────────────────────────────────────
const { FencedWork, FENCED_WORK_KEY_PREFIX, FENCED_WORK_MAX_ATTEMPT } =
  await import('@nimbus-sh/fabric/fenced-work.js');
assert.equal(FENCED_WORK_KEY_PREFIX, 'resident-launch:');
assert.equal(FENCED_WORK_MAX_ATTEMPT, 1);

const rows = new Map();
let syncs = 0;
const storage = {
  put: async (key, value) => { rows.set(key, value); },
  delete: async (key) => rows.delete(key),
  list: async ({ prefix }) =>
    new Map([...rows].filter(([key]) => key.startsWith(prefix))),
  sync: async () => { syncs++; },
};
const journalHost = (base, redriven) => ({
  generationBase: () => base,
  waitUntil: () => {},
  redrive: async (record, attempt) => { redriven.push({ pid: record.pid, attempt, note: record.note }); },
});

// Instance A (gen 1) journals a launch; the put is followed by the barrier.
const redroveA = [];
const instanceA = new FencedWork(storage, journalHost(1_000_000, redroveA));
await instanceA.journal({ pid: 1_000_001, command: 'probe', attempt: 0, phase: 'starting', note: 'x' });
assert.ok(syncs >= 1, 'journal() syncs past the put/durability gap');
assert.ok(instanceA.has(1_000_001));

// Its own recovery must not touch its own live pid.
await instanceA.recoverInterrupted();
assert.deepEqual(redroveA, []);

// Instance B (gen 2) replaces it: pid 1,000,001 <= base 2,000,000 → redrive.
const redroveB = [];
const instanceB = new FencedWork(storage, journalHost(2_000_000, redroveB));
await instanceB.recoverInterrupted();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(redroveB, [{ pid: 1_000_001, attempt: 1, note: 'x' }]);
assert.equal(rows.size, 0, 'recovery consumed the row');

// Instance C finds nothing — a redrive is not itself journalled here.
const redroveC = [];
const instanceC = new FencedWork(storage, journalHost(3_000_000, redroveC));
await instanceC.recoverInterrupted();
assert.deepEqual(redroveC, []);

// A record whose budget is spent is abandoned, not looped.
rows.set(FENCED_WORK_KEY_PREFIX + '42', { pid: 42, command: 'x', attempt: 1, phase: 'starting' });
const abandoned = [];
const instanceD = new FencedWork(storage, {
  ...journalHost(1_000_000, []),
  redrive: async () => { throw new Error('must not redrive'); },
  onAbandoned: (record) => abandoned.push(record.pid),
});
await instanceD.recoverInterrupted();
assert.deepEqual(abandoned, [42]);

// Release deletes and syncs; a pid never journalled costs nothing.
const syncsBefore = syncs;
await instanceA.release(1_000_001);
assert.equal(syncs, syncsBefore + 1);
await instanceA.release(7);
assert.equal(syncs, syncsBefore + 1, 'release of an unjournalled pid performs no storage work');

// ── Launch pacer ───────────────────────────────────────────────────────────
const { TurnBudget, PacedWork, TURN_CHUNK_MAX_BYTES } =
  await import('@nimbus-sh/fabric/turn-budget.js');
assert.equal(TURN_CHUNK_MAX_BYTES, 2_000_000);

let turnsRequested = 0;
const pump = new PacedWork(ctx, { requestTurn: () => { turnsRequested++; } });
const pacer = new TurnBudget(pump, 10);
let finished = false;
const launch = (async () => {
  await pacer.spend(6);
  await pacer.spend(6);   // crosses the 10-byte chunk → suspends for a turn
  pacer.settle();
  finished = true;
})();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(finished, false, 'the launch is suspended between chunks');
assert.equal(pump.hasPending, true);
assert.equal(turnsRequested, 1);
await pump.pump();
await launch;
assert.equal(finished, true);
assert.equal(pacer.chunks, 1);
assert.equal(pacer.bytes, 12);

// ── Content-addressed image naming ─────────────────────────────────────────
const { RESIDENT_PROCESS_CLASS, facetImageDigest, facetImagePath, facetImagePathDigest } =
  await import('@nimbus-sh/fabric/process-fabric.js');
assert.equal(RESIDENT_PROCESS_CLASS, 'NimbusProcess');
const digest = await facetImageDigest('export default 42;');
assert.match(digest, /^[0-9a-f]{64}$/);
assert.equal(facetImagePathDigest(facetImagePath(digest)), digest);

console.log('CONSUMER OK');
`;

const work = mkdtempSync(join(tmpdir(), 'fabric-npm-consumer-'));
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });

try {
  // ── 1. Pack what a consumer installs ─────────────────────────────────────
  const tarballs = [];
  for (const pkg of ['fabric', 'core', 'platform']) {
    const packed = JSON.parse(run(
      'npm',
      ['pack', join(REPO, 'packages', pkg), '--json', '--ignore-scripts', '--pack-destination', work],
      work,
    ));
    tarballs.push(join(work, packed[0].filename));
  }
  console.log(`  ok  npm pack → ${tarballs.map((t) => t.split('/').pop()).join(', ')}`);

  // ── 2. A clean directory, outside this repo, that installs them ──────────
  const consumer = mkdtempSync(join(tmpdir(), 'fabric-embedder-'));
  writeFileSync(join(consumer, 'package.json'), `${JSON.stringify({
    name: 'fabric-embedder-acceptance', version: '0.0.0', private: true, type: 'module',
  }, null, 2)}\n`);
  run('npm', ['install', '--no-audit', '--no-fund', ...tarballs], consumer);

  const installed = join(consumer, 'node_modules', '@nimbus-sh', 'fabric');
  assert.ok(existsSync(join(installed, 'dist', 'index.js')), 'fabric installed without a dist');
  assert.ok(existsSync(join(installed, 'dist', 'fenced-work.js')), 'fabric dist is missing modules');
  assert.ok(
    !readFileSync(join(installed, 'package.json'), 'utf8').includes(REPO),
    'the installed fabric points back into the repo',
  );
  console.log(`  ok  installed into ${consumer}`);

  writeFileSync(join(consumer, 'consume.mjs'), CONSUMER);

  // ── 3. Run it under plain node ───────────────────────────────────────────
  const output = run('node', ['consume.mjs'], consumer);
  process.stdout.write(output.replace(/^(?!$)/gm, '  | '));
  assert.match(output, /^CONSUMER OK$/m);
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log('fabric-npm-package-consumer: ok');
