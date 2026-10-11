#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBoundedProcess } from '../../scripts/lib/bounded-process.mjs';

const root = mkdtempSync(join(tmpdir(), 'bounded-process-'));
const owned = [];
async function readyFile(path) {
  for (let i = 0; i < 500 && !existsSync(path); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(existsSync(path), `missing readiness handshake: ${path}`);
}
async function lockStatus(path) {
  const result = await runBoundedProcess('/usr/bin/flock', ['-n', path, '/usr/bin/true']);
  assert.equal(result.reason, '');
  return result.code;
}
try {
  const binary = await runBoundedProcess(process.execPath, ['-e', 'process.stdout.write(Buffer.alloc(90000,255)); process.exit(7)'], { encoding: null });
  assert.equal(binary.code, 7);
  assert.equal(binary.reason, '');
  assert.deepEqual(binary.stdout, Buffer.alloc(90000, 255));
  const argv = ['$$', '$HOME', '${LANG}', '%n', '', 'a b', '"quoted"', '\\escape'];
  const exactArgs = await runBoundedProcess(process.execPath, ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...argv]);
  assert.equal(exactArgs.ok, true, exactArgs.reason);
  assert.deepEqual(JSON.parse(exactArgs.stdout), argv, 'systemd must not expand argument bytes');
  console.log('bounded-process-safety: output and argv preserved');
  const flood = await runBoundedProcess(process.execPath, ['-e', `for (;;) process.stderr.write('z'.repeat(16384))`], { maxOutputBytes: 8192 });
  assert.match(flood.reason, /output exceeded 8192 bytes/);
  assert.equal(flood.outputTruncated, true);
  assert.ok(flood.stderr.length <= 8400);
  const timed = await runBoundedProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100 });
  assert.match(timed.reason, /timeout 100ms/);
  console.log('bounded-process-safety: overflow and deadline enforced');

  // The detached child acquires an exclusive lock, reports its pid over fd3,
  // then stops itself. It cannot voluntarily release the lock. Requiring the
  // lock busy before parent exit and free afterward proves actual teardown,
  // not merely a closed output pipe or a marker that might never appear.
  const lock = join(root, 'detached.lock');
  const ready = join(root, 'detached.ready');
  const release = join(root, 'parent.release');
  const grandchild = `require('node:fs').writeSync(3,String(process.pid)); process.kill(process.pid,'SIGSTOP');`;
  const parent = `
    const fs=require('node:fs');
    const child=require('node:child_process').spawn('/usr/bin/flock', ['-F','-x',${JSON.stringify(lock)},process.execPath,'-e',${JSON.stringify(grandchild)}],{detached:true,stdio:['ignore',1,2,'pipe']});
    child.stdio[3].once('data',(pid)=>fs.writeFileSync(${JSON.stringify(ready)},pid));
    setInterval(()=>{ if(fs.existsSync(${JSON.stringify(release)})) process.exit(0); },10);
  `;
  const escaped = runBoundedProcess(process.execPath, ['-e', parent], { timeoutMs: 10_000 });
  let escapedResult;
  try {
    await readyFile(ready);
    assert.equal(await lockStatus(lock), 1, 'detached child holds its lock before parent exit');
  } finally { writeFileSync(release, 'release'); escapedResult = await escaped; }
  if (!escapedResult.ok) {
    // Without isolation, descendants are found by a /proc census every 25 ms.
    // A setsid one whose parent exits within a period is reparented before it
    // is seen (bounded-process.mjs): the run must then end at the cleanup
    // deadline and say so, not hang. The descendant it could not reach is
    // this test's to stop.
    assert.match(escapedResult.reason, /cleanup deadline exceeded/);
    const pid = Number(readFileSync(ready, 'utf8'));
    process.kill(pid, 'SIGKILL');
    for (let i = 0; i < 500 && existsSync(`/proc/${pid}`); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(await lockStatus(lock), 0, 'stopped detached descendant was actually terminated');
  const missing = await runBoundedProcess(join(root, 'no-command'));
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /spawn failed/);
  // What never started is no test's verdict: a runner reads launchError as not graded.
  assert.equal(missing.launchError, missing.reason, 'a missing command never started');
  const nowhere = await runBoundedProcess('sh', ['-c', 'exit 0'], { cwd: join(root, 'no-such-directory') });
  assert.equal(nowhere.ok, false);
  assert.match(nowhere.launchError ?? '', /spawn failed/, `a missing working directory never started: ${JSON.stringify(nowhere)}`);
  const emptyPath = await runBoundedProcess('sh', ['-c', 'exit 0'], { env: { ...process.env, PATH: '' } });
  assert.match(emptyPath.reason, /spawn failed/);
  // A directory named like the command, earlier in PATH, is not the command.
  mkdirSync(join(root, 'shadow', 'sh'), { recursive: true });
  const shadowed = await runBoundedProcess('sh', ['-c', 'echo found'], { env: { ...process.env, PATH: `${join(root, 'shadow')}:/usr/bin:/bin` } });
  assert.equal(shadowed.ok, true, shadowed.reason);
  assert.equal(shadowed.stdout.trim(), 'found');
  const narrowEnv = await runBoundedProcess(process.execPath, ['-e', 'console.log(JSON.stringify(process.env))'], { env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
  assert.equal(narrowEnv.ok, true, narrowEnv.reason);
  assert.deepEqual(JSON.parse(narrowEnv.stdout), { PATH: '/usr/bin:/bin', LANG: 'C' });
  const normal143 = await runBoundedProcess(process.execPath, ['-e', 'process.exit(143)']);
  assert.equal(normal143.code, 143);
  assert.equal(normal143.reason, '');
  const normal203 = await runBoundedProcess(process.execPath, ['-e', 'process.exit(203)']);
  assert.equal(normal203.code, 203);
  assert.equal(normal203.reason, '', 'numeric user exit203 is not a systemd EXEC failure');
  const killed = await runBoundedProcess(process.execPath, ['-e', "process.kill(process.pid,'SIGTERM')"]);
  assert.equal(killed.code, null, 'a signal is not a normal exit143');
  assert.ok(killed.signal);
  assert.ok(killed.reason);
  console.log('bounded-process-safety: normal exits and signals distinguished');

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
  const parentProcess = spawn(process.execPath, [driver], { stdio: ['ignore', 'ignore', 'inherit'] });
  owned.push(parentProcess);
  const cancelled = new Promise((resolve) => parentProcess.once('close', (code) => resolve({ code })));
  for (let i = 0; i < 500 && !existsSync(started); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(existsSync(started), 'oracle start handshake');
  parentProcess.kill('SIGTERM');
  const result = await cancelled;
  assert.equal(result.code, 143);
  assert.equal(readFileSync(cleaned, 'utf8'), 'clean', 'caller finally runs before signal-derived exit');
  console.log('bounded-process-safety: cancellation unwound caller');
  console.log('bounded-process-safety: byte-exact output, overflow, timeout, escaped pipes, spawn errors');
} finally {
  await Promise.all(owned.map((child) => child.exitCode !== null || child.signalCode !== null ? undefined : new Promise((resolve) => { child.once('close', resolve); child.kill('SIGKILL'); })));
  rmSync(root, { recursive: true, force: true });
}
