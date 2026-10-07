#!/usr/bin/env bun
// tests/unit/run-all — parallel unit-test runner.
//
// Discovers every top-level tests/unit/*.mjs (no subdirectories — helpers
// live in tests/unit/lib/ and share the `_` convention), runs each with
// `bun <file>` in a worker pool, prints PASS/FAIL + elapsed as each file
// completes, and exits non-zero if any file failed. There is no BASE and
// no retry: a unit test is hermetic, so a crash or an assertion is the
// same verdict — the file failed.
//
// Concurrency:
//   Each file is still its own `bun` process — only scheduling changed.
//   Default pool width is min(8, os.availableParallelism()); `--jobs N`
//   or NIMBUS_UNIT_JOBS override it and `--serial` forces 1 (the old
//   sequential behavior, in sorted order).
//
//   A file that cannot share the machine with the pool — a fixed port, a
//   shared /tmp path, process-wide env it mutates — opts out with a
//   `// @serial` FIRST-LINE comment. Serial-marked files still run, but
//   after the pool drains, one at a time, so the marker never silences a
//   test; it only moves it.
//
//   Every line below is printed when the file finishes, so order is
//   completion order and shifts run to run; the final summary (counts +
//   sorted FAIL list + total) is stable.
//
// Selection mirrors the behavioral runner:
//   NIMBUS_UNIT_ONLY  — comma-separated names (leaf or path) to run.
//   NIMBUS_UNIT_SKIP  — comma-separated names to skip.
//
// Tiers:
//   A file's leading comment block (its lines up to the first one that is
//   neither blank nor a `//` comment) may hold one marker,
//   `// @tier <name> — <reason>` (the separator may also be `-` or `:`):
//     slow       drives a local workerd, runs at scale or is a long
//                differential; the reason states the measured cost.
//     quiet-cpu  asserts timing that foreign load breaks. Always runs in the
//                serial phase below, like `// @serial`.
//   No marker is the fast tier. `--tier fast|slow|all` / NIMBUS_UNIT_TIER
//   picks which run (default all; slow is every file fast leaves out). An
//   unknown name, a marker without a reason or a second marker is a usage
//   error (exit 2) naming the file, whatever is selected.
//
// Sharding (the CI runner, apps/ci-runner, runs one shard per container):
//   --shard I/N        run the I-th (1-based) of N disjoint parts of the
//                      selection, balanced longest-first by expected time.
//   --timings PATH     JSON `{ files: { "<name>.mjs": { wallMs, cpuMs } } }`
//                      the balance reads. A job slot is taken to be one CPU,
//                      so a pooled file costs the larger of its wall and CPU
//                      time (one running four threads holds four slots'
//                      worth); a file in the serial phase has every CPU and
//                      costs its wall time. A file the timings lack costs the
//                      median.
//   Every shard computes the same partition from the same inputs, so
//   `--shard 3/20 --timings t.json` reproduces CI shard 3 locally.
//
// Reports:
//   --list             print the selection (name, tier, serial) and exit.
//   --json PATH        also write every file's verdict, wall time and CPU
//                      time to PATH, and a failing file's whole output. CPU is the case's whole process tree,
//                      read from its cgroup under run-bounded or
//                      NIMBUS_TEST_CGROUP (null otherwise); outside
//                      run-bounded it also lists the commands the case ran
//                      (seen every 25 ms), e.g. workerd.
//
// Each file runs with its own empty TMPDIR (and TMP, TEMP). A file that
// leaves anything in it FAILs, naming what it left, and the leftovers are
// removed: a test removes what it creates, in finally, on failure too.
//
// Optional:
//   --timeout MS / NIMBUS_UNIT_TIMEOUT_MS — kill a file's process after
//   MS milliseconds and score it FAIL. Default: five minutes per file.
//   Output is capped at 1 MiB per file; exceeding it fails and kills the tree.

import { runBoundedProcess, DEFAULT_TEST_TIMEOUT_MS } from '../../scripts/lib/bounded-process.mjs';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Flags ────────────────────────────────────────────────────────────

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

