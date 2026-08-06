// _probe-browser.mjs — which Chrome belongs to which suite run.
//
// WHY THIS EXISTS
//   Browser probes launch a real headless Chrome and close it in a
//   `finally`. A hard runtime crash skips that, so the Chrome is
//   reparented to init and keeps its hundreds of MiB. The runner reaps
//   those orphans between probes to keep each probe starting from a
//   clean baseline.
//
//   Reaping used to match any headless Chrome under puppeteer's default
//   temp-profile prefix — which is every concurrent suite's Chrome on
//   this host, not just this run's. Measured 2026-08-05: one run's
//   cleanup SIGKILLed a sibling run's browser mid-probe, and the victim
//   failed for reasons that had nothing to do with its own code.
//
//   Ownership therefore has to be written into the process itself.
//   Every browser a run launches gets its profile under that run's own
//   directory, and only a process carrying that directory in argv is
//   ever a reap candidate. A run can no longer name, let alone kill,
//   another run's browser.

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Every profile this machine's probe browsers use lives under here. */
export const PROBE_BROWSER_ROOT = join(tmpdir(), 'nimbus-probe-chrome');

/**
 * Identity of the suite run this process belongs to. `run-all` mints one
 * and exports it, so every probe it spawns inherits the same id; a probe
 * run on its own is its own run.
 */
export const RUN_ID = process.env.NIMBUS_PROBE_RUN_ID || `run-${process.pid}`;

export function runProfileRoot(runId = RUN_ID) {
  return join(PROBE_BROWSER_ROOT, runId);
}

let allocated = 0;

/** A fresh profile directory, stamped with the owning run. */
export function allocateProfileDir(runId = RUN_ID) {
  const dir = join(runProfileRoot(runId), `${process.pid}-${++allocated}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function releaseProfileDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * One `ps -eo pid=,args=` line → the browser it describes when that
 * browser belongs to `runId`, else null. Keyed on the chrome executable
 * in argv[0] so a shell line that merely mentions the flag is never a
 * candidate, and on the run's own profile root so no other run's browser
 * — and no desktop Chrome — can match.
 */
export function matchRunBrowser(line, runId = RUN_ID) {
  const parsed = line.match(/^\s*(\d+)\s+(\S+)\s*(.*)$/);
  if (!parsed) return null;
  const [, pid, argv0, rest] = parsed;
  if (!/chrome|chromium/i.test(argv0)) return null;
  const profile = `${argv0} ${rest}`.match(/--user-data-dir=(\S+)/)?.[1];
  if (!profile) return null;
  const owned = join(runProfileRoot(runId), '');
  return profile.startsWith(`${owned}/`) ? { pid: Number(pid), profileDir: profile } : null;
}

/** Browsers this run launched that are still alive. */
export function findRunBrowsers(runId = RUN_ID) {
  const res = spawnSync('ps', ['-eo', 'pid=,args='], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.status !== 0 || !res.stdout) return [];
  const found = [];
  for (const line of res.stdout.split('\n')) {
    const hit = matchRunBrowser(line, runId);
    if (hit && hit.pid !== process.pid) found.push(hit);
  }
  return found;
}

/**
 * Kill the browsers this run leaked and drop their profiles. Chrome's
 * renderers carry the same profile in argv, so a leaked browser shows up
 * as several processes and every one of them is killed. Returns the
 * number of processes reaped.
 */
export function reapRunBrowsers(runId = RUN_ID) {
  const orphans = findRunBrowsers(runId);
  for (const { pid } of orphans) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  for (const dir of new Set(orphans.map((o) => o.profileDir))) releaseProfileDir(dir);
  return orphans.length;
}

/** Drop everything this run left under the profile root. */
export function cleanupRunProfiles(runId = RUN_ID) {
  rmSync(runProfileRoot(runId), { recursive: true, force: true });
}
