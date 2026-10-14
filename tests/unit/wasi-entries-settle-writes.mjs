#!/usr/bin/env bun
/**
 * wasi-entries-settle-writes — every entry that runs a WASI guest ends its
 * run one way (wasi/preamble.ts __wasiSettled): what the process wrote is in
 * the session before the result says the run happened, and a run whose
 * writes the session could not take fails, saying why. The one-shot entry
 * (__wasiRunStartAsync) and CPython's did; Ruby's (__rubyRun) settled only
 * its output, and the threaded entry (__wasiRunStartThreads) returned the
 * scheduler's result as it came, so either could report a clean run whose
 * session had restarted under it.
 *
 * The guest is the resident one (lib/wasi-resident-guest.mjs): its module is
 * the WASI body (which carries the threads scheduler), with Ruby's tail after
 * it for Ruby, as a facet composes them.
 * Ruby's VM is not in this repo (its runtime package is, for
 * core-ruby-clang-bun.mjs), so the VM here is the runner's bootstrap with an
 * init that makes the program's calls as ruby.wasm would, through the
 * process's WASI imports, then traps.
 */

import assert from 'node:assert/strict';
import { RUBY_RUNNER_PREAMBLE_TAIL } from '../../packages/core/src/runtime/ruby-runner.ts';
import { canPark, residentGuest, USER } from './lib/wasi-resident-guest.mjs';

if (!canPark) {
  console.log('wasi-entries-settle-writes: SKIPPED (this engine has no JSPI, so a guest answers from the session)');
  process.exit(0);
}

const ESRCH = 71;
const RESTARTED = /session no longer holds this process \(process pid \d+ does not exist\): it restarted, or ended the process, while the program ran/;
const KEPT = 'home/user/kept.txt';

/** A guest whose module carries `source`, for `body`, then disposed: one at a time, as each module installs its entries on globalThis. */
async function withGuest(source, body) {
  const guest = await residentGuest({ source });
  try { await body(guest); } finally { await guest.dispose(); }
}

/** The program writes KEPT and leaves it open; with `restart`, its session then restarts and its next call is refused. */
async function program(guest, { restart }) {
  const fd = await guest.open(KEPT, { create: true, write: true });
  assert.equal(await guest.write(fd, 'kept by the settle'), 0);
  if (!restart) return;
  guest.restartSession();
  assert.equal(await guest.sync(fd), ESRCH, 'the restarted session refuses the process');
}

const readKept = (guest) => guest.kernel.readFileString(KEPT);

const failed = [];
/** Each case runs, and each failure is named; the file fails at the end if any did. */
const check = async (name, source, fn) => {
  try {
    await withGuest(source, fn);
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed.push(name);
    console.log(`  ✗ ${name}: ${error?.message ?? error}`);
  }
};

// ── The threaded entry ────────────────────────────────────────────────────
// A module whose _start returns at once: the program's calls are the test's, made before it runs.
const EMPTY_START = new WebAssembly.Module(new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
  0x03, 0x02, 0x01, 0x00,
  0x07, 0x0a, 0x01, 0x06, 0x5f, 0x73, 0x74, 0x61, 0x72, 0x74, 0x00, 0x00,
  0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b,
]));
const threaded = async (guest) => {
  const sched = globalThis.__wasiThreadsCreate({ memory: guest.memory, startThread: () => { throw new Error('this program starts no threads'); } });
  return await globalThis.__wasiRunStartThreads(new WebAssembly.Instance(EMPTY_START), sched);
};
await check('threaded: what the program wrote is in the session when the run returns', '', async (guest) => {
  await program(guest, { restart: false });
  const run = await threaded(guest);
  assert.deepEqual(run, { exitCode: 0 });
  assert.equal(readKept(guest), 'kept by the settle', 'what the program wrote is in the session when the run returns');
});
await check('threaded: a run whose session restarted under it fails, saying why', '', async (guest) => {
  await program(guest, { restart: true });
  const run = await threaded(guest);
  assert.equal(run.exitCode, 1, 'a threaded run whose session restarted under it fails');
  assert.match(run.error ?? '', RESTARTED, 'and says why');
});

// ── Ruby's entry ──────────────────────────────────────────────────────────
/** __rubyRun over `guest`, its VM's init running `program` then trapping. */
async function ruby(guest, options) {
  globalThis.__nimbusRubySupervisor = { ...guest.supervisor, stdout() {}, stderr() {} };
  globalThis.__rubyBootstrap = Promise.resolve({
    ok: true,
    rubyInitialized: false,
    writeListString: () => ({ ptr: 0, len: 0 }),
    async rubyInit() {
      await program(guest, options);
      throw new Error('the VM trapped');
    },
    async rubyInitLoadpath() {},
  });
  return await globalThis.__rubyRun({
    cred: USER, supervisorPid: guest.pid, userCode: '', rbArgv: ['ruby'], progName: 'ruby', binName: 'ruby', cwd: '/home/user', userEnv: {},
  });
}
await check('ruby: what the program wrote before a trap is in the session when the run returns', RUBY_RUNNER_PREAMBLE_TAIL, async (guest) => {
  const run = await ruby(guest, { restart: false });
  assert.equal(run.exitCode, 1);
  assert.match(run.error ?? '', /the VM trapped/);
  assert.equal(readKept(guest), 'kept by the settle', 'what the program wrote before the trap is in the session when the run returns');
});
await check('ruby: a trapped run whose session restarted names the trap and the restart', RUBY_RUNNER_PREAMBLE_TAIL, async (guest) => {
  const run = await ruby(guest, { restart: true });
  assert.equal(run.exitCode, 1);
  assert.match(run.error ?? '', /the VM trapped/, 'the trap is still the run\'s error');
  assert.match(run.error ?? '', RESTARTED, 'and the restart is named with it');
});
assert.deepEqual(failed, [], 'every entry settles its run');
console.log('wasi-entries-settle-writes: ok');
