#!/usr/bin/env bun
// @tier slow — long; CI median 38 s wall, 18 s CPU, 0.6 GiB peak (6 runs, 2026-10-06)
// A facet of the local facet host is a realm of its own (Kinu ask 17,
// local-facet-host.ts:183).
//
// The host built each facet's scope in its own realm, so what a program the
// facet ran reached of JavaScript was the host's: Ruby's `js` bridge
// evaluates code there (`JS.eval("globalThis.Promise = null")` broke the
// host's shell), and a guest spinning without a syscall held the host's only
// thread, so nothing could end it. What has to hold, under Bun and under
// Node (run-under-node below):
//
//   (1) a facet that rebinds intrinsics and globals (Array.isArray, Array,
//       setTimeout, Promise, Object.prototype) sees its own rebinding, and
//       leaves the host's untouched;
//   (2) a call's timeout and its abort end a facet that never yields, in
//       JavaScript or in WebAssembly, and the call is answered;
//   (3) a program the workspace runs on the facet host (python3) that never
//       yields is ended by the caller's abort, answering 130, and the host's
//       event loop runs meanwhile;
//   (2, 3) ended means ended: within 1 s of the abort, no CPU is spent by
//       this process or any it started, and they hold no more threads than
//       before the program started (Linux /proc);
//   (4) a facet that waits for no call does not keep the host's process
//       alive, and neither does one a timeout or abort ended: the case's
//       process exits by itself;
//   (5) with the Ruby runtime package (NIMBUS_RUNTIME_PACKAGES, as
//       core-ruby-clang-bun), a Ruby program that rebinds the host's globals
//       through `JS.eval` leaves them untouched, and the workspace keeps
//       working; with the clang package, an aborted compile answers 130;
//   (6) a call's contract: an abort that comes while the facet starts, while
//       its modules compile, or in the same turn as the submit, ends it; a
//       call whose modules fail is retried whole, the ones that did compile
//       included; and an answer that is a view on part of a buffer comes back
//       as that view's type, with its own bytes;
//   (3) also `bash`: an aborted `while :; do :; done` answers 130.
//
// Each case runs in a process of its own (CASE=<name>), under bun against
// the source and under node against the built package (packages/core/dist:
// rebuild first), so a case that holds its process fails alone. No case
// calls process.exit: each must end by itself.
//
// Bun 1.4 cannot terminate a worker thread spinning inside WebAssembly, so
// under Bun a facet is a process of its own (runtime/realm.ts); this is what
// (2) and (3) prove there.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostSqlite } from './lib/host-sqlite.mjs';
import { missingRuntimeFile, RUNTIMES, seedRuntime } from './lib/wasm-runtimes.mjs';

const underBun = typeof process.versions.bun === 'string';
const CASES = ['realm', 'kill', 'ruby', 'calls', 'clang'];

if (process.env.CASE === undefined) {
  const failed = [];
  for (const [engine, args] of [['bun', []], ['node', ['--no-warnings']]]) {
    for (const name of CASES) {
      const child = spawnSync(engine, [...args, fileURLToPath(import.meta.url)], { env: { ...process.env, CASE: name }, encoding: 'utf8', timeout: 120_000 });
      const passed = child.status === 0 && child.stdout.includes(`case ${name} ok`);
      console.log(`  ${passed ? 'ok  ' : 'FAIL'} ${engine} ${name}${passed ? child.stdout.match(/ \(skipped[^)]*\)/)?.[0] ?? '' : `: status ${child.status} ${child.signal ?? ''}\n${(child.stdout + child.stderr).slice(-1500)}`}`);
      if (!passed) failed.push(`${engine} ${name}`);
    }
  }
  assert.deepEqual(failed, [], 'every case passed');
  console.log('ok - local-facet-realm (own realm, timeout and abort end it, kill ends a program, idle facets hold nothing; under Bun and Node)');
  process.exit(0);
}

const core = underBun ? '../../packages/core/src' : '../../packages/core/dist';
const ext = underBun ? 'ts' : 'js';
const { NimbusWorkspace } = await import(`${core}/workspace/nimbus-workspace.${ext}`);
const { localFacetHost } = await import(`${core}/runtime/local-facet-host.${ext}`);

