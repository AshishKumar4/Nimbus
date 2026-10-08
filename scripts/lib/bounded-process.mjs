import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, accessSync, constants, mkdirSync, rmdirSync, statSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

export const DEFAULT_TEST_TIMEOUT_MS = 300_000;
const active = new Set();

// Retain only the diagnostic tail; continue draining pipes after truncation.
function tail(limit, encoding) {
  let bytes = Buffer.alloc(0);
  let total = 0;
  return {
    add(chunk) {
      total += chunk.length;
      const keep = chunk.subarray(Math.max(0, chunk.length - limit));
      const previous = bytes.subarray(Math.max(0, bytes.length + keep.length - limit));
      bytes = Buffer.concat([previous, keep]);
    },
    text() {
      if (encoding === null) return bytes;
      return (total > bytes.length ? `[discarded ${total - bytes.length} output bytes; diagnostic tail follows]\n` : '') + bytes.toString(encoding);
    },
  };
}

/**
 * A process's /proc/<pid>/stat fields after the command name (which may
 * itself hold spaces and parentheses): [0] state, [1] ppid, [19] starttime.
 * Throws when the process is gone.
 */
function statFields(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ');
}

/** A process's start time: with its pid, the identity a reused pid cannot fake. */
function identity(pid) {
  try { return statFields(pid)[19]; } catch { return null; }
}

/** Adds the case's descendants to `known`, and their command names to `commands`. */
function descendants(root, rootStart, known, commands = null) {
  if (process.platform !== 'linux') return;
  const parents = new Map();
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const fields = statFields(pid);
      // The command name, from /proc/<pid>/comm: it may hold spaces and parentheses.
      const comm = commands ? readFileSync(`/proc/${pid}/comm`, 'utf8').trimEnd() : '';
      parents.set(Number(pid), { parent: Number(fields[1]), start: fields[19], comm });
    } catch { /* A process exited during the snapshot. */ }
  }
  const owned = new Set();
  if (rootStart !== null && parents.get(root)?.start === rootStart) owned.add(root);
  for (const [pid, start] of known) if (parents.get(pid)?.start === start) owned.add(pid);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, info] of parents) {
      if (!owned.has(pid) && owned.has(info.parent)) {
        owned.add(pid);
        known.set(pid, info.start);
        commands?.add(info.comm);
        changed = true;
      }
    }
  }
}

function killTree(child, rootStart, known) {
  if (!child.pid) return;
  descendants(child.pid, rootStart, known);
  // Kill the process group too: it survives its leader and includes ordinary
  // grandchildren even after the test itself has exited. The /proc census
  // additionally catches children that created their own process group.
  for (const [pid, start] of [...known].reverse()) {
    try {
      if (statFields(pid)[19] === start) process.kill(pid, 'SIGKILL');
    } catch { /* Already gone; never kill a reused pid. */ }
  }
  const current = identity(child.pid);
  if (current !== null && current !== rootStart) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Group already gone. */ }
  if (current !== null) { try { child.kill('SIGKILL'); } catch { /* Spawn failed. */ } }
}

const JOIN_FAILED = 'bounded-process: could not join the case cgroup';

/**
 * Remove a case's cgroup and any a nested runner left inside it, deepest
 * first (cgroup.kill empties a subtree but removes none of it). Returns
 * what could not be removed, or ''.
 */
function removeGroup(group) {
  let entries = [];
  try { entries = readdirSync(group, { withFileTypes: true }); } catch { return ''; }
  const left = entries.filter((entry) => entry.isDirectory()).map((entry) => removeGroup(resolvePath(group, entry.name))).filter(Boolean);
  try { rmdirSync(group); } catch (error) { left.push(`${group}: ${error.code ?? error.message}`); }
  return left.join(', ');
}

/** NIMBUS_TEST_MEMORY_MAX (`4G`, `512M`, bytes) as bytes, for memory.max. */
function memoryBytes(value) {
  const match = /^(\d+)([KMGT]?)$/i.exec(String(value).trim());
  if (!match) throw new Error(`NIMBUS_TEST_MEMORY_MAX ${JSON.stringify(value)} is not <digits>[K|M|G|T]`);
  return Number(match[1]) * 1024 ** ' KMGT'.indexOf(match[2].toUpperCase() || ' ');
}

