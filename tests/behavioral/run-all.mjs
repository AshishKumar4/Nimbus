#!/usr/bin/env bun
// behavioral/run-all — run every behavioral probe in a pool of workers,
// report a pass/fail summary.
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
//   --jobs N       Run N probes concurrently (default 16,
//                  NIMBUS_PROBE_JOBS overrides). Each probe mints its own
//                  session and owns its own browsers, so probes are
//                  independent. `--jobs 1` runs them one at a time.
//   --ledger PATH  Keep the run's session ledger (every session a probe
//                  minted, when, and its DELETE) at PATH, pass or fail
//                  (NIMBUS_PROBE_LEDGER_KEEP overrides). Without it the
//                  ledger is a temporary file, kept only when a session
//                  leaked. Keep it next to the run's log: a session that
//                  reset is looked up in Workers Logs by its session.
//   --part K/N     Run only the K-th of N parts of the selection (1-based;
//                  every N-th probe, from the K-th), so N runs together
//                  cover it once (scripts/ci/probes.mjs).
//   --json PATH    Also write the verdict as JSON at PATH: each probe's
//                  exit code, seconds and output tail, and the sessions.
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

import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, basename, resolve as resolvePath } from 'node:path';

import { RUN_ID, cleanupRunProfiles, reapRunBrowsers } from './_probe-browser.mjs';
import { sessionOutcomes } from './_ledger.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

if (!process.env.BASE) {
  console.error('FATAL: BASE env required (e.g. BASE=http://127.0.0.1:8792)');
  process.exit(2);
}

const NO_RETRY = process.argv.includes('--no-retry')
  || process.env.NIMBUS_RUNNER_NO_RETRY === '1';

const ALLOW_CONCURRENT = process.argv.includes('--allow-concurrent');

// ── Concurrency ────────────────────────────────────────────────────

function flagValue(flag, envName) {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0) return process.argv[idx + 1];
  const inline = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  return process.env[envName];
}

function positiveInt(raw, what) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`FATAL: ${what} must be a positive integer, got ${JSON.stringify(raw)}`);
    process.exit(2);
  }
  return n;
}

// Each probe mints its own session and owns its own browsers, so every
// probe runs in the pool. Most of a probe's time is spent waiting on the
// target, so the pool is wide: past 16 the longest single probe (~7 min,
// measured 2026-09-30) is what bounds a run, not the pool.
const JOBS = flagValue('--jobs', 'NIMBUS_PROBE_JOBS') !== undefined
  ? positiveInt(flagValue('--jobs', 'NIMBUS_PROBE_JOBS'), 'probe worker count')
  : 16;

// Each probe gets a browser scope inside this run's (runProbeOnce), so
// every browser it launches is identifiable as this run's and as its own.

// _driver.mjs appends each session a probe mints, and each DELETE of it, here.
// It is made only once this run holds the run lock and the ledger's own
// (below): a run refused either never touches a ledger another run writes.
// Without --ledger it is a file of this run's own, named so no other run's
// can be (RUN_ID is pid-derived, and runs in PID namespaces share pids).
const KEEP_LEDGER = flagValue('--ledger', 'NIMBUS_PROBE_LEDGER_KEEP');
const JSON_REPORT = flagValue('--json');
const PART = (() => {
  const raw = flagValue('--part');
  if (raw === undefined) return null;
  const [k, n] = raw.split('/').map(Number);
  if (!(Number.isInteger(k) && Number.isInteger(n) && k >= 1 && k <= n)) {
    console.error(`FATAL: --part must be K/N with 1 <= K <= N, got ${JSON.stringify(raw)}`);
    process.exit(2);
  }
  return { k, n };
})();
const LEDGER_PATH = KEEP_LEDGER ? resolvePath(KEEP_LEDGER) : join(tmpdir(), `nimbus-probe-ledger-${RUN_ID}-${randomUUID()}.jsonl`);

// ── Run lock ─────────────────────────────────────────────────────────

// The lock is an exclusive SQLite lock on HOLD_PATH, held for the run's
// life: the kernel drops it when the run ends, however it ends. LOCK_PATH
// only describes the holder. A pid cannot say whether a holder lives: a
// run in a PID namespace of its own records a pid that, read outside it,
// names some other process (a run killed at its timeout on 2026-09-30 left
// "pid 12", which blocked every later suite).
const LOCK_PATH = join(tmpdir(), 'nimbus-behavioral-run.lock');
const HOLD_PATH = `${LOCK_PATH}.sqlite`;

/** The open database whose transaction is the lock, while this run holds it. */
let held = null;

function readLock() {
  try {
    return JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
  } catch {
    return null;
  }
}

/** Take the lock held in `path`, or null when another process holds it. */
function tryHold(path = HOLD_PATH) {
  const db = new Database(path, { create: true });
  try {
    db.exec('BEGIN EXCLUSIVE');
    return db;
  } catch (error) {
    db.close();
    if (/database is locked/i.test(String(error?.message))) return null;
    throw error;
  }
}

