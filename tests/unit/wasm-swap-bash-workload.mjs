#!/usr/bin/env bun
// wasm-swap-bash-workload — the real-workload gate for whole-process swap.
//
// Checkpoints the production bash.async.wasm mid-execution, DESTROYS its
// WebAssembly.Instance, builds a fresh one, restores the image into it and
// rewinds. Bash must resume at the exact instruction and produce output
// byte-identical to an uninterrupted run.
//
// This works because of a property of Asyncify, not of luck: an Asyncify
// unwind writes the entire wasm call stack INTO the module's own linear
// memory. At a park point the process's execution state is ordinary bytes at
// a known address, so linear memory plus the exported mutable globals is the
// whole process, program counter included. bash's own `fork` already depends
// on exactly this, copying memory and globals into a sibling instance and
// rewinding it; checkpointing to storage is the same operation with a
// different destination. JSPI has no equivalent — a JSPI-suspended stack
// lives in engine-owned memory and cannot be read.
//
// The workload is deliberately stateful: a shell function closing over
// globals, a 490-character accumulated string, a 65-character list, and
// arithmetic and loop counters, all built BEFORE the first checkpoint and
// read back AFTER the last. A restore that lost heap state would change the
// POST lines.
//
// The driver is the repo's own run-bash-fork.mjs, patched in memory here. One
// of those patches ports the setjmp slot recycling from bash-runner.ts: the
// stock local harness leaks a slot per setjmp and dies at 32 regardless of
// swap, so without it the workload could not run at all — in either arm.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WasmSwapStore, SWAP_CHUNK_BYTES } from '../../packages/worker/src/runtime/wasm-process-image.ts';

const BASH_DIR = new URL('../../packages/worker/wasm/bash/', import.meta.url).pathname;

// ── patch the harness ───────────────────────────────────────────────────
function patchDriver() {
  let src = readFileSync(join(BASH_DIR, 'run-bash-fork.mjs'), 'utf8');
  const edits = [
    // Let a restored image land in a genuinely fresh instance.
    ['  proc.inst = new WebAssembly.Instance(mod,{ wasi_snapshot_preview1:wasiProxy, nimbus_proc, env });',
     '  proc.reinstantiate = () => { proc.inst = new WebAssembly.Instance(mod,{ wasi_snapshot_preview1:wasiProxy, nimbus_proc, env }); };\n  proc.reinstantiate();'],
    // The park point: after asyncify_stop_unwind, before asyncify_start_rewind.
    ['function resumeProc(proc, before){ if(before)before(); proc.ctx.rewinding=true;',
     'function resumeProc(proc, before){ if(before)before(); if(globalThis.__swapHook) globalThis.__swapHook(proc); proc.ctx.rewinding=true;'],
    // Production setjmp slot recycling (bash-runner.ts).
    ["const idx=c.nextSlot++;if(idx>=NSLOT)throw new Error('slots');",
     "const prev=proc.slotByEnv.get(env); if(prev!==undefined){proc.slotByEnv.delete(env);proc.freeSlots.push(prev);} let idx; if(proc.freeSlots.length>1)idx=proc.freeSlots.shift(); else if(c.nextSlot<NSLOT)idx=c.nextSlot++; else idx=proc.freeSlots.shift(); if(idx===undefined)throw new Error('slots'); proc.slotByEnv.set(env,idx);"],
    ['    MAIN_BUF:0, SLOT0:0,', '    MAIN_BUF:0, SLOT0:0, slotByEnv:new Map(), freeSlots:[],'],
    ['child.ctx.nextSlot=parent.ctx.nextSlot;',
     'child.ctx.nextSlot=parent.ctx.nextSlot; child.slotByEnv=new Map(parent.slotByEnv); child.freeSlots=parent.freeSlots.slice();'],
    // Drivable from this test rather than argv, and returning instead of exiting.
    ['const WASM = process.argv[2];', 'const WASM = globalThis.__WASM ?? process.argv[2];'],
    ["const SCRIPT = process.argv[3] ?? 'echo hi';", "const SCRIPT = globalThis.__SCRIPT ?? process.argv[3] ?? 'echo hi';"],
    ['process.exit(rootExit===0?0:1);', 'globalThis.__RESULT={out:OUT.buf,rootExit,steps};'],
  ];
  for (const [from, to] of edits) {
    const next = src.replace(from, to);
    assert.notEqual(next, src, `driver patch did not apply: ${from.slice(0, 60)}…`);
    src = next;
  }
  const path = join(mkdtempSync(join(tmpdir(), 'nimbus-swap-')), 'driver.mjs');
  writeFileSync(path, src);
  return path;
}

const DRIVER = patchDriver();
const WASM = join(BASH_DIR, 'bash.async.wasm');

