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
import { Database } from 'bun:sqlite';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNNER = join(ROOT, 'tests', 'behavioral', 'run-all.mjs');

const SCRATCH = mkdtempSync(join(tmpdir(), 'runner-serialization-'));
const LOCK = join(SCRATCH, 'nimbus-behavioral-run.lock');

/**
 * Run the runner over no probe: one probe selected, in the empty second
 * part of two (a name that matches no probe is refused). The lock is the
 * subject.
 */
function runRunner(args = []) {
  const r = spawnSync('bun', [RUNNER, '--part', '2/2', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      TMPDIR: SCRATCH,
      BASE: 'https://nimbus-tw-serialization-fixture.example.workers.dev',
      NIMBUS_PROBE_ONLY: 'git-local',
    },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const HOLD = `${LOCK}.sqlite`;

/** Hold the lock as a running suite does (run-all.mjs tryHold), described as \`holder\`. */
function holdLock(holder) {
  const db = new Database(HOLD, { create: true });
  db.exec('BEGIN EXCLUSIVE');
  describe(holder);
  return db;
}

/** Only a description: what a run killed before it could release the lock leaves. */
function describe(holder) {
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
const holding = holdLock({
    pid: process.pid,
    runId: 'unit-holder',
    base: 'https://nimbus-tw-holder.example.workers.dev',
    cwd: '/home/agent/Nimbus-wt/other',
    startedAt: new Date(Date.now() - 90_000).toISOString(),
  });
{
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
holding.close();

// [4] A lock left by a killed run is not a permanent outage: a holder
// that no longer exists is stale and gets taken over.
{
  describe({
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

// [5] A description naming a live pid is not a holder. A run killed inside
// a PID namespace of its own recorded its pid there, where a later
// run's same pid is some unrelated process: "pid 12" blocked every suite.
{
  describe({
    pid: process.pid,
    runId: 'unit-other-namespace',
    base: 'https://gone.example.workers.dev',
    cwd: '/tmp',
    startedAt: new Date().toISOString(),
  });
  const r = runRunner();
  assert.equal(r.status, 0, r.out);
  assert.equal(existsSync(LOCK), false, 'the description was replaced and then released');
  console.log('  [5] a recorded pid that is alive but holds nothing does not block');
}

// [6] A holder killed outright releases the lock with its process.
{
  const holder = spawn('bun', ['-e', `
    const { Database } = require('bun:sqlite');
    globalThis.held = new Database(${JSON.stringify(HOLD)}, { create: true });
    globalThis.held.exec('BEGIN EXCLUSIVE');
    console.log('held');
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve) => holder.stdout.once('data', resolve));
  assert.equal(runRunner().status, 3, 'a live holder blocks');
  holder.kill('SIGKILL');
  await new Promise((resolve) => holder.once('exit', resolve));
  const r = runRunner();
  assert.equal(r.status, 0, r.out);
  console.log('  [6] a SIGKILLed holder leaves nothing that blocks');
}

// [7] A run the lock refuses never touches the ledger a running suite
// keeps: before, it emptied the --ledger file first, and the leaks the
// running suite had recorded there were gone.
const LEDGER = join(SCRATCH, 'probe-ledger.jsonl');
const RECORDED = `${JSON.stringify({ probe: 'p.mjs', sid: 'leaked-1', event: 'mint', status: 302, at: new Date().toISOString() })}\n`;
{
  writeFileSync(LEDGER, RECORDED);
  const suite = holdLock({ pid: process.pid, runId: 'unit-ledger-holder', base: 'https://nimbus-tw-holder.example.workers.dev', cwd: '/tmp', startedAt: new Date().toISOString() });
  const r = runRunner(['--ledger', LEDGER]);
  suite.close();
  assert.equal(r.status, 3, r.out);
  assert.equal(readFileSync(LEDGER, 'utf8'), RECORDED, "the refused run left the running suite's ledger as it was");
  console.log('  [7] a run the lock refuses leaves the running suite\'s ledger alone');
}

// [8] --allow-concurrent runs beside another suite, but not into its
// ledger: a path another run is writing is refused, by name.
{
  const writing = new Database(`${LEDGER}.lock`, { create: true });
  writing.exec('BEGIN EXCLUSIVE');
  const r = runRunner(['--allow-concurrent', '--ledger', LEDGER]);
  writing.close();
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, new RegExp(`another behavioral run is writing its session ledger at ${LEDGER.replaceAll('/', '\\/')}`));
  assert.equal(readFileSync(LEDGER, 'utf8'), RECORDED, 'the ledger it refused is untouched');
  console.log('  [8] a ledger another run is writing is refused, even with --allow-concurrent');
}

// [9] A free path is this run's: made even when no probe mints, kept after
// the run, and its lock free again once the run ends (the lock file stays,
// as the run lock's does).
{
  const r = runRunner(['--ledger', LEDGER]);
  assert.equal(r.status, 0, r.out);
  assert.equal(readFileSync(LEDGER, 'utf8'), '', "the run's own ledger, empty: no probe ran");
  assert.match(r.out, new RegExp(`session ledger: ${LEDGER.replaceAll('/', '\\/')}`));
  const next = new Database(`${LEDGER}.lock`);
  next.exec('BEGIN EXCLUSIVE');
  next.close();
  assert.equal(runRunner(['--ledger', LEDGER]).status, 0, 'and the next run takes it');
  console.log('  [9] a free --ledger path is the run\'s, kept after it, and its lock is free again');
}

// [10] A run that waited on a ledger's lock holds the file the next run
// locks too. B opens the lock file, A runs on the path and ends, B takes
// the lock A held, and C, given the same path, is refused. Had A removed
// the lock file as it ended, B would hold a removed file while C made and
// locked a new one: both writing the ledger.
{
  const RACE = join(SCRATCH, 'race-ledger.jsonl');
  const b = new Database(`${RACE}.lock`, { create: true });
  const a = runRunner(['--allow-concurrent', '--ledger', RACE]);
  assert.equal(a.status, 0, a.out);
  b.exec('BEGIN EXCLUSIVE');
  const c = runRunner(['--allow-concurrent', '--ledger', RACE]);
  b.close();
  assert.equal(c.status, 3, `C ran while B held the ledger's lock: ${c.out}`);
  assert.match(c.out, /another behavioral run is writing its session ledger/);
  console.log('  [10] a run that took the lock after the last one ended still keeps the next one out');
}

rmSync(SCRATCH, { recursive: true, force: true });

console.log('probe-runner-serialization: all tests passed');
