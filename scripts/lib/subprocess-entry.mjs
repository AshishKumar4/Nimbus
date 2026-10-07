// Runs inside the case's PID namespace. Preserve wait status independently
// of bubblewrap, which maps both SIGTERM and a normal exit143 to 143.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
const requestFile = process.argv[2];
const statusFile = join(dirname(requestFile), 'status.json');
let recorded = false;
// The case's CPU so far: this process shares the case's cgroup with the
// target and everything it started, and cpu.stat counts all of them.
function cgroupCpuUsec() {
  try {
    const group = readFileSync('/proc/self/cgroup', 'utf8').match(/^0::(\/.*)$/m)?.[1];
    const usec = Number(readFileSync(`/sys/fs/cgroup${group}/cpu.stat`, 'utf8').match(/^usage_usec (\d+)$/m)?.[1]);
    return Number.isSafeInteger(usec) ? usec : null;
  } catch { return null; }
}
function record(code, signal, error = '') {
  if (recorded) return;
  recorded = true;
  writeFileSync(statusFile, JSON.stringify({ code, signal, error, cpuUsec: cgroupCpuUsec() }));
  // bubblewrap's PID1 reaper tears down any detached descendants afterward.
  process.exit(code ?? 1);
}
let request;
try {
  if (statSync(requestFile).size > 1024 * 1024) throw new Error();
  request = JSON.parse(readFileSync(requestFile, 'utf8'));
  if (!request || typeof request.executable !== 'string' || !request.executable
    || !Array.isArray(request.args) || !request.args.every(arg => typeof arg === 'string')
    || !request.env || typeof request.env !== 'object' || Array.isArray(request.env)
    || !Object.values(request.env).every(value => typeof value === 'string')) throw new Error();
} catch { record(null, null, 'invalid or oversized launch request'); }
const child = spawn(request.executable, request.args, { stdio: 'inherit', env: request.env });
child.once('error', (error) => record(null, null, error.message));
child.once('exit', (code, signal) => record(code, signal));
