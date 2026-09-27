#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBoundedProcess } from '../../scripts/lib/bounded-process.mjs';

const root = mkdtempSync(join(tmpdir(), 'bounded-process-'));
const pids = [];
try {
  const binary = await runBoundedProcess(process.execPath, ['-e', 'process.stdout.write(Buffer.alloc(90000,255)); process.exit(7)'], { encoding: null });
  assert.equal(binary.code, 7);
  assert.equal(binary.reason, '');
  assert.deepEqual(binary.stdout, Buffer.alloc(90000, 255));
  const flood = await runBoundedProcess(process.execPath, ['-e', `for (;;) process.stderr.write('z'.repeat(16384))`], { maxOutputBytes: 8192 });
  assert.match(flood.reason, /output exceeded 8192 bytes/);
  assert.equal(flood.outputTruncated, true);
  assert.ok(flood.stderr.length <= 8400);
  const timed = await runBoundedProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100 });
  assert.match(timed.reason, /timeout 100ms/);

  // A setsid child may escape the census before its parent exits, retaining
  // the output pipe forever. Cleanup must return even when no pid was seen.
  // The test explicitly reaps the escapee; production containment is the
  // outer cgroup, not a guarantee process-group polling can provide.
  const pidFile = join(root, 'escaped.pid');
  const grandchild = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{},1000);`;
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{detached:true,stdio:'inherit'}).unref(); process.exit(0);`;
  const escaped = await runBoundedProcess(process.execPath, ['-e', parent], { timeoutMs: 3000 });
  if (existsSync(pidFile)) pids.push(Number(readFileSync(pidFile, 'utf8')));
  if (process.env.INVOCATION_ID) {
    assert.equal(escaped.ok, true, escaped.reason);
    for (const pid of pids) {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        assert.equal(stat.slice(stat.lastIndexOf(')') + 2)[0], 'Z', 'cgroup descendant survived its parent');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  } else assert.ok(escaped.ok || /cleanup deadline exceeded/.test(escaped.reason), escaped.reason);
  // Whether the census caught it or not, the call returned without waiting
  // for this endless descendant to voluntarily close stdout/stderr.
  const missing = await runBoundedProcess(join(root, 'no-command'));
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /spawn failed/);
  const emptyPath = await runBoundedProcess('sh', ['-c', 'exit 0'], { env: { ...process.env, PATH: '' } });
  assert.match(emptyPath.reason, /spawn failed/);
  const narrowEnv = await runBoundedProcess(process.execPath, ['-e', 'console.log(JSON.stringify(process.env))'], { env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
  assert.equal(narrowEnv.ok, true, narrowEnv.reason);
  assert.deepEqual(JSON.parse(narrowEnv.stdout), { PATH: '/usr/bin:/bin', LANG: 'C' });
  const normal143 = await runBoundedProcess(process.execPath, ['-e', 'process.exit(143)']);
  assert.equal(normal143.code, 143);
  assert.equal(normal143.reason, '');
  const killed = await runBoundedProcess(process.execPath, ['-e', "process.kill(process.pid,'SIGTERM')"]);
  assert.equal(killed.code, null, 'a signal is not a normal exit143');
  assert.ok(killed.signal);
  assert.ok(killed.reason);

  const parentPid = join(root, 'parent.pid');
  const started = join(root, 'oracle.started');
  const cleaned = join(root, 'finally');
  const driver = join(root, 'driver.mjs');
  const helperUrl = new URL('../../scripts/lib/bounded-process.mjs', import.meta.url).href;
  writeFileSync(driver, `
    import { runBoundedProcess } from ${JSON.stringify(helperUrl)};
    import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(parentPid)}, String(process.pid));
    try {
      const result = await runBoundedProcess(process.execPath, ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(started)}, 'ready'); setInterval(()=>{},1000)`)}]);
      if (!result.reason.includes('SIGTERM')) throw new Error('cancellation was not reported');
    } finally { writeFileSync(${JSON.stringify(cleaned)}, 'clean'); }
  `);
  const cancelled = runBoundedProcess(process.execPath, [driver], { timeoutMs: 10_000 });
  for (let i = 0; i < 500 && !existsSync(started); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(existsSync(started), 'oracle start handshake');
  process.kill(Number(readFileSync(parentPid, 'utf8')), 'SIGTERM');
  const result = await cancelled;
  assert.equal(result.code, 143);
  assert.equal(readFileSync(cleaned, 'utf8'), 'clean', 'caller finally runs before signal-derived exit');
  console.log('bounded-process-safety: byte-exact output, overflow, timeout, escaped pipes, spawn errors');
} finally {
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  rmSync(root, { recursive: true, force: true });
}
