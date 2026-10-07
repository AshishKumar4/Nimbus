// The container side of one CI shard. The shard's Durable Object
// (apps/ci-runner/src/shard.ts) drives it through `container.exec`, as root:
//
//   receive   stdin is the commit's `git archive` (tar.gz): unpacked into
//             /work/src, owned by the unprivileged `ci` user.
//   timings   stdin is the timings JSON run-all balances shards with.
//   launch    sets up the shard's cgroup and starts `run` detached, so the
//             run outlives the exec that started it. CI_SPEC (JSON) says
//             what to run; CI_SUITE_ENV (JSON) is extra environment for the
//             tests, the Workers secrets the suite reads.
//   status    prints the shard's progress as one JSON line.
//
// `run` installs the commit's dependencies and runs its own
// tests/unit/run-all.mjs on this shard's part, as `ci`: tests that assert a
// permission error behave as on the workstation, where nobody runs as root.
// Each file gets a cgroup of its own under /sys/fs/cgroup/ci
// (NIMBUS_TEST_CGROUP), which is where its CPU time is read and how every
// process it leaves behind is killed.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

const WORK = '/work';
const SRC = `${WORK}/src`;
const OUT = `${WORK}/out`;
const GROUP = '/sys/fs/cgroup/ci';
const CI_UID = 1000;
const CI_HOME = '/home/ci';

const phaseFile = `${OUT}/phase.json`;
const log = `${OUT}/run.log`;

function setPhase(phase, extra = {}) {
  const previous = existsSync(phaseFile) ? JSON.parse(readFileSync(phaseFile, 'utf8')) : {};
  writeFileSync(phaseFile, JSON.stringify({ ...previous, ...extra, phase, [`${phase}At`]: Date.now() }));
}

/** Busy and steal jiffies of the whole VM, from /proc/stat's `cpu` line. */
function vmCpu() {
  const [user, nice, system, idle, iowait, irq, softirq, steal] = readFileSync('/proc/stat', 'utf8').split('\n', 1)[0].trim().split(/\s+/).slice(1).map(Number);
  return { busy: user + nice + system + irq + softirq, steal, idle: idle + iowait, ticks: 100 };
}

function groupCpuUsec(path) {
  return Number(readFileSync(`${path}/cpu.stat`, 'utf8').match(/^usage_usec (\d+)$/m)?.[1] ?? NaN);
}

/** Run one step as `ci`, its output appended to the shard log. */
function step(label, command, args, env, cwd = SRC) {
  appendFileSync(log, `\n── ci ${label}: ${command} ${args.join(' ')}\n`);
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/setpriv', [`--reuid=${CI_UID}`, `--regid=${CI_UID}`, '--init-groups', '--', command, ...args], {
      cwd, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const sink = (chunk) => appendFileSync(log, chunk);
    child.stdout.on('data', sink);
    child.stderr.on('data', sink);
    child.on('close', (code, signal) => resolve({ code, signal }));
    child.on('error', (error) => { appendFileSync(log, `spawn failed: ${error.message}\n`); resolve({ code: null, signal: null }); });
  });
}

