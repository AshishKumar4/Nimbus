#!/usr/bin/env bun
// Behavior test: a setjmp capture of the wasm bash lives exactly as long as a
// buffer can still jump to it (bash-runner@4, bash/capture-store.ts).
//
// bash copies jmp_bufs by value around eval, functions, traps and sourced
// files; the 5.2.37-4 build reports every copy and every end of a saved one
// (wasm/bash/patches/procenv.patch), and a copy on the stack ends with its
// frame. So the captures a shell holds do not grow with how much it has run,
// a jump out of many frames lets go of the copies they held, freed captures
// are packed away as they build, and a fork copies only the captures that
// live. Driven through REAL bash on the REAL staged
// wasm, through the runner's own scheduler.

import assert from 'node:assert/strict';
import { runScript } from './lib/bash-preamble.mjs';

const fs = { dirs: ['tmp'], files: { 'tmp/inc.sh': 'v=$((v+1))\n' }, modes: { tmp: 7 } };
const run = async (script) => {
  const r = await runScript(script, fs);
  assert.equal(r.state, 'exited', `${script}: ${r.error ?? r.stderr}`);
  return r;
};
const failures = [];
const check = async (what, body) => {
  try { await body(); console.log(`  ✓ ${what}`); }
  catch (error) { failures.push(`${what}: ${error.message}`); console.log(`  ✗ ${what}`); }
};

// Every way bash saves and restores a jmp_buf, many times over: the captures held at once do not grow with the count.
const soak = (n) => `v=0; f(){ local w; eval 'w=$((w+1))'; [ "$w" = 1 ]; source /tmp/inc.sh; return 2; }
for i in $(seq ${n}); do eval 'f'; s=$?; trap 'v=$v' RETURN; done; trap - RETURN; echo "$v $s"`;
await check('the captures a shell holds do not grow with what it has run', async () => {
  const few = await run(soak(100)), many = await run(soak(1000));
  assert.equal(few.stdout, '100 2\n');
  assert.equal(many.stdout, '1000 2\n');
  assert.ok(Number.isInteger(few.stats.captureLiveHi) && few.stats.captureLiveHi > 0, JSON.stringify(few.stats));
  assert.equal(many.stats.captureLiveHi, few.stats.captureLiveHi, JSON.stringify({ few: few.stats, many: many.stats }));
});

// A return out of nested evals jumps past the frames that saved copies of return_catch: they end with the jump.
const skip = (n) => `f(){ eval 'eval "eval \\"return 3\\""'; echo UNREACHABLE; }; for i in $(seq ${n}); do f; s=$?; done; echo "$s"`;
await check('a jump out of many frames lets go of the copies they held', async () => {
  const few = await run(skip(100)), many = await run(skip(1000));
  assert.equal(many.stdout, '3\n');
  assert.ok(Number.isInteger(few.stats.captureLiveHi) && few.stats.captureLiveHi > 0, JSON.stringify(few.stats));
  assert.equal(many.stats.captureLiveHi, few.stats.captureLiveHi, JSON.stringify({ few: few.stats, many: many.stats }));
});

// A function's return_catch and the test builtin's buffer, set in turn, free each other's capture below the newest:
// freed space is packed away as it builds, so the arena a shell touches does not grow with how many it took
// (15 MiB of captures, 3000 of them); a fork then copies the captures that live, not the arena.
await check('freed captures are packed as they build, and a fork copies only the live ones', async () => {
  const fresh = await run('(echo child); echo done');
  const few = await run('f(){ [ 1 ]; }; for i in $(seq 300); do f; done; (echo child); echo done');
  const many = await run('f(){ [ 1 ]; }; for i in $(seq 1500); do f; done; (echo child); echo done');
  assert.equal(many.stdout, 'child\ndone\n');
  assert.ok(many.stats.captureCompactions > few.stats.captureCompactions, JSON.stringify({ few: few.stats, many: many.stats }));
  assert.ok(many.stats.captureBytesHi < 4 << 20, JSON.stringify(many.stats));
  assert.ok(many.stats.captureBytesHi <= few.stats.captureBytesHi + (256 << 10), JSON.stringify({ few: few.stats.captureBytesHi, many: many.stats.captureBytesHi }));
  assert.ok(many.stats.forkCopied - fresh.stats.forkCopied < 1 << 20, JSON.stringify({ fresh: fresh.stats.forkCopied, many: many.stats.forkCopied }));
});

assert.deepEqual(failures, []);
console.log('bash-capture-lifetime: captures live as long as a buffer names them');
