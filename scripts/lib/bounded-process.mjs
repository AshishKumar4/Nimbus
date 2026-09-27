import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, accessSync, constants, mkdtempSync, rmSync, statSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';

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

function identity(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  } catch { return null; }
}

function descendants(root, rootStart, known) {
  if (process.platform !== 'linux') return;
  const parents = new Map();
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      parents.set(Number(pid), { parent: Number(fields[1]), start: fields[19] });
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
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      if (stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] === start) process.kill(pid, 'SIGKILL');
    } catch { /* Already gone; never kill a reused pid. */ }
  }
  const current = identity(child.pid);
  if (current !== null && current !== rootStart) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Group already gone. */ }
  if (current !== null) { try { child.kill('SIGKILL'); } catch { /* Spawn failed. */ } }
}

let installed = false;
let interrupted = null;
let warnedPortable = false;
function installCleanup() {
  if (installed) return;
  installed = true;
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
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
    // run-bounded supplies INVOCATION_ID. Every case then gets its own
    // cgroup: detached descendants cannot escape, even before the first read.
    // Outside that wrapper, retain the explicitly weaker portable fallback.
    const strong = process.env.NIMBUS_TEST_PID_ISOLATION === '1';
    const hostMachine = `${userInfo().username}@.host`;
    if (strong && process.platform !== 'linux') throw new Error('PID/cgroup isolation requires Linux systemd and bwrap; use /mnt/scratch/nimbus/run-bounded');
    if (!strong && !warnedPortable) {
      warnedPortable = true;
      console.error('bounded-process: portable cleanup only (no memory/PID isolation); local verification requires /mnt/scratch/nimbus/run-bounded');
    }
    const unit = strong
      ? `nimbus-case-${randomUUID()}.service` : null;
    let executable = command;
    if (unit && !command.includes('/')) {
      executable = (env.PATH ?? '/usr/bin:/bin').split(':').map((dir) => resolvePath(cwd ?? process.cwd(), dir, command)).find((path) => {
        try { accessSync(path, constants.X_OK); return true; } catch { return false; }
      });
      if (!executable) {
        resolveResultMissing();
        return;
      }
    }
    if (unit) {
      executable = resolvePath(cwd ?? process.cwd(), executable);
      try { accessSync(executable, constants.X_OK); } catch { resolveResultMissing(); return; }
    }
    function resolveResultMissing() {
      resolve({ ok: false, stdout: stdout.text(), stderr: stderr.text(), reason: `spawn failed: ${command} not found in PATH`, code: null, signal: null, outputTruncated: false });
    }
    let statusDir;
    let statusFile;
    if (unit) {
      try { accessSync('/usr/bin/bwrap', constants.X_OK); } catch {
        resolve({ ok: false, stdout: stdout.text(), stderr: stderr.text(), reason: 'required PID isolation unavailable: /usr/bin/bwrap', code: null, signal: null, outputTruncated: false });
        return;
      }
      statusDir = mkdtempSync(resolvePath(tmpdir(), 'bounded-status-'));
      statusFile = resolvePath(statusDir, 'status.json');
    }
    const launchArgs = unit ? [
      // oneshot treats SIGTERM as a signal failure, not a clean service stop.
      '--user', `--machine=${hostMachine}`, '--quiet', '--wait', '--pipe', '--service-type=oneshot', '--expand-environment=no',
      `--unit=${unit}`, '--slice=nimbus-tests.slice',
      `--working-directory=${cwd ?? process.cwd()}`,
      `--property=MemoryMax=${process.env.NIMBUS_TEST_MEMORY_MAX || '4G'}`,
      `--property=MemoryHigh=${process.env.NIMBUS_TEST_MEMORY_HIGH || '3G'}`, '--property=MemorySwapMax=0',
      '--property=OOMPolicy=kill', '--property=KillMode=control-group', '--property=TasksMax=256',
      '--property=TimeoutStopSec=1s', `--property=TimeoutStartSec=${Math.max(1, Math.ceil(timeoutMs / 1000))}s`,
      // The launcher needs the caller's user-bus environment. The target
      // receives only its requested environment, not the manager's defaults.
      // PID/user namespaces isolate signals, not filesystem or network access.
      '--', '/usr/bin/bwrap', '--unshare-user', '--uid', String(process.getuid()), '--gid', String(process.getgid()),
      '--unshare-pid', '--bind', '/', '/', '--proc', '/proc', '--dev-bind', '/dev', '/dev', '--die-with-parent',
      '--', process.execPath, fileURLToPath(new URL('./subprocess-entry.mjs', import.meta.url)), statusFile,
      '/usr/bin/env', '-i', ...Object.entries(env).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${value}`),
      executable, ...args,
    ] : args;
    const child = spawn(unit ? '/usr/bin/systemd-run' : command, launchArgs, { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: unit ? process.env : env, cwd });
    const rootStart = child.pid ? identity(child.pid) : null;
    const job = {
      name,
      kill() {
        if (unit) {
          const killed = spawnSync('/usr/bin/systemctl', ['--user', `--machine=${hostMachine}`, 'kill', '--kill-whom=all', '--signal=KILL', unit], { encoding: 'utf8', timeout: 3000 });
          if (killed.status !== 0 && reason && child.exitCode === null && child.signalCode === null) console.error(`cgroup cleanup ${unit}: ${killed.error?.message ?? killed.stderr}`);
          // The systemd-run client can retain its bus/stdio handles after the
          // service is killed. It is our direct child, not a namespace PID.
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        } else killTree(child, rootStart, known);
      },
      cancel(signal) {
        reason = `runner received ${signal}`;
        cleanup();
      },
    };
    active.add(job);
    const census = unit ? null : setInterval(() => { if (child.pid) descendants(child.pid, rootStart, known); }, 25);
    // A setsid descendant may be reparented before the first census. Never
    // wait forever on its inherited pipes. The outer run-bounded cgroup is
    // REQUIRED: polling/process groups cannot close this race or bound RSS.
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
      if (unit) {
        // Failed units remain queryable until reset. systemd-run's own exit
        // status alone cannot distinguish an oracle exit from exec/OOM failure.
        const info = spawnSync('/usr/bin/systemctl', ['--user', `--machine=${hostMachine}`, 'show', unit, '--property=Result,ExecMainCode,ExecMainStatus'], { encoding: 'utf8', timeout: 3000 });
        const props = Object.fromEntries((info.stdout ?? '').trim().split('\n').map((line) => line.split('=')));

        if (props.Result && !['success', 'exit-code'].includes(props.Result)) reason ||= `cgroup result=${props.Result} ExecMainCode=${props.ExecMainCode} ExecMainStatus=${props.ExecMainStatus}`;
        if (props.ExecMainCode === '1') {
          code = Number(props.ExecMainStatus);
        } else if (props.ExecMainCode === '2' || props.ExecMainCode === '3') {
          signal = `signal ${props.ExecMainStatus}`;
          code = null;
          reason ||= `process terminated by ${signal}`;
        }
        spawnSync('/usr/bin/systemctl', ['--user', `--machine=${hostMachine}`, 'reset-failed', unit], { stdio: 'ignore', timeout: 3000 });
        try {
          if (statSync(statusFile).size > 1024) throw new Error('oversized wait status');
          const status = JSON.parse(readFileSync(statusFile, 'utf8'));
          if (!(status.code === null || (Number.isInteger(status.code) && status.code >= 0 && status.code <= 255))
            || !(status.signal === null || typeof status.signal === 'string') || typeof status.error !== 'string') throw new Error('invalid wait status');
          code = status.code;
          signal = status.signal;
          if (status.error) reason ||= `spawn failed: ${status.error}`;
          if (signal) reason ||= `process terminated by ${signal}`;
        } catch (error) {
          reason ||= `PID-isolated process produced no valid wait status: ${error.message}`;
        } finally { rmSync(statusDir, { recursive: true, force: true }); }
      }
      resolve({ ok: code === 0 && !reason, stdout: stdout.text(), stderr: stderr.text(), reason, code, signal, outputTruncated });
    };
    child.on('error', (error) => { reason = `spawn failed: ${error.message}`; finish(null); });
    child.on('close', (code, signal) => finish(code, signal));
  });
}
