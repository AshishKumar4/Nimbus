#!/usr/bin/env bun
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
//   (2) a call's timeout and its abort end a facet that never yields, and
//       the call is answered;
//   (3) a program the workspace runs on the facet host (python3) that never
//       yields is ended by the caller's abort, answering 130, and the host's
//       event loop runs meanwhile;
//   (4) a facet that waits for no call does not keep the host's process
//       alive, and neither does one a timeout or abort ended: the case's
//       process exits by itself;
//   (5) with the Ruby runtime package (NIMBUS_RUNTIME_PACKAGES, as
//       core-ruby-clang-bun), a Ruby program that rebinds the host's globals
//       through `JS.eval` leaves them untouched, and the workspace keeps
//       working.
//
// Each case runs in a process of its own (CASE=<name>), under bun against
// the source and under node against the built package (packages/core/dist:
// rebuild first), so a case that holds its process fails alone.
//
// Bun 1.4 cannot terminate a worker thread spinning inside WebAssembly (a
// worker spinning in JavaScript it can): the aborted python3 answers 130 and
// the host runs on, but the guest's thread spins until the process exits, so
// under Bun the `kill` case exits explicitly. Under Node it ends by itself.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostSqlite } from './lib/host-sqlite.mjs';
import { missingRuntimeFile, RUNTIMES, seedRuntime } from './lib/wasm-runtimes.mjs';

const underBun = typeof process.versions.bun === 'string';
const CASES = ['realm', 'kill', 'ruby'];

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
  const spin = function spin() { for (;;) { /* never yields */ } };
  const timed = host.open({ tag: 'spin-timeout' });
  const started = Date.now();
  await assert.rejects(within(timed.submit(spin, null, { timeoutMs: 300 }), 10_000, 'the timed call'), /timed out after 300 ms/);
  assert.ok(Date.now() - started < 5_000, '(2) the timeout ended it');
  await assert.rejects(timed.submit(function ok() { return 1; }, null), /disposed|ended/, '(2) and the facet with it');

  const controller = new AbortController();
  const aborted = host.open({ tag: 'spin-abort' });
  setTimeout(() => controller.abort(new Error('killed')), 300);
  await assert.rejects(within(aborted.submit(spin, null, { signal: controller.signal }), 10_000, 'the aborted call'), /killed/);
  // (4): the case's process exits by itself.
  break;
}

// ── (3) a program the workspace runs is ended by its abort ───────────────────
case 'kill': {
  const missing = missingRuntimeFile();
  if (missing !== null) {
    console.log(`case kill ok (skipped: ${missing} not built)`);
    process.exit(0);
  }
  const { sql, transactions } = await hostSqlite();
  const seeding = await NimbusWorkspace.create({ sql, transactions, generation: 1, cwd: '/home/user' });
  for (const runtime of RUNTIMES) seedRuntime(seeding.vfs, runtime);
  const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1, cwd: '/home/user', facets: host });
  assert.equal((await ws.exec('python3 -c "print(6*7)"')).stdout, '42\n');

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
  assert.equal((await ws.exec('python3 -c "print(1)"')).stdout, '1\n', '(3) the workspace runs the next program');
  await ws.close();
  if (underBun) {
    // Bun cannot terminate the spinning guest's thread (see the header).
    console.log('case kill ok');
    process.exit(0);
  }
  break;
}

// ── (5) a Ruby program's JS bridge reaches the facet's realm ────────────────
case 'ruby': {
  const packages = process.env.NIMBUS_RUNTIME_PACKAGES;
  if (!packages || !existsSync(join(packages, 'ruby', 'index.js'))) {
    console.log('case ruby ok (skipped: set NIMBUS_RUNTIME_PACKAGES to a directory holding the ruby runtime package)');
    process.exit(0);
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