const DEFAULT_JOBS = Math.max(1, Math.min(8, availableParallelism()));
const JOBS = process.argv.includes('--serial')
  ? 1
  : flagValue('--jobs', 'NIMBUS_UNIT_JOBS') !== undefined
    ? positiveInt(flagValue('--jobs', 'NIMBUS_UNIT_JOBS'), 'unit worker count')
    : DEFAULT_JOBS;

const TIMEOUT_MS = flagValue('--timeout', 'NIMBUS_UNIT_TIMEOUT_MS') !== undefined
  ? positiveInt(flagValue('--timeout', 'NIMBUS_UNIT_TIMEOUT_MS'), 'per-file timeout')
  : DEFAULT_TEST_TIMEOUT_MS;

// ── Discovery ────────────────────────────────────────────────────────

function isUnitFile(leaf) {
  if (!leaf.endsWith('.mjs')) return false;
  if (leaf.startsWith('_')) return false;       // helpers
  if (leaf === 'run-all.mjs') return false;     // the runner itself
  return true;
}

const FILES = readdirSync(__dirname, { withFileTypes: true })
  .filter((ent) => ent.isFile() && isUnitFile(ent.name))
  .map((ent) => ent.name)
  .sort((a, b) => a.localeCompare(b));

const only = (process.env.NIMBUS_UNIT_ONLY || '').split(',').filter(Boolean);
const skip = new Set((process.env.NIMBUS_UNIT_SKIP || '').split(',').filter(Boolean));

function matchAny(collection, name) {
  const leaf = name.replace(/\.mjs$/, '');
  if (Array.isArray(collection)) return collection.includes(name) || collection.includes(leaf);
  return collection.has(name) || collection.has(leaf);
}

const selected = FILES.filter((name) => {
  if (only.length > 0 && !matchAny(only, name)) return false;
  if (skip.size > 0 && matchAny(skip, name)) return false;
  return true;
});


/**
 * A file whose first line is `// @serial` opted out of the pool: it
 * touches something the other files share (a fixed port, a fixed path
 * under the OS temp dir, a process-wide resource). It still runs — last,
 * one at a time. A marker deeper in the file is a comment, not a marker:
 * only line 1 counts, so it is always visible at the top of the file.
 * The marker takes line 1 itself, ahead of any shebang: a shebang
 * anywhere but line 1 is a syntax error, and these files carry no
 * executable bit — every invocation goes through `bun <file>` — so the
 * vestigial shebang is dropped when the marker is added.
 */
const SERIAL_RE = /^\/\/\s*@serial\b/;

const sources = new Map(FILES.map((name) => [name, readFileSync(join(__dirname, name), 'utf8')]));

function isSerialMarked(name) {
  return SERIAL_RE.test(sources.get(name).split('\n', 1)[0]);
}

// ── Tiers ────────────────────────────────────────────────────────────

const TIERS = ['fast', 'slow', 'quiet-cpu'];
const TIER_LINE_RE = /^\/\/\s*@tier\b/;
const TIER_RE = /^\/\/\s*@tier\s+([a-z][a-z-]*?)\s*(?:—|:|\s-)\s*(\S.*)$/;

/** `{ tier, reason }` from a file's leading comment block, or `{ error }`. */
function tierOf(name) {
  const lines = sources.get(name).split('\n');
  const markers = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (i === 0 && line.startsWith('#!')) continue;
    if (line !== '' && !line.startsWith('//')) break;
    if (TIER_LINE_RE.test(line)) markers.push({ line: i + 1, text: line });
  }
  if (markers.length === 0) return { tier: 'fast', reason: '' };
  if (markers.length > 1) return { error: `${markers.length} @tier markers (lines ${markers.map((m) => m.line).join(', ')}); a file has one` };
  const match = TIER_RE.exec(markers[0].text);
  if (!match) return { error: `line ${markers[0].line}: expected \`// @tier <name> — <reason>\`, got ${JSON.stringify(markers[0].text)}` };
  if (match[1] === 'fast' || !TIERS.includes(match[1])) return { error: `line ${markers[0].line}: unknown tier ${JSON.stringify(match[1])}; a marker names one of ${TIERS.slice(1).join(', ')}` };
  return { tier: match[1], reason: match[2] };
}

