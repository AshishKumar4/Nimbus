#!/usr/bin/env bun
// The unit suite on armada (https://github.com/AshishKumar4/armada).
// `armada run <commit>` reads the commit's .armada.json, starts containers
// from the environment scripts/armada/setup.sh and install.sh prepare, runs
// `plan` once, then `task` once for each part the plan prints. Each
// standard-4 container pulls part after part from one queue, longest first.
//
//   unit.mjs plan --target S --timings FILE [--tier fast|slow|all] [--only a.mjs,b.mjs]
//     Prints the matrix: run-all's selection (`armada run <commit> -- --tier
//     fast` narrows it) cut into parts of about S
//     seconds each, at JOBS files at a time (tests/unit/lib/partition.mjs),
//     from armada's medians in FILE (`{"files": {"<name>.mjs": seconds}}`).
//     A part's rows are its files; its weight orders the queue. With no
//     medians yet, the suite is cut by file count into FIRST_PARTS parts:
//     that run is the one that measures.
//   unit.mjs task PART --timings FILE --out OUT
//     Runs the part's files through tests/unit/run-all.mjs and writes
//     armada's verdict to OUT: a row per file, with its wall time, its whole
//     output when it failed, and its cost (partition.mjs) as the timing the
//     next plan reads. A run-all that did not end as itself (a signal, no
//     report, an exit code its report contradicts) or a file that never
//     started writes no verdict, so the run is not graded: never a test
//     verdict. The part's log ends with the VM's busy and steal CPU seconds
//     while it ran, from /proc/stat: what the VM's CPU bill counts, and how
//     much of it a busy host took.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { costMs, expectedCosts, partition } from '../../tests/unit/lib/partition.mjs';

const RUN_ALL = fileURLToPath(new URL('../../tests/unit/run-all.mjs', import.meta.url));
/** Files at a time: a standard-4 container's vCPUs. */
const JOBS = 4;
/** Parts while nothing is measured: as many as apps/ci-runner gave its first run. */
const FIRST_PARTS = 16;
/**
 * A file's limit: three times run-all's local five minutes. A container's
 * vCPU is about 1.5x slower than a workstation core (the same files alone:
 * 55.6 s against 37.1 s, 34.7 s against 21.6 s), and a threaded file gets
 * 4 of them, not 24: interpreter-test262 took 315-641 s alone on one.
 */
const FILE_TIMEOUT_MS = 900_000;

const [mode, ...args] = process.argv.slice(2);
const optional = (name) => {
  const at = args.indexOf(name);
  if (at >= 0 && args[at + 1] === undefined) usage(`${name} needs a value`);
  return at < 0 ? undefined : args[at + 1];
};
const option = (name) => optional(name) ?? usage(`${name} needs a value`);

/** @returns {never} */
function usage(message) {
  console.error(`unit.mjs: ${message}\nusage: unit.mjs plan --target S --timings FILE [--tier T] [--only a,b] | unit.mjs task PART --timings FILE --out OUT`);
  process.exit(2);
}

/** armada's medians (seconds of cost) as run-all's `--timings` (`{ wallMs }`). */
function measured(file) {
  const { files } = JSON.parse(readFileSync(file, 'utf8'));
  return Object.fromEntries(Object.entries(files).map(([name, seconds]) => [name, { wallMs: seconds * 1000 }]));
}

