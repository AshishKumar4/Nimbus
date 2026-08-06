#!/usr/bin/env bun
// behavioral/run-all — run every behavioral probe sequentially, report
// pass/fail summary.
//
// Usage:
//   BASE=http://127.0.0.1:8792 bun tests/behavioral/run-all.mjs
//   BASE=https://nimbus-os.dev bun tests/behavioral/run-all.mjs
//
// Flags:
//   --no-retry     Disable retry-on-banner (CI-strict mode). Default
//                  is retry-once when the spawn crashes with a known
//                  runtime-crash banner.
//   --allow-concurrent
//                  Run even though another suite already holds this
//                  machine's run lock. See "Serialization" below.
//
// Optional env:
//   NIMBUS_PROBE_ONLY   — comma-separated probe names (e.g.
//                         "large-install,honest-install-message") to
//                         restrict the run; useful for quick re-checks.
//                         Match is against the relative path (without
//                         the .mjs extension), so "frameworks/astro-real"
//                         and "astro-real" both work.
//   NIMBUS_PROBE_SKIP   — comma-separated probe names to skip.
//   NIMBUS_RUNNER_NO_RETRY=1  — equivalent of `--no-retry` (CI use).
//
// Discovery: walks `tests/behavioral/` recursively. Skips:
//   - any file whose leaf basename starts with `_` (helpers like
//     `_driver.mjs`, `_runtime-behavioral-template.mjs`, `_fixtures.mjs`,
//     `_keys.mjs`, `_recipe.mjs`, `_diag.mjs`)
//   - any file named `run-all.mjs` (the root runner and the
//     `keybindings/run-all.mjs` sub-runner)
//   - non-`.mjs` files
//
// Retry-on-banner:
//   When a probe spawn exits non-zero AND stderr contains a known
//   runtime-crash banner (currently only `Bun v\d+\.\d+\.\d+ \(...\)`),
//   the runner retries the probe ONCE. The retry verdict is the final
//   verdict; the first crash is logged but not counted as FAIL.
//
//   Rationale: the bun runtime occasionally crashes when running our
//   probes (e.g. heap-correctness/diag-reports-stream-retention is ~40%
//   flaky with this banner). The crash is OUTSIDE the probe's control
//   — it's a hazard at the runtime layer, exactly the class of failure
//   where runner-level retry is correct. The retry happens in the
//   RUNNER (system infrastructure), not in probe assertion logic, per
//   the cleanup-audit CLN-4 charter clarification (network-resilience
//   / concurrency-hazard retries in system infrastructure ARE
//   permitted; agent-controlled assertion paths must not retry).
//
//   `--no-retry` disables this for CI diagnostic runs where the
//   operator wants to see flakes directly.
//
// Orphan-browser reaping:
//   Browser probes launch a real headless Chrome via puppeteer and rely
//   on `browser.close()` in a `finally` to tear it down. A hard runtime
//   crash (the bun panic banner above) kills the probe process WITHOUT
//   running `finally`, so its Chrome is reparented to init and survives.
//   Across a long sequential run these orphans accumulate (each Chrome
//   holds hundreds of MiB), pressuring the host until subsequent probes
//   — and the immediate retry of a crashed probe — crash at startup too.
//   That is why a banner-crashed browser probe can stay FAIL after the
//   retry: the retry inherits the leaked Chrome.
//
//   The runner reaps between probes. Probes run strictly sequentially,
//   so nothing of this run's is in flight at the reap point — but other
//   suites on this host are, which is why the reap is scoped to browsers
//   carrying THIS run's profile directory (`_probe-browser.mjs`) rather
//   than to every headless Chrome on the machine. Reaping is system
//   infrastructure, not assertion logic.
//
// Serialization:
//   Two full suites on one host interfere: they contend for CPU and
//   memory, and each redeploy of a shared target rotates the other's
//   credential out from under it. The runner therefore takes a
//   machine-wide lock and refuses to start while another run holds it,
//   naming the holder so the operator can wait or kill it. A lock whose
//   holder is gone is stale and taken over. `--allow-concurrent` runs
//   anyway, for the deliberate case.

import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, basename } from 'node:path';

import { RUN_ID, cleanupRunProfiles, reapRunBrowsers } from './_probe-browser.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

if (!process.env.BASE) {
  console.error('FATAL: BASE env required (e.g. BASE=http://127.0.0.1:8792)');
  process.exit(2);
}

const NO_RETRY = process.argv.includes('--no-retry')
  || process.env.NIMBUS_RUNNER_NO_RETRY === '1';

const ALLOW_CONCURRENT = process.argv.includes('--allow-concurrent');

// Probes inherit the runner's environment, so exporting the run id is
// what makes every browser they launch identifiable as this run's.
process.env.NIMBUS_PROBE_RUN_ID = RUN_ID;

// ── Run lock ─────────────────────────────────────────────────────────

const LOCK_PATH = join(tmpdir(), 'nimbus-behavioral-run.lock');

