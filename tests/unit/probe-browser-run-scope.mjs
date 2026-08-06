#!/usr/bin/env bun
// probe-browser-run-scope — one suite run's browser cleanup must never
// touch another run's browser.
//
// The runner reaps the Chrome a crashed probe leaked. It used to find
// that Chrome by matching every headless process under puppeteer's
// shared temp-profile prefix, which is every concurrent suite's browser
// on the host: measured 2026-08-05, a sweep in one run SIGKILLed a
// sibling run's browser mid-probe and the victim failed for reasons
// that had nothing to do with its own code.
//
// Ownership is now written into the process — each run's browsers keep
// their profiles under that run's directory — so these tests drive the
// matcher and the reaper with real processes and assert the boundary
// holds in both directions.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  allocateProfileDir,
  cleanupRunProfiles,
  findRunBrowsers,
  matchRunBrowser,
  reapRunBrowsers,
  runProfileRoot,
} from '../behavioral/_probe-browser.mjs';

const RUN_A = `unit-a-${process.pid}`;
const RUN_B = `unit-b-${process.pid}`;

// A stand-in for Chrome: the same argv shape (a `chrome` executable
// carrying `--user-data-dir`), a process that stays up until killed.
// Real Chrome is not installed everywhere this suite runs, and what is
// under test is which pid the sweep selects, not what it selects it for.
const BIN_DIR = mkdtempSync(join(tmpdir(), 'probe-browser-scope-'));
const FAKE_CHROME = join(BIN_DIR, 'chrome');
symlinkSync(process.execPath, FAKE_CHROME);

const spawned = [];

function launchFakeBrowser(runId) {
  const profileDir = allocateProfileDir(runId);
  const child = spawn(FAKE_CHROME, [
    '-e', 'setTimeout(() => {}, 600_000)',
    '--', '--headless', `--user-data-dir=${profileDir}`,
  ], { stdio: 'ignore' });
  spawned.push(child);
  return { pid: child.pid, profileDir };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

async function settle(ms = 400) {
  await new Promise((r) => setTimeout(r, ms));
}

// [1] The matcher claims only the browsers of the run it is asked about.
{
  const root = runProfileRoot(RUN_A);
  const mine = `  4242 /opt/google/chrome/chrome --headless --user-data-dir=${root}/17-1`;
  const theirs = `  4243 /opt/google/chrome/chrome --headless --user-data-dir=${runProfileRoot(RUN_B)}/17-1`;

  assert.deepEqual(matchRunBrowser(mine, RUN_A), { pid: 4242, profileDir: `${root}/17-1` });
  assert.equal(matchRunBrowser(theirs, RUN_A), null, "another run's browser is never a candidate");
  console.log('  [1] the matcher selects by owning run, not by "is a headless Chrome"');
}

// [2] Neither a desktop Chrome, nor a puppeteer default-profile Chrome
// from a suite that predates this scoping, nor a command line that
// merely mentions the flag, is ever a candidate.
{
  const cases = [
    '  100 /opt/google/chrome/chrome',
    '  101 /opt/google/chrome/chrome --user-data-dir=/home/user/.config/google-chrome',
    '  102 /opt/google/chrome/chrome --headless --user-data-dir=/tmp/puppeteer_dev_chrome_profile-abc',
    `  103 /bin/bash -c grep --user-data-dir=${runProfileRoot(RUN_A)}/17-1 log.txt`,
    `  104 /opt/google/chrome/chrome --headless --user-data-dir=${runProfileRoot(RUN_A)}-other/1`,
  ];
  for (const line of cases) {
    assert.equal(matchRunBrowser(line, RUN_A), null, `must not match: ${line}`);
  }
  console.log('  [2] desktop Chrome, foreign profiles and lookalike argv are all excluded');
}

// [3] The whole hazard, end to end: two runs each hold a live browser,
// one run sweeps, and the other run's browser is still there.
{
  const a = launchFakeBrowser(RUN_A);
  const b = launchFakeBrowser(RUN_B);
  await settle();

  assert.deepEqual(findRunBrowsers(RUN_A).map((p) => p.pid), [a.pid], 'run A sees exactly its own browser');
  assert.deepEqual(findRunBrowsers(RUN_B).map((p) => p.pid), [b.pid], 'run B sees exactly its own browser');

  assert.equal(reapRunBrowsers(RUN_A), 1, 'run A reaps one browser — its own');
  await settle();

  assert.equal(alive(a.pid), false, "the sweeping run's own leaked browser is killed");
  assert.equal(alive(b.pid), true, "the sibling run's browser survives the sweep");
  assert.equal(existsSync(a.profileDir), false, 'the reaped browser leaves no profile behind');
  assert.equal(existsSync(b.profileDir), true, "the sibling run's profile is untouched");
  console.log('  [3] a sweep in one run leaves another run\'s browser alive');

  assert.equal(reapRunBrowsers(RUN_B), 1);
  await settle();
  assert.equal(alive(b.pid), false, 'run B still reaps its own');
  console.log('  [4] each run remains able to reap what it actually leaked');
}

// [5] Allocation puts every profile under the owning run, so the
// matcher above has something to key on.
{
  const dir = allocateProfileDir(RUN_A);
  assert.ok(dir.startsWith(`${runProfileRoot(RUN_A)}/`), 'profiles live under the run root');
  assert.notEqual(dir, allocateProfileDir(RUN_A), 'two browsers in one run never share a profile');
  console.log('  [5] profiles are allocated under the owning run, one per browser');
}

for (const child of spawned) {
  try { child.kill('SIGKILL'); } catch { /* already reaped */ }
}
cleanupRunProfiles(RUN_A);
cleanupRunProfiles(RUN_B);
rmSync(BIN_DIR, { recursive: true, force: true });

console.log('probe-browser-run-scope: all tests passed');