function plan() {
  const target = Number(option('--target'));
  const known = measured(option('--timings'));
  const only = optional('--only');
  const listed = spawnSync(process.execPath, [RUN_ALL, '--list', '--tier', optional('--tier') ?? 'all'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, ...(only === undefined ? {} : { NIMBUS_UNIT_ONLY: only }) },
  });
  if (listed.status !== 0) {
    console.error(`unit.mjs: run-all --list exited ${listed.status ?? listed.signal}`);
    process.exit(2);
  }
  const files = listed.stdout.split('\n').filter(Boolean).map((line) => line.split('\t'));
  if (files.length === 0) usage('the selection is empty');
  const names = files.map(([name]) => name);
  const alone = new Set(files.filter(([, , phase]) => phase === 'serial').map(([name]) => name));
  const runsAlone = (name) => alone.has(name);
  const expectedMs = expectedCosts(names, known, runsAlone);
  const totalMs = names.reduce((sum, name) => sum + expectedMs(name) / (runsAlone(name) ? 1 : JOBS), 0);
  const count = names.some((name) => known[name]) ? Math.ceil(totalMs / (target * 1000)) : FIRST_PARTS;
  const parts = partition(names, Math.max(1, Math.min(names.length, count)), { expectedMs, runsAlone, jobs: JOBS });
  console.log(JSON.stringify({
    include: parts.filter((part) => part.names.length > 0).map((part, index) => ({
      name: `part-${index + 1}`,
      weight: part.expectedMs / 1000,
      rows: part.names.map((name) => ({ name, files: [name] })),
    })),
  }));
}

/** Busy and steal seconds of the whole VM so far, from /proc/stat's `cpu` line (USER_HZ is 100 on Linux). */
function vmCpu() {
  const [user, nice, system, , , irq, softirq, steal] = readFileSync('/proc/stat', 'utf8').split('\n', 1)[0].trim().split(/\s+/).slice(1).map(Number);
  return { busy: (user + nice + system + irq + softirq) / 100, steal: steal / 100 };
}

/** A failing file's whole output, the reason last: armada prints a red row's last lines. */
function failure({ stdout, stderr, reason }) {
  return `── stdout\n${stdout ?? ''}\n── stderr\n${stderr ?? ''}\n── ${reason}`;
}

function task() {
  const part = JSON.parse(args[0] ?? usage('a part'));
  const out = option('--out');
  const scratch = mkdtempSync(join(tmpdir(), 'armada-part-'));
  try {
    const timings = join(scratch, 'timings.json');
    const reportPath = join(scratch, 'report.json');
    writeFileSync(timings, JSON.stringify({ files: measured(option('--timings')) }));
    const cpu0 = vmCpu();
    // The open-file limit as high as the user may raise it: a container's soft
    // limit is 1024, the workstation's 1048576.
    const ran = spawnSync('/bin/sh', ['-c', 'ulimit -n "$(ulimit -Hn)" && exec "$@"', 'run-all',
      process.execPath, RUN_ALL, '--jobs', String(JOBS), '--timeout', String(FILE_TIMEOUT_MS), '--timings', timings, '--json', reportPath], {
      stdio: 'inherit', env: { ...process.env, NIMBUS_UNIT_ONLY: part.rows.map((row) => row.name).join(',') },
    });
    const cpu1 = vmCpu();
    console.log(`unit.mjs: VM busy ${(cpu1.busy - cpu0.busy).toFixed(1)} s, steal ${(cpu1.steal - cpu0.steal).toFixed(1)} s`);
    const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null;
    const ended = report !== null && ran.signal === null && (ran.status === 0 ? report.fail === 0 : ran.status === 1 && report.fail > 0);
    if (!ended) {
      console.error(`unit.mjs: run-all exited ${ran.status ?? ran.signal} ${report === null ? 'with no report' : `with ${report.fail} failures in its report`}: not a test verdict`);
      return 2;
    }
    const unstarted = report.files.filter((file) => file.launchError);
    for (const file of unstarted) console.error(`unit.mjs: ${file.name} never started: ${file.launchError}`);
    if (unstarted.length > 0) return 2;
    writeFileSync(out, JSON.stringify({
      rows: report.files.map(({ name, ok, wallMs, reason, stdout, stderr, stdoutTail, stderrTail, ...file }) => ({
        name, exitCode: ok ? 0 : 1, seconds: wallMs / 1000, output: ok ? '' : failure({ stdout, stderr, reason }),
        timings: { [name]: costMs({ wallMs, cpuMs: file.cpuMs }, file.serial) / 1000 }, ...file,
      })),
    }));
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (mode === 'plan') plan();
else if (mode === 'task') process.exit(task());
else usage(`unknown mode ${JSON.stringify(mode)}`);