async function run() {
  const spec = JSON.parse(process.env.CI_SPEC);
  const suiteEnv = JSON.parse(process.env.CI_SUITE_ENV || '{}');
  const env = {
    ...suiteEnv,
    HOME: CI_HOME, USER: 'ci', LOGNAME: 'ci', SHELL: '/bin/bash', LANG: 'C.UTF-8',
    PATH: `${CI_HOME}/.elan/bin:/usr/local/bin:/usr/bin:/bin`,
    TMPDIR: `${WORK}/tmp`,
    NIMBUS_TEST_CGROUP: GROUP,
    NIMBUS_TEST_MEMORY_MAX: spec.memoryMax,
  };
  const cpu0 = vmCpu();
  const group0 = groupCpuUsec(GROUP);
  // A commit from before run-all could run one shard of the suite gets this
  // image's runner (staged by scripts/deploy.mjs), so CI can grade it too:
  // comparing a failure with an older main is what a lane needs most.
  // Recorded, and printed with the verdict: the runner is not the commit's.
  // Laid over before the repository's commit, so git sees a clean tree.
  const overlay = !readFileSync(`${SRC}/tests/unit/run-all.mjs`, 'utf8').includes("'--shard'");
  if (overlay) cpSync('/opt/ci/runner', SRC, { recursive: true });
  setPhase('overlay', { runnerOverlay: overlay });
  // A repository whose one commit is the archive's tree: tests that ask git
  // about the checkout (ls-files, status, diff) see what a clone would show.
  // -f: a tracked file can match .gitignore.
  setPhase('repository');
  const repository = await step('repository', 'sh', ['-c', 'git init -q -b main && git add -A -f && git commit -q --no-verify -m "$1"', 'sh', `ci: ${spec.commit}`], env);
  if (repository.code !== 0) {
    setPhase('finished', { outcome: 'runner-crashed', error: `creating the repository exited ${repository.code ?? repository.signal}` });
    return;
  }
  setPhase('install');
  const install = await step('install', 'bun', ['install', '--frozen-lockfile'], env);
  if (install.code !== 0) {
    setPhase('finished', { outcome: 'setup-failed', error: `bun install --frozen-lockfile exited ${install.code ?? install.signal}` });
    return;
  }
  setPhase('test');
  const args = ['tests/unit/run-all.mjs', '--tier', spec.tier, '--shard', `${spec.index + 1}/${spec.shards}`,
    '--timings', `${WORK}/timings.json`, '--json', `${OUT}/report.json`, '--jobs', String(spec.jobs), '--timeout', String(spec.timeoutMs)];
  const runEnv = { ...env, ...(spec.only?.length ? { NIMBUS_UNIT_ONLY: spec.only.join(',') } : {}) };
  const tested = await step('test', 'bun', args, runEnv);
  const cpu1 = vmCpu();
  // A report is a verdict only from a run-all that ended as it does on its
  // own: 0 with no failure, 1 with one. A signal, or a code that disagrees
  // with the report, is the runner interrupted: retried, never graded.
  let outcome = 'no-report';
  if (existsSync(`${OUT}/report.json`)) {
    const report = JSON.parse(readFileSync(`${OUT}/report.json`, 'utf8'));
    const consistent = tested.signal === null && (tested.code === 0 ? report.fail === 0 : tested.code === 1 && report.fail > 0);
    outcome = consistent ? 'tested' : 'runner-crashed';
  }
  setPhase('finished', {
    outcome,
    ...(outcome === 'runner-crashed' ? { error: `run-all exited ${tested.code ?? tested.signal} with a report of its own` } : {}),
    exitCode: tested.code, signal: tested.signal,
    vmBusySeconds: (cpu1.busy - cpu0.busy) / cpu0.ticks,
    vmStealSeconds: (cpu1.steal - cpu0.steal) / cpu0.ticks,
    vmIdleSeconds: (cpu1.idle - cpu0.idle) / cpu0.ticks,
    groupCpuSeconds: (groupCpuUsec(GROUP) - group0) / 1e6,
  });
}

function launch() {
  // tmpfs at /tmp and /dev/shm, as on the workstation: du's oracle and find's
  // differential read /dev/shm's semantics (a directory holds no blocks).
  const mounts = [];
  for (const dir of ['/tmp', '/dev/shm']) {
    mkdirSync(dir, { recursive: true });
    const mounted = spawnSync('mount', ['-t', 'tmpfs', '-o', 'mode=1777,size=6g', 'tmpfs', dir], { encoding: 'utf8' });
    if (mounted.status !== 0) mounts.push(`${dir}: ${mounted.stderr.trim()}`);
  }
  mkdirSync(OUT, { recursive: true });
  mkdirSync(`${WORK}/tmp`, { recursive: true });
  spawnSync('chown', ['-R', `${CI_UID}:${CI_UID}`, `${WORK}/tmp`, OUT]);
  // A delegated subtree: `ci` creates a group per file under GROUP and moves
  // the file's process into it, which needs write access to GROUP's
  // cgroup.procs. GROUP itself holds no process (the runner lives in
  // GROUP/runner), so memory can be enabled for its children.
  mkdirSync(`${GROUP}/runner`, { recursive: true });
  writeFileSync(`${GROUP}/cgroup.subtree_control`, '+memory +pids');
  for (const file of ['', '/cgroup.procs', '/cgroup.subtree_control', '/cgroup.threads', '/runner', '/runner/cgroup.procs']) {
    spawnSync('chown', [`${CI_UID}:${CI_UID}`, `${GROUP}${file}`]);
  }
  setPhase('launched', { mountErrors: mounts });
  // The workstation's limit; the container's default soft limit is 1024.
  const child = spawn('/bin/sh', ['-c', `echo $$ > ${GROUP}/runner/cgroup.procs && ulimit -n 1048576 && exec "$@"`, 'sh',
    process.execPath, new URL(import.meta.url).pathname, 'run'], {
    detached: true, stdio: ['ignore', 'ignore', 'ignore'], env: process.env,
  });
  // Who runs the shard: status tells a dead driver from a slow one.
  writeFileSync(`${OUT}/driver.json`, JSON.stringify({ pid: child.pid, start: startTime(child.pid) }));
  child.unref();
}