let installed = false;
let interrupted = null;
function installCleanup() {
  if (installed) return;
  installed = true;
  for (const [signal, code] of /** @type {const} */ ([['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]])) {
    process.on(signal, () => {
      interrupted = signal;
      process.exitCode = code;
      for (const job of active) {
        console.error(`FAIL ${job.name}: runner received ${signal}; killing test descendants`);
        job.cancel(signal);
      }
      // Let pending calls settle, so callers' finally blocks run before exit.
    });
  }
  process.on('exit', () => { for (const job of active) job.kill(); });
}

/**
 * Run `command` with `args` bounded in time and output, its whole process
 * tree killed when it is over.
 *
 * @param {string} command
 * @param {string[]} [args]
 * @param {{ env?: NodeJS.ProcessEnv, timeoutMs?: number, maxOutputBytes?: number, name?: string, cwd?: string, encoding?: BufferEncoding | null }} [options]
 *   `encoding: null` answers stdout and stderr as Buffers.
 */
export function runBoundedProcess(command, args = [], { env = process.env, timeoutMs = DEFAULT_TEST_TIMEOUT_MS, maxOutputBytes = 1024 * 1024, name = command, cwd, encoding = 'utf8' } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) throw new Error('timeoutMs and maxOutputBytes must be positive finite integers');
  installCleanup();
  if (interrupted) return Promise.resolve({ ok: false, stdout: encoding === null ? Buffer.alloc(0) : '', stderr: encoding === null ? Buffer.alloc(0) : '', reason: `runner received ${interrupted}`, code: null, signal: interrupted, outputTruncated: false });
  return new Promise((resolve) => {
    const stdout = tail(maxOutputBytes, encoding);
    const stderr = tail(maxOutputBytes, encoding);
    const known = new Map();
    let reason = '';
    let outputBytes = 0;
    let outputTruncated = false;
    let finished = false;
    let cleanupTimer;
    let exitCode = null;
    let exitSignal = null;
    /** Why the process never started, when it did not: launchError. @type {string | undefined} */
    let notStarted;
    // The case's whole process tree, where its cgroup can be read: null otherwise.
    let cpuMs = null;
    let memoryPeakBytes = null;
    // The command is found in the child's own PATH, in either mode: a
    // spawn's lookup falls back to a default search path when PATH is empty,
    // so the portable mode ran \`sh\` that the isolated mode refused.
    // A directory passes X_OK too, so only an executable regular file counts.
    const isExecutableFile = (path) => {
      try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
    };
    let executable = command;
    if (!command.includes('/')) {
      executable = (env.PATH ?? '/usr/bin:/bin').split(':').map((dir) => resolvePath(cwd ?? process.cwd(), dir, command)).find(isExecutableFile);
      if (!executable) {
        resolveResultMissing();
        return;
      }
    }
    executable = resolvePath(cwd ?? process.cwd(), executable);
    if (!isExecutableFile(executable)) { resolveResultMissing(); return; }
    function resolveResultMissing() {
      const launchError = `spawn failed: ${command} not found in PATH`;
      resolve({ ok: false, stdout: stdout.text(), stderr: stderr.text(), reason: launchError, launchError, code: null, signal: null, outputTruncated: false });
    }
    // NIMBUS_TEST_CGROUP names a cgroup v2 directory this runner may create
    // groups in; a CI container can delegate one (.armada.json's env). Each case
    // gets its own group there and joins it before exec, so nothing it starts
    // is ever outside it. Its CPU and peak memory are read from that group,
    // and cgroup.kill ends every descendant, setsid and reparented ones too.
    // A case whose environment carries NIMBUS_TEST_CGROUP is handed its own
    // group there, so a runner it starts nests its cases inside it.
    const cgroupRoot = process.env.NIMBUS_TEST_CGROUP || null;
    let caseGroup = null;
    if (cgroupRoot) {
      // env(1) takes the first argument without `=` as the command.
      // A failure here launched nothing: launchError says so, so a runner
      // can tell it from a test that ran and failed.
      const refuse = (launchError) => resolve({ ok: false, stdout: stdout.text(), stderr: stderr.text(), reason: launchError, launchError, code: null, signal: null, outputTruncated: false });
      if (executable.includes('=')) { refuse(`cgroup launch cannot exec a path containing "=": ${executable}`); return; }
      try {
        caseGroup = resolvePath(cgroupRoot, `case-${randomUUID()}`);
        mkdirSync(caseGroup);
        if (readFileSync(resolvePath(cgroupRoot, 'cgroup.subtree_control'), 'utf8').split(/\s+/).includes('memory')) {
          writeFileSync(resolvePath(caseGroup, 'memory.max'), String(memoryBytes(process.env.NIMBUS_TEST_MEMORY_MAX || '4G')));
          writeFileSync(resolvePath(caseGroup, 'memory.swap.max'), '0');
        }
      } catch (error) {
        if (caseGroup) removeGroup(caseGroup);
        refuse(`cgroup isolation unavailable under ${cgroupRoot}: ${error.message}`);
        return;
      }
    }
    // The shell joins the case's group and execs env(1), which execs the
    // target with exactly the requested environment: the shell's own (it
    // adds PWD and drops names that are not identifiers) never reaches it.
    const cgroupEnv = caseGroup && env.NIMBUS_TEST_CGROUP !== undefined ? { ...env, NIMBUS_TEST_CGROUP: caseGroup } : env;
    const child = caseGroup
      ? spawn('/bin/sh', ['-c', `echo $$ > "$0/cgroup.procs" || { echo '${JOIN_FAILED}' >&2; exit 125; }; exec /usr/bin/env -i -- "$@"`, caseGroup,
        ...Object.entries(cgroupEnv).filter(([key, value]) => key && !key.includes('=') && value !== undefined).map(([key, value]) => `${key}=${value}`),
        executable, ...args], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: {}, cwd })
      : spawn(executable, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env, cwd });
    const rootStart = child.pid ? identity(child.pid) : null;
    const job = {
      name,
      kill() {
        if (caseGroup) { try { writeFileSync(resolvePath(caseGroup, 'cgroup.kill'), '1'); } catch { /* Already removed. */ } }
        killTree(child, rootStart, known);
      },
      cancel(signal) {
        reason = `runner received ${signal}`;
        cleanup();
      },
    };
    active.add(job);
    // What the case started, as seen every 25 ms: a run's report says which
    // files drive a local workerd.
    const commands = new Set();
    const census = setInterval(() => { if (child.pid) descendants(child.pid, rootStart, known, commands); }, 25);
    // A setsid descendant may be reparented before the first census. Never
    // wait forever on its inherited pipes. Only a case cgroup
    // (NIMBUS_TEST_CGROUP) closes this race and bounds RSS: polling and
    // process groups cannot.
    const cleanup = () => {
      job.kill();
      cleanupTimer ??= setTimeout(() => {
        reason ||= 'descendant output pipes remained open after process exit; cleanup deadline exceeded';
        child.stdout.destroy();
        child.stderr.destroy();
        finish(exitCode, exitSignal);
      }, 1000);
    };
    const timer = setTimeout(() => {
      reason = `file exceeded --timeout ${timeoutMs}ms (SIGKILL)`;
      cleanup();
    }, timeoutMs);
    const collect = (sink, chunk) => {
      outputBytes += chunk.length;
      sink.add(chunk);
      if (outputBytes > maxOutputBytes && !outputTruncated) {
        outputTruncated = true;
        reason = `output exceeded ${maxOutputBytes} bytes (SIGKILL)`;
        cleanup();
      }
    };
    child.stdout.on('data', (chunk) => collect(stdout, chunk));
    child.stderr.on('data', (chunk) => collect(stderr, chunk));
    // Do not wait for 'close' before cleanup: a grandchild can hold both
    // output pipes open indefinitely after its parent failed or exited.
    child.on('exit', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      reason ||= signal ? `process terminated by ${signal}` : '';
      cleanup();
    });
    const finish = (code, signal = null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      clearInterval(census);
      job.kill();
      active.delete(job);
      // The join shell's own failure: the target never started.
      const launchError = notStarted
        ?? (caseGroup && code === 125 && stderr.text().toString().includes(JOIN_FAILED) ? `could not join case cgroup ${caseGroup}` : undefined);
      if (launchError) reason ||= launchError;
      const settle = () => resolve({ ok: code === 0 && !reason, stdout: stdout.text(), stderr: stderr.text(), reason, ...(launchError ? { launchError } : {}), code, signal, outputTruncated, cpuMs, memoryPeakBytes, commands: [...commands].sort() });
      if (!caseGroup) { settle(); return; }
      // cgroup.kill is asynchronous: read the group once it is empty, so the
      // CPU of every descendant is in it, then remove it.
      const drainedBy = Date.now() + 2000;
      const release = () => {
        let populated = true;
        try { populated = /^populated 1$/m.test(readFileSync(resolvePath(caseGroup, 'cgroup.events'), 'utf8')); } catch { populated = false; }
        if (populated && Date.now() < drainedBy) { setTimeout(release, 10); return; }
        if (populated) reason ||= `case cgroup ${caseGroup} still populated 2s after cgroup.kill`;
        try {
          const usec = Number(readFileSync(resolvePath(caseGroup, 'cpu.stat'), 'utf8').match(/^usage_usec (\d+)$/m)?.[1]);
          if (Number.isSafeInteger(usec)) cpuMs = Math.round(usec / 1000);
          const peak = Number(readFileSync(resolvePath(caseGroup, 'memory.peak'), 'utf8'));
          if (Number.isSafeInteger(peak)) memoryPeakBytes = peak;
        } catch { /* No memory controller in this group. */ }
        const left = removeGroup(caseGroup);
        if (left) reason ||= `case cgroup not removed: ${left}`;
        settle();
      };
      release();
    };
    child.on('error', (error) => {
      reason = `spawn failed: ${error.message}`;
      // No pid: the process never started (EAGAIN, a missing cwd), which is no test's verdict.
      if (child.pid === undefined) notStarted = reason;
      finish(null);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}