const tiers = new Map(FILES.map((name) => [name, tierOf(name)]));
const tierErrors = [...tiers].filter(([, t]) => t.error);
if (tierErrors.length > 0) {
  for (const [name, t] of tierErrors) console.error(`FATAL: ${name}: ${t.error}`);
  process.exit(2);
}

const TIER = flagValue('--tier', 'NIMBUS_UNIT_TIER') || 'all';
if (!['fast', 'slow', 'all'].includes(TIER)) {
  console.error(`FATAL: --tier must be fast, slow or all, got ${JSON.stringify(TIER)}`);
  process.exit(2);
}

/** In the serial phase: `// @serial`, or a quiet-cpu file. */
const runsAlone = (name) => isSerialMarked(name) || tiers.get(name).tier === 'quiet-cpu';

const tiered = selected.filter((name) => TIER === 'all'
  || (TIER === 'fast') === (tiers.get(name).tier === 'fast'));

// ── Shards ───────────────────────────────────────────────────────────

const SHARD = flagValue('--shard', 'NIMBUS_UNIT_SHARD') || undefined;
const TIMINGS = flagValue('--timings', 'NIMBUS_UNIT_TIMINGS') || undefined;

/**
 * The I-th of N parts of `names`, longest first: each file joins the part
 * whose expected finish it moves least. A part's expected time is its pool
 * (the larger of total/jobs and its longest file) plus its serial files
 * one after another. Ties go to the lower part and names break ties in
 * order, so every shard computes the same partition from the same inputs.
 */
function shardOf(names, index, count, expectedMs) {
  const parts = Array.from({ length: count }, () => ({ pool: 0, longest: 0, serial: 0, names: [] }));
  const finish = (p) => Math.max(p.pool / JOBS, p.longest) + p.serial;
  const order = [...names].sort((a, b) => expectedMs(b) - expectedMs(a) || a.localeCompare(b));
  for (const name of order) {
    const ms = expectedMs(name);
    const alone = runsAlone(name);
    let best = 0;
    let bestFinish = Infinity;
    for (let i = 0; i < count; i++) {
      const p = parts[i];
      const after = alone ? finish(p) + ms : Math.max((p.pool + ms) / JOBS, p.longest, ms) + p.serial;
      if (after < bestFinish) { best = i; bestFinish = after; }
    }
    const p = parts[best];
    if (alone) p.serial += ms; else { p.pool += ms; p.longest = Math.max(p.longest, ms); }
    p.names.push(name);
  }
  return { names: new Set(parts[index].names), expectedMs: Math.round(finish(parts[index])) };
}

let known = null;
if (TIMINGS !== undefined) {
  try { known = JSON.parse(readFileSync(TIMINGS, 'utf8')).files ?? {}; } catch (error) {
    console.error(`FATAL: --timings ${TIMINGS}: ${error.message}`);
    process.exit(2);
  }
}
/**
 * Expected cost from --timings: max(wall, CPU) in the pool, wall alone in
 * the serial phase, where a file has every CPU. A file it lacks costs the
 * median.
 */
const expectedOf = known && (() => {
  const cost = (name) => (runsAlone(name) ? known[name]?.wallMs || 0 : Math.max(known[name]?.wallMs || 0, known[name]?.cpuMs || 0));
  const measured = tiered.map(cost).filter((ms) => Number.isFinite(ms) && ms > 0).sort((a, b) => a - b);
  const median = measured.length > 0 ? measured[Math.floor(measured.length / 2)] : 1000;
  return (name) => (Number.isFinite(cost(name)) && cost(name) > 0 ? cost(name) : median);
})();

