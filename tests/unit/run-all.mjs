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
// Optional:
//   --timeout MS / NIMBUS_UNIT_TIMEOUT_MS — kill a file's process after
//   MS milliseconds and score it FAIL. Off by default, matching the
//   runner's historical semantics (a unit file runs to completion).

import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
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
  : 0; // 0 = no per-file timeout — the runner's historical semantics.

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

const targets = FILES.filter((name) => {
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

function isSerialMarked(name) {
  const firstLine = readFileSync(join(__dirname, name), 'utf8').split('\n', 1)[0];
  return SERIAL_RE.test(firstLine);
}

const serialFiles = JOBS > 1 ? targets.filter(isSerialMarked) : [];
const pooledFiles = JOBS > 1 ? targets.filter((name) => !serialFiles.includes(name)) : targets;

console.log(
  `unit/run-all — ${targets.length} file${targets.length === 1 ? '' : 's'} discovered`
  + ` (jobs ${JOBS}${serialFiles.length > 0 ? `, ${serialFiles.length} marked @serial` : ''})`,
);

// ── Execution ────────────────────────────────────────────────────────

/** Spawn one test file; collect stdout/stderr/exit. Pure I/O. */
function runOnce(path) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [path], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = TIMEOUT_MS > 0
      ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, TIMEOUT_MS)
      : null;
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const done = (ok, extra) => {
      clearTimeout(timer);
      resolve({
        ok: ok && !timedOut,
        stdout,
        stderr: timedOut ? `${stderr}\nfile exceeded --timeout ${TIMEOUT_MS}ms (SIGKILL)` : stderr,
        elapsedMs: Date.now() - t0,
        ...extra,
      });
    };
    child.on('close', (code) => done(code === 0));
    child.on('error', (e) => done(false, { stderr: String(e?.message || e) }));
  });
}

/** One line per finished file, plus the stderr tail that explains a FAIL. */
function report(name, r) {
  const elapsedS = (r.elapsedMs / 1000).toFixed(1);
  console.log(`[${name}] ... ${r.ok ? 'PASS' : 'FAIL'} (${elapsedS}s)`);
  if (!r.ok) {
    const stderrLines = r.stderr
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l.trim() && !/^Bun v\d+\.\d+\.\d+ \([^)]+\)$/.test(l));
    for (const l of stderrLines.slice(-4)) console.log('    stderr: ' + l);
  }
  return { name, ok: r.ok, elapsed: Number(elapsedS) };
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
  // is claimed by exactly one worker.
  const queue = [...pooledFiles];
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
console.log('');
console.log(`unit/run-all — ${pass} pass / ${fail} fail in ${totalElapsed}s`);
if (fail > 0) {
  for (const r of results.filter((r) => !r.ok).sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  FAIL ${r.name}`);
  }
  process.exit(1);
}
