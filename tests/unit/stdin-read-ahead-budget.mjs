#!/usr/bin/env bun
// A pipe's read ahead, for a program that reads stdin synchronously, is held
// in the session Durable Object, so the session has one budget for it
// (stdin-read.ts ReadAheadBudget, facetMgr.stdinReadAhead). Three concurrent
// 16 MiB read aheads used to hold 48 MiB there at once (115 MB of the 128 MB
// isolate on a Preview). The budget counts the bytes launches hold, charged a
// piece at a time as they are read: a launch waiting on a slow writer holds
// almost none of it, and one the budget cannot cover streams the rest of its
// pipe. Every launch returns what it held however it ended: exit, a failed
// launch, or an abort.

import assert from 'node:assert/strict';
import { runFresh } from '../../packages/worker/src/runtime/node-runner.ts';
import { ReadAheadBudget, STDIN_SYNC_READ_BYTES } from '../../packages/core/src/runtime/stdin-read.ts';

const PIECE = new Uint8Array(64 * 1024).fill(121);
/**
 * A pipe of `bytes` bytes, read a piece at a time; with `stallAfter`, its
 * writer goes quiet after that many bytes without ending it.
 */
function pipe(bytes, stallAfter = Infinity) {
  let left = bytes;
  let sent = 0;
  return {
    read: async () => { throw new Error('the runner reads bytes'); },
    async readBytes(max) {
      await new Promise((resolve) => setImmediate(resolve));
      if (sent >= stallAfter) await new Promise(() => {});
      if (left <= 0) return null;
      sent += Math.min(max, PIECE.length, left);
      const n = Math.min(max, PIECE.length, left);
      left -= n;
      return PIECE.subarray(0, n);
    },
  };
}
/** Everything a launch's stdin pipe delivers, as the exec pump would take it. */
async function drain(stdinPipe) {
  let total = 0;
  for (;;) {
    const piece = await stdinPipe.readBytes(64 * 1024);
    if (piece === null) return total;
    total += piece.byteLength;
  }
}

function facetManager({ gate, fail } = {}) {
  const budget = new ReadAheadBudget(STDIN_SYNC_READ_BYTES + 1);
  const launches = [];
  return {
    budget,
    launches,
    stdinReadAhead: budget,
    async exec(_code, opts) {
      const launch = { whole: opts.stdinWhole === true, heldAtStart: budget.held };
      launches.push(launch);
      if (gate) await gate(launches.length);
      if (fail) throw new Error('launch failed');
      launch.delivered = opts.stdinPipe ? await drain(opts.stdinPipe) : 0;
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
}
const SIXTEEN = STDIN_SYNC_READ_BYTES;
const run = (fm, stdin, signal) => runFresh(fm, 'require("fs").readFileSync(0)', { argv: [], stdin, stdinReadsSync: true, signal });

// A launch waiting on a silent writer holds one piece in flight, not the
// budget: a concurrent launch with a quick 13-byte writer still gets its
// whole pipe before it starts (Node prints both).
{
  const fm = facetManager();
  const abort = new AbortController();
  const waiting = run(fm, pipe(SIXTEEN, 0), abort.signal);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(fm.budget.held <= 64 * 1024, `a launch waiting on its writer holds ${fm.budget.held} bytes`);
  const quick = await run(fm, pipe(13));
  assert.equal(quick.exitCode, 0);
  assert.deepEqual(fm.launches.map((l) => [l.whole, l.delivered]), [[true, 13]], 'the quick launch gets its whole pipe');
  abort.abort();
  assert.equal((await waiting).exitCode, 130);
  assert.equal(fm.budget.held, 0);
}

// The budget bounds what the session holds: a launch holding a 16 MiB read
// ahead leaves a concurrent one too little, and that one streams its pipe;
// both deliver all of it and the budget ends whole.
{
  let bigHeld;
  const smallDone = new Promise((resolve) => { bigHeld = resolve; });
  let finishSmall;
  const fm = facetManager({ gate: async (n) => { if (n === 1) { bigHeld(); await new Promise((resolve) => { finishSmall = resolve; }); } } });
  const big = run(fm, pipe(SIXTEEN));
  await smallDone;
  assert.equal(fm.budget.held, SIXTEEN, 'the whole 16 MiB pipe is held until the program takes it');
  await run(fm, pipe(1024));
  finishSmall();
  await big;
  assert.deepEqual(fm.launches.map((l) => [l.whole, l.delivered]), [[true, SIXTEEN], [false, 1024]]);
  assert.equal(fm.budget.held, 0);
}

// Three concurrent 16 MiB read aheads never hold more than the budget
// together, and each still delivers its whole pipe.
{
  let release;
  const allIn = new Promise((resolve) => { release = resolve; });
  const fm = facetManager({ gate: async (n) => { if (n === 3) release(); await allIn; } });
  const results = await Promise.all([run(fm, pipe(SIXTEEN)), run(fm, pipe(SIXTEEN)), run(fm, pipe(SIXTEEN))]);
  assert.deepEqual(results.map((r) => r.exitCode), [0, 0, 0]);
  for (const l of fm.launches) assert.ok(l.heldAtStart <= SIXTEEN + 1, `the session never holds more than the budget: ${l.heldAtStart}`);
  assert.deepEqual(fm.launches.map((l) => l.delivered), [SIXTEEN, SIXTEEN, SIXTEEN], 'streaming launches still get their whole pipe');
  assert.equal(fm.budget.held, 0, 'the budget is whole again once all exit');
}

// A writer that only yields text, in pieces larger than the read ahead asks
// for, is charged for every byte the launch holds.
{
  const fm = facetManager();
  const text = 'y'.repeat(SIXTEEN + 4 * 1024 * 1024);
  let sent = false;
  const textPipe = { read: async () => { if (sent) return null; sent = true; return text; } };
  await run(fm, textPipe);
  assert.deepEqual(fm.launches.map((l) => [l.whole, l.heldAtStart, l.delivered]), [[false, SIXTEEN + 1, text.length]]);
  assert.equal(fm.budget.held, 0);
}

// A launch that fails returns what it held.
{
  const fm = facetManager({ fail: true });
  await assert.rejects(run(fm, pipe(1024)), /launch failed/);
  assert.equal(fm.budget.held, 0, 'a failed launch returns what it held');
}

// An abort during the read ahead (Ctrl+C while the writer is quiet) returns
// what it held, and the next launch can read its whole pipe ahead again.
{
  const fm = facetManager();
  const abort = new AbortController();
  const aborted = run(fm, pipe(SIXTEEN, 1024 * 1024), abort.signal);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(fm.budget.held > 0, 'the aborted launch held read ahead');
  abort.abort();
  assert.equal((await aborted).exitCode, 130);
  assert.equal(fm.budget.held, 0, 'an aborted launch returns what it held');
  await run(fm, pipe(SIXTEEN));
  assert.equal(fm.launches.at(-1).whole, true, 'the next launch reads its whole pipe ahead');
  assert.equal(fm.budget.held, 0);
}

console.log('stdin-read-ahead-budget: one read-ahead budget per session, returned however a launch ends');