function readLock() {
  try {
    return JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function holderIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * Take the machine-wide run lock, or explain who has it and stop. The
 * lock is created exclusively (`wx`), so two runners racing for a free
 * lock cannot both win; a lock whose holder has exited is stale and is
 * removed before the single retry.
 */
function acquireRunLock() {
  const mine = {
    pid: process.pid,
    runId: RUN_ID,
    base: process.env.BASE,
    cwd: process.cwd(),
    startedAt: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(LOCK_PATH, `${JSON.stringify(mine, null, 2)}\n`, { flag: 'wx' });
      process.on('exit', releaseRunLock);
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        process.on(signal, () => process.exit(130));
      }
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const holder = readLock();
    if (holder && holderIsAlive(holder.pid)) {
      const heldFor = Math.round((Date.now() - Date.parse(holder.startedAt)) / 1000);
      console.error(
        `FATAL: another behavioral suite is already running on this machine.\n`
        + `  pid ${holder.pid} — started ${holder.startedAt} (${heldFor}s ago)\n`
        + `  BASE ${holder.base}\n`
        + `  cwd  ${holder.cwd}\n`
        + `Two concurrent suites contend for this host's CPU and memory, and a\n`
        + `redeploy in one rotates the other's credential out from under it.\n`
        + `Wait for it to finish, or pass --allow-concurrent to run anyway.`,
      );
      process.exit(3);
    }
    rmSync(LOCK_PATH, { force: true });
  }
  throw new Error(`could not take the run lock at ${LOCK_PATH}`);
}

function releaseRunLock() {
  if (readLock()?.pid === process.pid) rmSync(LOCK_PATH, { force: true });
}

if (ALLOW_CONCURRENT) {
  const holder = readLock();
  if (holder && holderIsAlive(holder.pid)) {
    console.log(`[--allow-concurrent] running alongside pid ${holder.pid} (BASE=${holder.base})`);
  }
} else {
  acquireRunLock();
}

/**
 * Recursively walk `root`, yielding absolute paths of files whose
 * leaf basename satisfies `predicate`. Directories are walked in
 * sorted order so probe ordering is deterministic across platforms.
 */
function walk(root, predicate, out = []) {
  const entries = readdirSync(root, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const ent of entries) {
    const abs = join(root, ent.name);
    if (ent.isDirectory()) {
      walk(abs, predicate, out);
    } else if (ent.isFile() && predicate(ent.name)) {
      out.push(abs);
    }
  }
  return out;
}

function isProbeFile(leaf) {
  if (!leaf.endsWith('.mjs')) return false;
  if (leaf.startsWith('_')) return false;        // helpers
  if (leaf === 'run-all.mjs') return false;      // root + sub-runners
  return true;
}

const PROBES = walk(__dirname, isProbeFile)
  .map((abs) => relative(__dirname, abs));

const only = (process.env.NIMBUS_PROBE_ONLY || '').split(',').filter(Boolean);
const skip = new Set((process.env.NIMBUS_PROBE_SKIP || '').split(',').filter(Boolean));

function probeName(relPath) {
  // Strip .mjs; keep subdirectory prefix so operator can correlate
  // failures with files. Both forms accepted by NIMBUS_PROBE_ONLY /
  // NIMBUS_PROBE_SKIP: full ("frameworks/astro-real") and leaf ("astro-real").
  return relPath.replace(/\.mjs$/, '');
}

function matchAny(collection, relPath) {
  // collection: Array<string> or Set<string>. Match against either
  // the full relative path ("frameworks/astro-real") or the leaf
  // ("astro-real") so legacy NIMBUS_PROBE_ONLY values keep working.
  const full = probeName(relPath);
  const leaf = basename(relPath).replace(/\.mjs$/, '');
  if (Array.isArray(collection)) {
    return collection.includes(full) || collection.includes(leaf);
  }
  return collection.has(full) || collection.has(leaf);
}

const targets = PROBES.filter((p) => {
  if (only.length > 0 && !matchAny(only, p)) return false;
  if (skip.size > 0 && matchAny(skip, p)) return false;
  return true;
});

console.log(`behavioral/run-all — ${targets.length} probe${targets.length === 1 ? '' : 's'} discovered (recursive)`);
console.log(`BASE=${process.env.BASE}${NO_RETRY ? '  [--no-retry]' : ''}`);
console.log('');

/**
 * Signatures of the runtime ITSELF dying, as opposed to the probe failing.
 * Match → retry once.
 *
 * This used to match `/Bun v\d+\.\d+\.\d+ \([^)]+\)/` — the version banner
 * alone. Bun prints that banner after an ORDINARY uncaught error too, so the
 * classifier matched essentially every failing probe: each one ran twice, and
 * the "FLAKE ... → retry" line replaced its real stderr in the output. That
 * is why a red baseline could accumulate while looking like noise, and it
 * corrupts any historical "flaky" verdict in this repo.
 *
 * Measured 2026-08-05 before narrowing it, so this is not a guess:
 *   - 10 classifier firings across three full-suite runs: 0 carried a panic
 *     marker. 9 of the 10 ended FAIL on the retry; 4 of those were then
 *     root-caused as 100%-reproducible defects.
 *   - `measure-flakes` re-ran four probes 3× each: 12 runs, 0 runtime
 *     crashes, and `npm-bin-explicit-process-exit` failed 3/3 at 32.2/32.3/
 *     32.4s — perfectly deterministic, and labelled FLAKE every time.
 *   - `heap-correctness/diag-reports-stream-retention`, cited above as the
 *     reason retry exists, passed cleanly at 168.8s.
 *
 * A real bun crash names itself; an uncaught error never does. Requiring
 * that name keeps the retry for the hazard it was built for and stops it
 * laundering deterministic failures into flakes.
 */
const RUNTIME_CRASH_PATTERNS = [
  /panic\(/,
  /oh no: Bun has crashed/i,
  /Segmentation fault at address/i,
  /illegal instruction at address/i,
];

function isRetryableCrash(stderr, exitCode) {
  if (exitCode === 0) return false;
  for (const pat of RUNTIME_CRASH_PATTERNS) {
    if (pat.test(stderr)) return true;
  }
  return false;
}

/**
 * Kill any browser THIS run leaked — a crashed probe skips its own
 * teardown. Scoped by profile directory, so a sibling suite's Chrome is
 * never a candidate. Loud: logs when it reaps anything so an operator
 * sees that a crash leaked a browser.
 */
function reapLeakedBrowsers() {
  const reaped = reapRunBrowsers();
  if (reaped > 0) {
    console.log(`    reaped ${reaped} orphaned probe browser process${reaped === 1 ? '' : 'es'} (crashed probe leaked Chrome)`);
  }
  return reaped;
}

/**
 * Spawn one probe; collect stdout/stderr/exit. Returns {ok, code,
 * stdout, stderr, elapsedMs}. Pure I/O — no decision making.
 */
function runProbeOnce(probePath) {
  return new Promise((resolve) => {
    const subT0 = Date.now();
    const child = spawn(process.execPath, [probePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      const elapsedMs = Date.now() - subT0;
      resolve({ ok: code === 0, code, stdout, stderr, elapsedMs });
    });
    child.on('error', (e) => {
      const elapsedMs = Date.now() - subT0;
      resolve({ ok: false, code: 1, stdout: '', stderr: String(e?.message || e), elapsedMs });
    });
  });
}

const results = [];
const t0 = Date.now();

for (const probe of targets) {
  const probePath = join(__dirname, probe);
  process.stdout.write(`[${probe}] ... `);

  let r = await runProbeOnce(probePath);
  let retried = false;

  if (!r.ok && !NO_RETRY && isRetryableCrash(r.stderr, r.code)) {
    // First attempt crashed on a known runtime banner. The crash may
    // have leaked a browser (no `finally` on a hard crash); reap it so
    // the retry starts from a clean process baseline rather than
    // inheriting the resource pressure that caused the crash.
    reapLeakedBrowsers();
    process.stdout.write(`FLAKE (${(r.elapsedMs/1000).toFixed(1)}s) → retry... `);
    retried = true;
    r = await runProbeOnce(probePath);
  }

  const elapsedS = (r.elapsedMs / 1000).toFixed(1);
  console.log(`${r.ok ? 'PASS' : 'FAIL'} (${elapsedS}s)${retried ? ' [retried]' : ''}`);

  if (!r.ok) {
    const lines = r.stdout.split('\n').filter((l) => l.startsWith('  ✗') || l.includes('fail'));
    for (const l of lines.slice(-5)) console.log('    ' + l);
    // The last few lines of a bun stderr are the version banner and blanks,
    // so a naive tail prints "Bun v1.3.1 (Linux x64)" and nothing that says
    // what went wrong. Drop the banner and the empty lines first: for an
    // uncaught error the message and its top frame are what identify the
    // failure, and they sit just above it.
    const stderrLines = r.stderr
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l.trim() && !/^Bun v\d+\.\d+\.\d+ \([^)]+\)$/.test(l));
    if (stderrLines.length > 0) {
      console.log('    stderr: ' + stderrLines.slice(-4).join(' | '));
    }
  }

  results.push({ probe, ok: r.ok, elapsed: Number(elapsedS), retried });

  // Reap any browser the probe leaked (a hard crash bypasses the probe's
  // own teardown). Probes run sequentially, so nothing is in flight here.
  reapLeakedBrowsers();
}

cleanupRunProfiles();

const totalElapsed = ((Date.now() - t0) / 1000).toFixed(1);
const pass = results.filter((r) => r.ok).length;
const fail = results.filter((r) => !r.ok).length;
const retries = results.filter((r) => r.retried).length;

console.log('');
console.log(`──── ${pass} pass / ${fail} fail${retries > 0 ? ` (${retries} retried)` : ''} (total ${totalElapsed}s)`);
if (fail > 0) {
  console.log('FAIL probes:');
  for (const r of results.filter((r) => !r.ok)) {
    console.log(`  - ${r.probe}`);
  }
}
process.exit(fail === 0 ? 0 : 1);