/** Whether another suite holds the lock now. Takes and drops it to find out. */
function heldElsewhere() {
  const db = tryHold();
  if (db === null) return true;
  db.close();
  return false;
}

/**
 * Take the machine-wide run lock, or explain who has it and stop. A run
 * killed before it could release it leaves only its description behind,
 * which the next run overwrites.
 */
function acquireRunLock() {
  held = tryHold();
  if (held === null) {
    const holder = readLock();
    const heldFor = holder ? Math.round((Date.now() - Date.parse(holder.startedAt)) / 1000) : null;
    console.error(
      `FATAL: another behavioral suite is already running on this machine.\n`
      + (holder
        ? `  pid ${holder.pid} — started ${holder.startedAt} (${heldFor}s ago)\n`
          + `  BASE ${holder.base}\n`
          + `  cwd  ${holder.cwd}\n`
        : `  (its description at ${LOCK_PATH} is missing)\n`)
      + `Two concurrent suites contend for this host's CPU and memory, and a\n`
      + `redeploy in one rotates the other's credential out from under it.\n`
      + `Wait for it to finish, or pass --allow-concurrent to run anyway.`,
    );
    process.exit(3);
  }
  const mine = {
    pid: process.pid,
    runId: RUN_ID,
    base: process.env.BASE,
    cwd: process.cwd(),
    startedAt: new Date().toISOString(),
  };
  writeFileSync(LOCK_PATH, `${JSON.stringify(mine, null, 2)}\n`);
  process.on('exit', releaseRunLock);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => process.exit(130));
  }
}

function releaseRunLock() {
  rmSync(LOCK_PATH, { force: true });
  held?.close();
  held = null;
}

if (ALLOW_CONCURRENT) {
  const holder = heldElsewhere() ? readLock() : null;
  if (holder) {
    console.log(`[--allow-concurrent] running alongside pid ${holder.pid} (BASE=${holder.base})`);
  }
} else {
  acquireRunLock();
}

// ── Session ledger ───────────────────────────────────────────────────

// A kept ledger is one run's. Its lock is an exclusive SQLite lock in a
// file beside it, held for the run's life whatever the run lock
// (--allow-concurrent runs alongside another): a second run given the same
// --ledger path refuses before it touches the file, where it would have
// emptied the leaks the first run recorded. The lock file stays when the
// run ends, as HOLD_PATH does. Removed, a run waiting on it would lock the
// removed file while the next run made and locked a new one at the path:
// two runs writing one ledger.
if (KEEP_LEDGER) {
  const ledgerHeld = tryHold(`${LEDGER_PATH}.lock`);
  if (ledgerHeld === null) {
    console.error(
      `FATAL: another behavioral run is writing its session ledger at ${LEDGER_PATH}.\n`
      + `Give this run a --ledger path of its own.`,
    );
    process.exit(3);
  }
  process.on('exit', () => ledgerHeld.close());
  writeFileSync(LEDGER_PATH, ''); // this run's, kept even when no probe mints
}
process.env.NIMBUS_PROBE_LEDGER = LEDGER_PATH;

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

// A name may be given as its file, with `.mjs` or a `tests/behavioral/` prefix.
const names = (list) => (list || '').split(',').filter(Boolean).map((name) => name.replace(/^(\.\/)?(tests\/behavioral\/)?/, '').replace(/\.mjs$/, ''));
const only = names(process.env.NIMBUS_PROBE_ONLY);
const skip = new Set(names(process.env.NIMBUS_PROBE_SKIP));

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

const selected = PROBES.filter((p) => {
  if (only.length > 0 && !matchAny(only, p)) return false;
  if (skip.size > 0 && matchAny(skip, p)) return false;
  return true;
});
// A selection that names probes and finds none ran nothing: never a pass.
const unmatched = only.filter((name) => !PROBES.some((p) => matchAny([name], p)));
if (unmatched.length > 0) {
  console.error(`FATAL: NIMBUS_PROBE_ONLY names no probe for: ${unmatched.join(', ')} (a name is a path under tests/behavioral, with or without .mjs, or a file's own name)`);
  process.exit(2);
}
const targets = selected.filter((_, i) => PART === null || i % PART.n === PART.k - 1);

console.log(`behavioral/run-all — ${targets.length} probe${targets.length === 1 ? '' : 's'} discovered (recursive) (jobs ${JOBS})${PART ? ` (part ${PART.k}/${PART.n})` : ''}`);
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
 * Kill the browsers a probe leaked: a crashed probe skips its own
 * teardown. Each probe owns a browser scope of its own inside this run's
 * (see runProbeOnce), so reaping it once the probe has exited can never
 * touch a sibling still in flight, nor another suite's Chrome. Loud: logs
 * when it reaps anything so an operator sees that a crash leaked a
 * browser.
 */