const host = localFacetHost();
/** `promise`, or a rejection after `ms`; the timer goes with it, so it holds nothing (4). */
const within = (promise, ms, what) => {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: not settled after ${ms} ms`)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
};
// ── This process and every process it started: their CPU and their threads ──

const statOf = (pid) => { try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' '); } catch { return null; } };
const family = () => {
  const parentOf = new Map();
  for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
    const stat = statOf(pid);
    if (stat) parentOf.set(pid, stat[1]);
  }
  const members = new Set([String(process.pid)]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, parent] of parentOf) if (members.has(parent) && !members.has(pid)) { members.add(pid); grew = true; }
  }
  return [...members];
};
/** Clock ticks of CPU this process and its descendants have used. */
const cpuTicks = () => family().reduce((sum, pid) => { const stat = statOf(pid); return stat ? sum + Number(stat[11]) + Number(stat[12]) : sum; }, 0);
const threadCount = () => family().reduce((sum, pid) => { try { return sum + readdirSync(`/proc/${pid}/task`).length; } catch { return sum; } }, 0);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * That what an abort ended is over: from 1 s after it, 400 ms in which the
 * family spends no more than a tick or two of CPU (a spinning thread spends
 * about 40), and no process or thread is left that `before` (a
 * {@link settled} count) did not have.
 */
async function assertEnded(what, before) {
  await sleep(1000);
  const from = cpuTicks();
  await sleep(400);
  const spent = cpuTicks() - from;
  assert.ok(spent <= 3, `${what}: nothing spins after the abort (${spent} ticks in 400 ms)`);
  const left = family().filter((pid) => !before.processes.includes(pid));
  assert.deepEqual(left, [], `${what}: no process outlives it`);
  const threads = threadCount();
  assert.ok(threads <= before.threads, `${what}: no thread outlives it (${threads} threads, ${before.threads} before)`);
}

/**
 * The family's processes and thread count once a facet has run and ended:
 * what an ended one must come back to (an engine starts some threads of its
 * own on first use).
 */
async function settled() {
  const warm = host.open({ tag: 'warm' });
  await warm.submit(function warm() { return 1; }, null);
  warm.dispose();
  await sleep(1000);
  return { processes: family(), threads: threadCount() };
}

const hostGlobals = () => ({
  isArray: Array.isArray,
  Array: globalThis.Array,
  setTimeout: globalThis.setTimeout,
  Promise: globalThis.Promise,
  polluted: Object.prototype.polluted,
});
const before = hostGlobals();
const assertHostUntouched = (what) => {
  const now = hostGlobals();
  for (const key of Object.keys(before)) assert.equal(now[key], before[key], `${what}: the host's ${key} is its own`);
  assert.equal(Array.isArray({}), false, `${what}: the host's Array.isArray answers as its own`);
};

switch (process.env.CASE) {
// ── (1) a facet's realm is its own ───────────────────────────────────────────
case 'realm': {
  const facet = host.open({
    tag: 'rebinder',
    preamble: [
      'Array.isArray = () => true;',
      'globalThis.Array = function NotArray() {};',
      'globalThis.setTimeout = () => 0;',
      'globalThis.Promise = null;',
      'Object.prototype.polluted = "yes";',
      'globalThis.__seen = () => [Array.isArray({}), typeof globalThis.Array, ({}).polluted];',
    ].join('\n'),
  });
  const seen = await within(facet.submit(function seen() { return globalThis.__seen(); }, null), 20_000, 'the rebinding facet');
  assert.deepEqual(seen, [true, 'function', 'yes'], '(1) the facet sees its own rebinding');
  assertHostUntouched('(1)');
  // Left open on purpose: an idle facet must not keep this process alive (4).
}

// ── (2) a timeout or an abort ends a facet that never yields ────────────────
{
  const before = await settled();
  const spin = function spin() { for (;;) { /* never yields */ } };
  const timed = host.open({ tag: 'spin-timeout' });
  const started = Date.now();
  await assert.rejects(within(timed.submit(spin, null, { timeoutMs: 300 }), 10_000, 'the timed call'), /timed out after 300 ms/);
  assert.ok(Date.now() - started < 5_000, '(2) the timeout ended it');
  await assert.rejects(timed.submit(function ok() { return 1; }, null), /disposed|ended/, '(2) and the facet with it');
  await assertEnded('(2) a timed-out JavaScript loop', before);

  const controller = new AbortController();
  const aborted = host.open({ tag: 'spin-abort' });
  setTimeout(() => controller.abort(new Error('killed')), 300);
  await assert.rejects(within(aborted.submit(spin, null, { signal: controller.signal }), 10_000, 'the aborted call'), /killed/);
  await assertEnded('(2) an aborted JavaScript loop', before);

  // A loop inside WebAssembly, which calls nothing: (module (func (export "spin") (loop (br 0)))).
  const looping = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 7, 8, 1, 4, 115, 112, 105, 110, 0, 0, 10, 9, 1, 7, 0, 3, 64, 12, 0, 11, 11]).buffer;
  const wasmController = new AbortController();
  const wasm = host.open({ tag: 'spin-wasm', wasmModules: { 'spin.wasm': looping } });
  setTimeout(() => wasmController.abort(new Error('killed')), 300);
  const spinWasm = function spinWasm() { new WebAssembly.Instance(globalThis.__NIMBUS_WASM['spin.wasm'], {}).exports.spin(); };
  await assert.rejects(within(wasm.submit(spinWasm, null, { signal: wasmController.signal }), 10_000, 'the aborted wasm call'), /killed/);
  await assertEnded('(2) an aborted WebAssembly loop', before);
  // (4): the case's process exits by itself.
  break;
}

