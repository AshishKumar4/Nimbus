#!/usr/bin/env bun
// keepEsbuild — the esbuild the facet keeps between transform calls.
//
// One esbuild serves every call until a call leaves its wasm memory past the
// high-water mark. From then on it takes no new call, and it is stopped once,
// when its last call ends, never while a call is still running on it. A start
// that failed is forgotten.

import assert from 'node:assert/strict';
import { keepEsbuild } from '../../packages/core/src/runtime/esbuild-service.ts';

const HIGH_WATER = 100;

/** Fake esbuilds: a use sets `esbuild.memory` to what it left the instance at. */
function world({ failStarts = 0 } = {}) {
  const started = [];
  let failing = failStarts;
  const start = async () => {
    await Promise.resolve();
    if (failing-- > 0) throw new Error('wasm instantiation failed');
    const esbuild = { memory: 28, stops: 0, stop() { this.stops++; } };
    started.push(esbuild);
    return { esbuild, memoryBytes: () => esbuild.memory };
  };
  return { started, withEsbuild: keepEsbuild(start, HIGH_WATER) };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

// ── Calls under the mark share one esbuild, one after another and together ──
{
  const { started, withEsbuild } = world();
  for (let call = 0; call < 20; call++) await withEsbuild(async (esbuild) => { esbuild.memory = 52; });
  assert.equal(started.length, 1, 'twenty calls under the mark started one esbuild');
  assert.equal(started[0].stops, 0, 'and stopped none');

  const overlapping = world();
  const used = await Promise.all(Array.from({ length: 8 }, () => overlapping.withEsbuild(async (esbuild) => esbuild)));
  assert.equal(overlapping.started.length, 1, 'eight calls that overlap on a cold start share the one start');
  assert.ok(used.every((esbuild) => esbuild === used[0]));
  console.log('  ok  calls under the high-water mark share one esbuild');
}

// ── A call past the mark retires the esbuild; its stop waits for its last call ──
{
  const { started, withEsbuild } = world();
  const held = deferred();
  const inFlight = withEsbuild(async (esbuild) => { await held.promise; return esbuild; });
  await turn();
  assert.equal(started.length, 1);

  await withEsbuild(async (esbuild) => { esbuild.memory = 500; });
  assert.equal(started[0].stops, 0, 'a call is still running on the retired esbuild, so it is not stopped');

  const next = await withEsbuild(async (esbuild) => esbuild);
  assert.equal(started.length, 2, 'a call after the retirement starts a fresh esbuild');
  assert.notEqual(next, started[0]);
  assert.equal(started[1].stops, 0);

  held.resolve();
  assert.equal(await inFlight, started[0], 'the call that was running finished on the esbuild it began on');
  assert.equal(started[0].stops, 1, 'the retired esbuild is stopped once, when its last call ended');
  assert.equal(started[1].stops, 0, 'the fresh one is kept');
  console.log('  ok  a call past the high-water mark retires the esbuild, stopped after its last call');
}

// ── A retired esbuild with no other call is stopped as its call ends ─────────
{
  const { started, withEsbuild } = world();
  await withEsbuild(async (esbuild) => { esbuild.memory = 500; });
  assert.equal(started[0].stops, 1);
  await withEsbuild(async (esbuild) => { esbuild.memory = 40; });
  assert.equal(started.length, 2);
  assert.equal(started[0].stops, 1, 'stopped once, not again');
  console.log('  ok  a retired esbuild is stopped once');
}

// ── A call that throws still lets go of its esbuild ─────────────────────────
{
  const { started, withEsbuild } = world();
  await assert.rejects(withEsbuild(async (esbuild) => { esbuild.memory = 500; throw new Error('the use failed'); }), /the use failed/);
  assert.equal(started[0].stops, 1, 'the retired esbuild was stopped although its call threw');
  console.log('  ok  a call that throws releases its esbuild');
}

// ── A start that failed is forgotten ────────────────────────────────────────
{
  const { started, withEsbuild } = world({ failStarts: 1 });
  const settled = await Promise.allSettled([withEsbuild(async () => 1), withEsbuild(async () => 2)]);
  assert.deepEqual(settled.map((outcome) => outcome.status), ['rejected', 'rejected'], 'every call waiting on the failed start is refused');
  assert.equal(started.length, 0);
  assert.equal(await withEsbuild(async () => 3), 3, 'the next call starts afresh rather than reusing the rejection');
  assert.equal(started.length, 1);
  console.log('  ok  a failed start is not kept');
}

console.log('keep-esbuild OK');
