#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
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
  assert.ok(escaped.ok || /cleanup deadline exceeded/.test(escaped.reason), escaped.reason);
  // Whether the census caught it or not, the call returned without waiting
  // for this endless descendant to voluntarily close stdout/stderr.
  const missing = await runBoundedProcess(join(root, 'no-command'));
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /spawn failed/);
  console.log('bounded-process-safety: byte-exact output, overflow, timeout, escaped pipes, spawn errors');
} finally {
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  rmSync(root, { recursive: true, force: true });
}