/** A process's start time (/proc/<pid>/stat field 22), or null once it is gone. */
function startTime(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  } catch { return null; }
}

function status() {
  let phase = existsSync(phaseFile) ? JSON.parse(readFileSync(phaseFile, 'utf8')) : { phase: 'none' };
  // The driver writes `finished` last; gone before that, it was killed.
  if (phase.phase !== 'finished' && existsSync(`${OUT}/driver.json`)) {
    const driver = JSON.parse(readFileSync(`${OUT}/driver.json`, 'utf8'));
    const phaseNow = existsSync(phaseFile) ? JSON.parse(readFileSync(phaseFile, 'utf8')) : phase;
    if (phaseNow.phase !== 'finished' && startTime(driver.pid) !== driver.start) {
      phase = { ...phaseNow, phase: 'finished', outcome: 'runner-crashed', error: `the shard driver (pid ${driver.pid}) died during ${phaseNow.phase}` };
    } else phase = phaseNow;
  }
  let pass = 0;
  let fail = 0;
  if (existsSync(log)) {
    for (const match of readFileSync(log, 'utf8').matchAll(/^\[[^\]]+\] \.\.\. (PASS|FAIL) /gm)) {
      if (match[1] === 'PASS') pass++; else fail++;
    }
  }
  const total = /— (\d+) files? discovered/.exec(existsSync(log) ? readFileSync(log, 'utf8') : '')?.[1];
  // What is running and how much memory is in use: if the container is
  // lost, the last of these is what the run knows about why.
  const running = [];
  for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      const file = argv.find((arg) => arg.startsWith(`${SRC}/tests/unit/`) && arg.endsWith('.mjs'));
      if (!file) continue;
      const rss = Number(/^VmRSS:\s+(\d+) kB/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? 0);
      running.push(`${file.slice(SRC.length + 12)} ${Math.round(rss / 1024)}M`);
    } catch { /* Exited while listed. */ }
  }
  const meminfo = readFileSync('/proc/meminfo', 'utf8');
  const available = Number(/^MemAvailable:\s+(\d+) kB/m.exec(meminfo)?.[1] ?? 0);
  let oomKills = null;
  try { oomKills = Number(/^oom_kill (\d+)$/m.exec(readFileSync(`${GROUP}/memory.events`, 'utf8'))?.[1] ?? 0); } catch { /* Not launched yet. */ }
  process.stdout.write(`${JSON.stringify({
    ...phase, pass, fail, total: total === undefined ? null : Number(total), now: Date.now(),
    running, memAvailableMiB: Math.round(available / 1024), oomKills,
  })}\n`);
}

const command = process.argv[2];
if (command === 'launch') launch();
else if (command === 'run') await run().catch((error) => setPhase('finished', { outcome: 'runner-crashed', error: String(error?.stack ?? error) }));
else if (command === 'status') status();
else if (command === 'timings') writeFileSync(`${WORK}/timings.json`, readFileSync(0));
else {
  process.stderr.write(`usage: shard.mjs launch|run|status|timings\n`);
  process.exit(64);
}
