#!/usr/bin/env bun
// probe-runner-serialization — two behavioral suites must not start on
// one machine by accident.
//
// Concurrent suites are not merely slow: they contend for the host's CPU
// and memory, and a redeploy inside one rotates the signing secret the
// other is mid-run with. Both were measured 2026-08-05 on this machine,
// and between them they account for the "mass failure" runs we chased.
// The runner therefore takes a machine-wide lock, and the interesting
// property is what it does when the lock is already held.
//
// Driven through the runner's own CLI, with TMPDIR pointed at a scratch
// directory so the lock under test is never the machine's real one.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNNER = join(ROOT, 'tests', 'behavioral', 'run-all.mjs');

const SCRATCH = mkdtempSync(join(tmpdir(), 'runner-serialization-'));
const LOCK = join(SCRATCH, 'nimbus-behavioral-run.lock');

/** Run the runner over an empty probe selection: the lock is the subject. */
function runRunner(args = []) {
  const r = spawnSync('bun', [RUNNER, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      TMPDIR: SCRATCH,
      BASE: 'https://nimbus-tw-serialization-fixture.example.workers.dev',
      NIMBUS_PROBE_ONLY: '__no_such_probe__',
    },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function holdLock(holder) {
  writeFileSync(LOCK, `${JSON.stringify(holder, null, 2)}\n`);
}

// [1] A free lock is taken, used, and given back.
{
  const r = runRunner();
  assert.equal(r.status, 0, r.out);
  assert.equal(existsSync(LOCK), false, 'the lock is released when the run ends');
  console.log('  [1] a run takes the lock and releases it on exit');
}

// [2] A held lock stops the second run, and the refusal names the
// holder — pid, target and directory — so the operator can decide
// whether to wait or to kill it. Silence here is what let two suites
// collide and then blame each other's failures.
{
  holdLock({
    pid: process.pid,
    runId: 'unit-holder',
    base: 'https://nimbus-tw-holder.example.workers.dev',
    cwd: '/home/agent/Nimbus-wt/other',
    startedAt: new Date(Date.now() - 90_000).toISOString(),
  });
  const r = runRunner();
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /another behavioral suite is already running/);
  assert.match(r.out, new RegExp(`pid ${process.pid}`));
  assert.match(r.out, /nimbus-tw-holder/);
  assert.match(r.out, /Nimbus-wt\/other/);
  assert.match(r.out, /--allow-concurrent/);
  assert.equal(
    JSON.parse(readFileSync(LOCK, 'utf8')).pid, process.pid,
    "the refused run must not take over the holder's lock",
  );
  console.log('  [2] a second run refuses, naming the holder and the way around it');
}

// [3] The override exists, because a deliberate second run is a real
// thing; it just has to be asked for.
{
  const r = runRunner(['--allow-concurrent']);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /\[--allow-concurrent\] running alongside pid/);
  assert.equal(JSON.parse(readFileSync(LOCK, 'utf8')).pid, process.pid, 'the holder keeps its lock');
  console.log('  [3] --allow-concurrent runs anyway, and leaves the holder alone');
}

// [4] A lock left by a killed run is not a permanent outage: a holder
// that no longer exists is stale and gets taken over.
{
  holdLock({
    pid: 2_147_483_600,       // above pid_max: no process can hold it
    runId: 'unit-dead',
    base: 'https://gone.example.workers.dev',
    cwd: '/tmp',
    startedAt: new Date().toISOString(),
  });
  const r = runRunner();
  assert.equal(r.status, 0, r.out);
  assert.equal(existsSync(LOCK), false, 'the stale lock was taken over and then released');
  console.log('  [4] a stale lock is taken over rather than blocking forever');
}

rmSync(SCRATCH, { recursive: true, force: true });

console.log('probe-runner-serialization: all tests passed');