function reapLeakedBrowsers(scope) {
  const reaped = reapRunBrowsers(scope);
  if (reaped > 0) {
    console.log(`    reaped ${reaped} orphaned probe browser process${reaped === 1 ? '' : 'es'} (crashed probe leaked Chrome)`);
  }
  return reaped;
}

let attempts = 0;

/**
 * Spawn one probe attempt in a browser scope of its own; collect
 * stdout/stderr/exit, then reap whatever browser it left. Returns {ok,
 * code, stdout, stderr, elapsedMs}.
 */
function runProbeOnce(probePath) {
  const scope = `${RUN_ID}/${++attempts}`;
  return new Promise((resolve) => {
    const subT0 = Date.now();
    const child = spawn(process.execPath, [probePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NIMBUS_PROBE_RUN_ID: scope },
    });
    let stdout = '';
    let stderr = '';
    const done = (r) => {
      reapLeakedBrowsers(scope);
      resolve({ ...r, elapsedMs: Date.now() - subT0 });
    };
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => done({ ok: code === 0, code, stdout, stderr }));
    child.on('error', (e) => done({ ok: false, code: 1, stdout: '', stderr: String(e?.message || e) }));
  });
}

/**
 * Run one probe to a verdict, retrying once on a runtime crash banner
 * when retries are enabled.
 */
async function runProbeToVerdict(probePath) {
  let r = await runProbeOnce(probePath);
  let retried = false;
  if (!r.ok && !NO_RETRY && isRetryableCrash(r.stderr, r.code)) {
    retried = true;
    r = await runProbeOnce(probePath);
  }
  return { ...r, retried };
}

/**
 * One finished probe, one line, plus the failure tails that explain a
 * FAIL. Emitted atomically at completion (completion order), so pool
 * workers never interleave a line. The old runner split the line around
 * the run (`[probe] ... ` then `PASS`); the finished line reads the
 * same, only printed whole.
 */
function reportProbe(probe, r) {
  const elapsedS = (r.elapsedMs / 1000).toFixed(1);
  console.log(`[${probe}] ... ${r.ok ? 'PASS' : 'FAIL'} (${elapsedS}s)${r.retried ? ' [retried]' : ''}`);
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
  // The JSON verdict keeps each probe's output tail, stdout then stderr.
  const output = JSON_REPORT ? `${r.stdout.slice(-OUTPUT_TAIL)}${r.stderr ? `\n── stderr\n${r.stderr.slice(-OUTPUT_TAIL)}` : ''}` : undefined;
  return { probe, ok: r.ok, code: r.code, elapsed: Number(elapsedS), retried: r.retried, output };
}

/** Bytes of each stream a JSON verdict keeps per probe. */
const OUTPUT_TAIL = 64 * 1024;

const results = [];
const t0 = Date.now();

// Worker pool: `queue.shift()` is atomic between awaits, so each probe is
// claimed by exactly one worker.
const queue = [...targets];
await Promise.all(
  Array.from({ length: Math.min(JOBS, queue.length) }, async () => {
    while (queue.length > 0) {
      const probe = queue.shift();
      results.push(reportProbe(probe, await runProbeToVerdict(join(__dirname, probe))));
    }
  }),
);

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

let ledgerText = '';
try { ledgerText = readFileSync(LEDGER_PATH, 'utf8'); } catch { /* no probe minted a session */ }
const { deleted, byExitHook, leaks, ttlReaped } = sessionOutcomes(ledgerText);
console.log(`──── sessions: ${deleted + leaks.length + ttlReaped.length} minted, ${deleted} deleted (${byExitHook} by the driver's exit hook)`
  + (ttlReaped.length ? `, ${ttlReaped.length} anonymous left to the demo's TTL` : ''));
for (const [sid, s] of ttlReaped) console.log(`  ttl-reaped: ${s.probe}: ${sid} (DELETE: ${s.last})`);
if (leaks.length > 0) {
  console.log(`SESSION LEAKS: ${leaks.length} minted session${leaks.length === 1 ? '' : 's'} never got a 2xx DELETE (ledger: ${LEDGER_PATH})`);
  for (const [sid, s] of leaks) console.log(`  - ${s.probe}: ${sid} (last DELETE: ${s.last})`);
} else if (!KEEP_LEDGER) {
  rmSync(LEDGER_PATH, { force: true });
}
if (KEEP_LEDGER) console.log(`session ledger: ${LEDGER_PATH}`);
if (JSON_REPORT) {
  writeFileSync(JSON_REPORT, `${JSON.stringify({
    base: process.env.BASE,
    part: PART ? `${PART.k}/${PART.n}` : null,
    probes: results,
    sessions: { minted: deleted + leaks.length + ttlReaped.length, deleted, leaks: leaks.map(([sid, s]) => ({ sid, probe: s.probe, last: s.last })) },
  })}\n`);
}
process.exit(fail === 0 && leaks.length === 0 ? 0 : 1);