// ── (3) a program the workspace runs is ended by its abort ───────────────────
case 'kill': {
  const missing = missingRuntimeFile();
  if (missing !== null) {
    console.log(`case kill ok (skipped: ${missing} not built)`);
    break;
  }
  const { sql, transactions } = await hostSqlite();
  const seeding = await NimbusWorkspace.create({ sql, transactions, generation: 1, cwd: '/home/user' });
  for (const runtime of RUNTIMES) seedRuntime(seeding.vfs, runtime);
  const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1, cwd: '/home/user', facets: host });
  assert.equal((await ws.exec('python3 -c "print(6*7)"')).stdout, '42\n');

  const before = await settled();
  const controller = new AbortController();
  let ticks = 0;
  const ticker = setInterval(() => { ticks++; }, 50);
  const started = Date.now();
  const pending = ws.exec('python3 -c "while True: pass"', { signal: controller.signal });
  setTimeout(() => controller.abort(), 500);
  const r = await within(pending, 15_000, 'the aborted python3');
  clearInterval(ticker);
  assert.equal(r.exitCode, 130, `(3) the aborted program answers 130: ${r.stderr}`);
  assert.ok(Date.now() - started < 10_000, '(3) promptly');
  assert.ok(ticks >= 5, `(3) the host's event loop ran while the program spun (${ticks} ticks)`);
  await assertEnded('(3) the aborted python3', before);
  assert.equal((await ws.exec('python3 -c "print(1)"')).stdout, '1\n', '(3) the workspace runs the next program');

  // bash, whose facet is a session of steps.
  assert.equal((await ws.exec('bash -c "echo hi"')).stdout, 'hi\n');
  const bashBefore = await settled();
  const bashController = new AbortController();
  const bashStarted = Date.now();
  const looping = ws.exec('bash -c "while :; do :; done"', { signal: bashController.signal });
  setTimeout(() => bashController.abort(), 500);
  const looped = await within(looping, 15_000, 'the aborted bash');
  assert.equal(looped.exitCode, 130, `(3) the aborted bash answers 130: ${looped.stderr}`);
  assert.ok(Date.now() - bashStarted < 10_000, '(3) promptly');
  await assertEnded('(3) the aborted bash', bashBefore);
  assert.equal((await ws.exec('bash -c "echo again"')).stdout, 'again\n', '(3) the workspace runs the next bash');
  await ws.close();
  break;
}