let shard = null;
let targets = tiered;
if (SHARD !== undefined) {
  const match = /^(\d+)\/(\d+)$/.exec(SHARD);
  const [index, count] = match ? [Number(match[1]), Number(match[2])] : [0, 0];
  if (!(count >= 1 && index >= 1 && index <= count)) {
    console.error(`FATAL: --shard must be I/N with 1 <= I <= N, got ${JSON.stringify(SHARD)}`);
    process.exit(2);
  }
  const part = shardOf(tiered, index - 1, count, expectedOf ?? (() => 1000));
  targets = tiered.filter((name) => part.names.has(name));
  shard = { index, count, expectedMs: part.expectedMs, universe: tiered };
}

const serialFiles = JOBS > 1 ? targets.filter(runsAlone) : [];
const pooledFiles = JOBS > 1 ? targets.filter((name) => !serialFiles.includes(name)) : targets;

if (process.argv.includes('--list')) {
  for (const name of targets) console.log(`${name}\t${tiers.get(name).tier}\t${runsAlone(name) ? 'serial' : 'pool'}`);
  process.exit(0);
}

console.log(
  `unit/run-all — ${targets.length} file${targets.length === 1 ? '' : 's'} discovered`
  + ` (jobs ${JOBS}${serialFiles.length > 0 ? `, ${serialFiles.length} run alone` : ''})`,
);
if (TIER !== 'all' || shard) {
  console.log(`unit/run-all — tier ${TIER}${shard ? `, shard ${shard.index}/${shard.count} of ${shard.universe.length} (expected ${(shard.expectedMs / 1000).toFixed(0)}s)` : ''}`);
}
console.log(process.env.NIMBUS_TEST_PID_ISOLATION === '1'
  ? 'unit/run-all — isolation: per-case cgroup + PID namespace'
  : process.env.NIMBUS_TEST_CGROUP
    ? `unit/run-all — isolation: per-case cgroup under ${process.env.NIMBUS_TEST_CGROUP}`
    : 'unit/run-all — isolation: portable cleanup only; use /mnt/scratch/nimbus/run-bounded for local verification');

// ── Execution ────────────────────────────────────────────────────────

// Every file runs with its own empty TMPDIR under this run's. Whatever it
// leaves there (a temp directory it did not remove, on success or failure)
// fails the file and is removed, so a leak is caught where it happens and
// cannot regrow in the shared TMPDIR.
const RUN_TMP = mkdtempSync(join(tmpdir(), 'nimbus-unit-run-'));
process.on('exit', () => rmSync(RUN_TMP, { recursive: true, force: true }));
let tmpSerial = 0;

/** Spawn one test file; collect stdout/stderr/exit. Pure I/O. */
async function runOnce(path) {
  const t0 = Date.now();
  const ownTmp = join(RUN_TMP, `${String(++tmpSerial).padStart(4, '0')}-${basename(path, '.mjs')}`);
  mkdirSync(ownTmp);
  const result = await runBoundedProcess(process.execPath, [path], {
    name: basename(path), timeoutMs: TIMEOUT_MS,
    env: { ...process.env, TMPDIR: ownTmp, TMP: ownTmp, TEMP: ownTmp },
  });
  let left = [];
  // node-compile-cache is Node's own module compile cache, not a test's leak.
  try { left = readdirSync(ownTmp).filter((name) => name !== 'node-compile-cache').sort(); } catch { /* Removed by the test itself. */ }
  rmSync(ownTmp, { recursive: true, force: true });
  const leak = left.length > 0
    ? `\nleft in TMPDIR (a test must remove what it creates, in finally): ${left.slice(0, 8).join(', ')}${left.length > 8 ? `, and ${left.length - 8} more` : ''}`
    : '';
  return {
    ok: result.ok && !leak,
    stdout: result.stdout,
    reason: result.reason || (!result.ok ? `exit code=${result.code} signal=${result.signal ?? 'none'}` : ''),
    stderr: result.stderr + leak,
    elapsedMs: Date.now() - t0,
    cpuMs: result.cpuMs ?? null,
    memoryPeakBytes: result.memoryPeakBytes ?? null,
    commands: result.commands ?? [],
    launchError: result.launchError,
  };
}

