import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

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
function installCleanup() {
  if (installed) return;
  installed = true;
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    process.on(signal, () => {
      for (const job of active) {
        console.error(`FAIL ${job.name}: runner received ${signal}; killing test descendants`);
        job.kill();
      }
      process.exit(code);
    });
  }
  process.on('exit', () => { for (const job of active) job.kill(); });
}

export function runBoundedProcess(command, args = [], { env = process.env, timeoutMs = DEFAULT_TEST_TIMEOUT_MS, maxOutputBytes = 1024 * 1024, name = command, cwd, encoding = 'utf8' } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) throw new Error('timeoutMs and maxOutputBytes must be positive finite integers');
  installCleanup();
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
    const child = spawn(command, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env, cwd });
    const rootStart = child.pid ? identity(child.pid) : null;
    const job = { name, kill: () => killTree(child, rootStart, known) };
    active.add(job);
    const census = setInterval(() => { if (child.pid) descendants(child.pid, rootStart, known); }, 25);
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
      resolve({ ok: code === 0 && !reason, stdout: stdout.text(), stderr: stderr.text(), reason, code, signal, outputTruncated });
    };
    child.on('error', (error) => { reason = `spawn failed: ${error.message}`; finish(null); });
    child.on('close', (code, signal) => finish(code, signal));
  });
}