// ── (6) a call's contract ─────────────────────────────────────────────────────
case 'calls': {
  const spin = function spin() { for (;;) { /* never yields */ } };
  const before = await settled();
  // An abort in the same turn as the submit, and one a microtask later, while the facet starts.
  for (const when of ['sync', 'microtask', 'after start']) {
    const controller = new AbortController();
    const facet = host.open({ tag: `abort-${when}` });
    if (when === 'after start') await facet.submit(function ready() { return 1; }, null);
    const pending = facet.submit(spin, null, { signal: controller.signal });
    if (when === 'sync') controller.abort(new Error('killed'));
    else queueMicrotask(() => controller.abort(new Error('killed')));
    await assert.rejects(within(pending, 10_000, `an abort ${when}`), /killed/, `(6) an abort ${when} ends the call`);
  }
  // An abort while the modules compile (a large image takes a while).
  {
    const controller = new AbortController();
    const facet = host.open({ tag: 'abort-compile' });
    const big = (await import('node:fs')).readFileSync(new URL('../../packages/worker/wasm/python/python.wasm', import.meta.url));
    const image = big.buffer.slice(big.byteOffset, big.byteOffset + big.byteLength);
    const pending = facet.submit(spin, null, { signal: controller.signal, wasmModules: { 'python.wasm': image } });
    setTimeout(() => controller.abort(new Error('killed')), 1);
    await assert.rejects(within(pending, 10_000, 'an abort while compiling'), /killed/, '(6) an abort while the modules compile ends the call');
  }
  await assertEnded('(6) the aborted calls', before);

  // A call whose second module fails is retried whole.
  {
    const valid = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]).buffer;
    const invalid = new Uint8Array([0, 97, 115, 109, 9, 9, 9, 9]).buffer;
    const facet = host.open({ tag: 'modules' });
    const both = function both() { return Object.keys(globalThis.__NIMBUS_WASM).sort(); };
    await assert.rejects(facet.submit(both, null, { wasmModules: { a: valid, b: invalid } }), /./, '(6) an invalid module fails the call');
    assert.deepEqual(await facet.submit(both, null, { wasmModules: { a: valid, b: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]).buffer } }),
      ['a', 'b'], '(6) the retry has every module, the one that compiled before included');
    facet.dispose();
  }

  // Views on part of a buffer come back as their own type, with their own bytes.
  {
    const facet = host.open({ tag: 'views' });
    const view = function view(kind) {
      const buffer = new ArrayBuffer(16);
      new Uint8Array(buffer).set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      return kind === 'words' ? new Uint16Array(buffer, 2, 2) : new DataView(buffer, 4, 3);
    };
    const words = await facet.submit(view, 'words');
    const bytes = await facet.submit(view, 'data');
    assert.ok(words instanceof Uint16Array, `(6) a Uint16Array stays one: ${words?.constructor?.name}`);
    assert.deepEqual([words.length, words.buffer.byteLength, words[0]], [2, 4, 0x0403]);
    assert.ok(bytes instanceof DataView, `(6) a DataView stays one: ${bytes?.constructor?.name}`);
    assert.deepEqual([bytes.byteLength, bytes.buffer.byteLength, bytes.getUint8(0)], [3, 3, 5]);
    facet.dispose();
  }
  break;
}

// ── (5) clang: an aborted compile ends ──────────────────────────────────────
case 'clang': {
  const packages = process.env.NIMBUS_RUNTIME_PACKAGES;
  if (!packages || !existsSync(join(packages, 'clang', 'index.js'))) {
    console.log('case clang ok (skipped: set NIMBUS_RUNTIME_PACKAGES to a directory holding the clang runtime package)');
    break;
  }
  const clang = (await import(join(packages, 'clang', 'index.js'))).default;
  const { sql, transactions } = await hostSqlite();
  const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1, cwd: '/home/user', facets: host, runtimes: [clang] });
  // About 20 s of optimising, in which the compiler makes no syscall, so the
  // abort lands in the middle of it.
  const source = Array.from({ length: 6000 }, (_, i) => `int f${i}(int x) { int s = 0; for (int j = 0; j < x; j++) s += j * ${i} ^ (s >> 3); return s; }`);
  await ws.fs.writeFile('/home/user/a.c', `${source.join('\n')}\nint main(void) { return 0; }\n`);
  const before = await settled();
  const controller = new AbortController();
  const started = Date.now();
  const pending = ws.exec('clang -O2 -c a.c -o a.o', { signal: controller.signal });
  setTimeout(() => controller.abort(), 3000);
  const r = await within(pending, 15_000, 'the aborted clang');
  assert.equal(r.exitCode, 130, `(5) the aborted compile answers 130: ${r.stderr}`);
  assert.ok(Date.now() - started < 5_000, `(5) promptly (${Date.now() - started} ms)`);
  await assertEnded('(5) the aborted clang', before);
  await ws.close();
  break;
}

// ── (5) a Ruby program's JS bridge reaches the facet's realm ────────────────
case 'ruby': {
  const packages = process.env.NIMBUS_RUNTIME_PACKAGES;
  if (!packages || !existsSync(join(packages, 'ruby', 'index.js'))) {
    console.log('case ruby ok (skipped: set NIMBUS_RUNTIME_PACKAGES to a directory holding the ruby runtime package)');
    break;
  }
  const ruby = (await import(join(packages, 'ruby', 'index.js'))).default;
  const { sql, transactions } = await hostSqlite();
  const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1, cwd: '/home/user', facets: host, runtimes: [ruby] });
  const r = await ws.exec(`ruby -e 'require "js"; JS.eval("Array.isArray = () => true; globalThis.setTimeout = () => 0; globalThis.Promise = null; Object.prototype.polluted = 1; return 1"); puts JS.eval("return Array.isArray(1)")'`);
  assert.equal(r.stdout, 'true\n', `(5) the program sees its own rebinding: ${r.stderr}`);
  assertHostUntouched('(5)');
  assert.equal((await ws.exec('echo still-working')).stdout, 'still-working\n', '(5) the workspace keeps working');
  await ws.close();
  break;
}
}
// Not exited: whatever the case left must not hold this process (4).
console.log(`case ${process.env.CASE} ok`);