const SCRIPT = [
  'mk(){ local n=$1; local a=""; local i=0; while [ $i -lt $n ]; do a="$a<$i>"; i=$((i+1)); done; echo "$a"; }',
  'BIG=$(mk 120)',
  's=0; for j in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do s=$((s+j*j)); done',
  'acc=""; k=0; while [ $k -lt 25 ]; do acc="$acc:$k"; k=$((k+1)); done',
  'greet(){ echo "greet($1) s=$s k=$k"; }',
  'echo "PRE  s=$s k=$k biglen=${#BIG} acclen=${#acc}"',
  'echo "PRE  $(greet alpha)"',
  'm=0; while [ $m -lt 15 ]; do m=$((m+1)); done',
  'echo "POST s=$s k=$k biglen=${#BIG} acclen=${#acc} m=$m"',
  'echo "POST $(greet omega)"',
  'echo "POST tail=${acc#*:20}"',
].join('\n');

// Presence of these is what stops two equally-broken empty runs from
// comparing equal and being called a pass.
const REQUIRED = [
  'PRE  s=2870 k=25 biglen=490 acclen=65',
  'PRE  greet(alpha) s=2870 k=25',
  'POST s=2870 k=25 biglen=490 acclen=65 m=15',
  'POST greet(omega) s=2870 k=25',
  'POST tail=:21:22:23:24',
];

/** Synchronous in-memory kv with the store's measured 2 MiB value ceiling. */
class FakeKv {
  #m = new Map();
  get(k) { return this.#m.get(k); }
  put(k, v) {
    const size = v instanceof Uint8Array ? v.byteLength : String(v).length;
    if (size > SWAP_CHUNK_BYTES) throw new Error(`SQLITE_TOOBIG: ${size}`);
    this.#m.set(k, v instanceof Uint8Array ? v.slice() : v);
  }
  delete(k) { this.#m.delete(k); }
  *list({ prefix = '' } = {}) { for (const e of this.#m) if (e[0].startsWith(prefix)) yield e; }
}

async function run(tag, hook) {
  globalThis.__WASM = WASM;
  globalThis.__SCRIPT = SCRIPT;
  globalThis.__swapHook = hook ?? null;
  globalThis.__RESULT = null;
  await import(`${DRIVER}?v=${tag}`);
  globalThis.__swapHook = null;
  return globalThis.__RESULT;
}

// ── Run 1: uninterrupted reference ──────────────────────────────────────
const baseline = await run('base', null);
assert.ok(baseline, 'baseline produced a result');
assert.equal(baseline.rootExit, 0, 'baseline bash exits cleanly');
for (const marker of REQUIRED) {
  assert.ok(baseline.out.includes(marker), `baseline really ran the workload (missing: ${marker})`);
}

// ── Run 2: repeated checkpoint / instance destruction / restore ─────────
const kv = new FakeKv();
const store = new WasmSwapStore(kv);
const EVERY = 2;
let parks = 0;
const cycles = [];

const swapped = await run('swap', (proc) => {
  parks++;
  if (parks % EVERY !== 0) return;

  // Everything the RUNNER owns. The image covers what lives inside the
  // instance; this is the rest, and it round-trips verbatim.
  const hostState = {
    pid: proc.pid, ppid: proc.ppid,
    MAIN_BUF: proc.MAIN_BUF, SLOT0: proc.SLOT0,
    ctx: { ...proc.ctx },
    slotByEnv: [...proc.slotByEnv],
    freeSlots: proc.freeSlots.slice(),
  };

  const out = store.swapOut(`proc:${proc.pid}`, proc.inst, hostState);

  // Destroy the instance. Everything the process was now exists only as bytes.
  proc.inst = null;
  proc.reinstantiate();

  const restored = store.swapIn(`proc:${proc.pid}`, proc.inst);
  proc.MAIN_BUF = restored.MAIN_BUF;
  proc.SLOT0 = restored.SLOT0;
  Object.assign(proc.ctx, restored.ctx);
  proc.slotByEnv = new Map(restored.slotByEnv);
  proc.freeSlots = restored.freeSlots.slice();

  cycles.push(out);
});

// ── Verdict ─────────────────────────────────────────────────────────────
assert.ok(swapped, 'swap run produced a result');
assert.ok(cycles.length > 0, 'at least one swap cycle ran — otherwise this gate proves nothing');
assert.equal(swapped.rootExit, 0, 'bash exits cleanly after being restored into fresh instances');
assert.equal(swapped.out, baseline.out,
  'a restored process produces byte-identical output to an uninterrupted one');
assert.equal(swapped.steps, baseline.steps,
  'and takes the same number of scheduler steps — it resumed, it did not restart');

// Elision is what makes this affordable: bash reserves a large Asyncify arena
// it mostly never writes, so the image is a small fraction of the address space.
const { liveBytes, imageBytes } = cycles[0];
assert.ok(imageBytes < liveBytes / 10,
  `image (${imageBytes}) must be far smaller than live memory (${liveBytes}) via zero-page elision`);

console.log(
  `wasm-swap-bash-workload: ok — ${cycles.length} instance replacements, ` +
  `${(liveBytes / 1048576).toFixed(1)} MiB live -> ${(imageBytes / 1048576).toFixed(2)} MiB image ` +
  `(${((1 - imageBytes / liveBytes) * 100).toFixed(1)}% elided)`,
);