/** One line per finished file, plus the stderr tail that explains a FAIL. */
function report(name, r) {
  const elapsedS = (r.elapsedMs / 1000).toFixed(1);
  console.log(`[${name}] ... ${r.ok ? 'PASS' : 'FAIL'} (${elapsedS}s)`);
  if (!r.ok) {
    if (r.reason) console.log(`    ${name}: ${r.reason}`);
    for (const line of r.stdout.split('\n').filter(Boolean).slice(-4)) console.log(`    stdout: ${line.slice(-2048)}`);
    const stderrLines = r.stderr
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l.trim() && !/^Bun v\d+\.\d+\.\d+ \([^)]+\)$/.test(l));
    for (const l of stderrLines.slice(-4)) console.log('    stderr: ' + l.slice(-2048));
  }
  return {
    name, ok: r.ok, elapsed: Number(elapsedS),
    tier: tiers.get(name).tier, serial: runsAlone(name),
    wallMs: r.elapsedMs, cpuMs: r.cpuMs, memoryPeakBytes: r.memoryPeakBytes, commands: r.commands,
    // The isolation could not start the file: no test ran, and a CI runner
    // grades the run as an infrastructure error, not a test failure.
    ...(r.launchError ? { launchError: r.launchError } : {}),
    // A failing file's whole output (bounded-process keeps up to 1 MiB of
    // each stream): the four lines above rarely say which scenario failed.
    ...(r.ok ? {} : { reason: r.reason, stdoutTail: r.stdout.slice(-4096), stderrTail: r.stderr.slice(-4096), stdout: r.stdout, stderr: r.stderr }),
  };
}

const results = [];
const t0 = Date.now();

if (JOBS === 1) {
  // --serial / --jobs 1: the historical behavior — sorted order, one at a
  // time. The @serial marker is a parallelism concept and does not apply.
  for (const name of pooledFiles) {
    results.push(report(name, await runOnce(join(__dirname, name))));
  }
} else {
  // Worker pool: `queue.shift()` is atomic between awaits, so each file
  // is claimed by exactly one worker. With timings, longest first, so the
  // pool does not end on one long file.
  const queue = [...pooledFiles];
  if (expectedOf) queue.sort((a, b) => expectedOf(b) - expectedOf(a) || a.localeCompare(b));
  await Promise.all(
    Array.from({ length: Math.min(JOBS, queue.length) }, async () => {
      while (queue.length > 0) {
        const name = queue.shift();
        results.push(report(name, await runOnce(join(__dirname, name))));
      }
    }),
  );
  // Files that opted out of the pool run now, one at a time, with nothing
  // else of this suite in flight.
  for (const name of serialFiles) {
    results.push(report(name, await runOnce(join(__dirname, name))));
  }
}

const totalElapsed = ((Date.now() - t0) / 1000).toFixed(1);
const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
const JSON_PATH = flagValue('--json', 'NIMBUS_UNIT_JSON') || undefined;
if (JSON_PATH !== undefined) {
  writeFileSync(JSON_PATH, `${JSON.stringify({
    version: 1, tier: TIER, jobs: JOBS, timeoutMs: TIMEOUT_MS,
    isolation: process.env.NIMBUS_TEST_PID_ISOLATION === '1' ? 'systemd' : process.env.NIMBUS_TEST_CGROUP ? 'cgroup' : 'portable',
    shard, elapsedMs: Date.now() - t0, pass, fail,
    files: results.map(({ elapsed, ...r }) => r),
  }, null, 1)}\n`);
}
console.log('');
console.log(`unit/run-all — ${pass} pass / ${fail} fail in ${totalElapsed}s`);
if (fail > 0) {
  for (const r of results.filter((r) => !r.ok).sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  FAIL ${r.name}`);
  }
  process.exit(process.exitCode || 1);
}
