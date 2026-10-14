#!/usr/bin/env bun
// Commands run by name (xargs, find -exec) are the registry's, and they must be
// the same programs the shell runs. `test` and `[` by name evaluate as the
// builtin does, and xargs starts each command as a child process, with xargs's
// stdout and stderr and what the shell knows of them, ending with GNU's
// statuses. `command NAME` is bash's: a builtin or a program, never a function.
import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
// Programs that exit 255 (GNU xargs's signal to stop) and 126 (a status, not a refused exec).
ws.registry.register('exit255', async () => 255);
ws.registry.register('exit126', async () => 126);
// A program that ignores its stop until the test lets it go, then meets a closed pipe.
let releaseLate;
const lateRelease = new Promise((resolve) => { releaseLate = resolve; });
ws.registry.register('late-after-abort', async (ctx) => {
  await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve, { once: true }));
  await lateRelease;
  throw Object.assign(new Error('EPIPE: broken pipe, write'), { code: 'EPIPE' });
});
// A program whose cancellation meets a closed pipe: aborted, it throws EPIPE.
ws.registry.register('pipe-on-abort', async (ctx) => {
  await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve, { once: true }));
  throw Object.assign(new Error('EPIPE: broken pipe, write'), { code: 'EPIPE' });
});
const failures = [];
const check = async (what, run) => {
  try { await run(); console.log(`  ✓ ${what}`); } catch (error) { failures.push(what); console.log(`  ✗ ${what}: ${error.message}`); }
};
const run = async (script) => {
  const r = await ws.exec(script);
  return { code: r.exitCode, stdout: r.stdout, stderr: r.stderr };
};

try {
  // xargs runs test by name: its status is 0, or GNU xargs's 123 for a failure.
  await check('test by name compares integers as the builtin does', async () => {
    assert.deepEqual(await run('echo 2 | xargs test 1 -eq; echo $?'), { code: 0, stdout: '123\n', stderr: '' });
    assert.deepEqual(await run('echo 2 | xargs test 3 -gt; echo $?'), { code: 0, stdout: '0\n', stderr: '' });
    assert.deepEqual(await run('echo 2 | xargs test a = a -a 1 -gt; echo $?'), { code: 0, stdout: '123\n', stderr: '' });
    assert.deepEqual(await run('echo 2 | xargs test 1 -lt; echo $?'), { code: 0, stdout: '0\n', stderr: '' });
  });

  await check('test by name negates and tests files as the builtin does', async () => {
    assert.deepEqual(await run('echo /nope | xargs test ! -e; echo $?'), { code: 0, stdout: '0\n', stderr: '' });
    assert.deepEqual(await run('touch f; echo f | xargs test -s; echo $?'), { code: 0, stdout: '123\n', stderr: '' });
  });

  await check('[ by name needs its closing ], as the builtin does', async () => {
    const missing = await run('echo 1 | xargs [ 1 -eq; echo $?');
    assert.equal(missing.stdout, '123\n');
    assert.equal(missing.stderr, '[: missing ]\n');
    assert.deepEqual(await run('echo ] | xargs [ 1 -eq 1; echo $?'), { code: 0, stdout: '0\n', stderr: '' });
  });

  await check('xargs ends with GNU\'s statuses: 123 for a failure, 124 for 255, 127 for a missing command', async () => {
    assert.deepEqual(await run('echo x | xargs false; echo $?'), { code: 0, stdout: '123\n', stderr: '' });
    assert.deepEqual(await run('printf "a\\nb\\n" | xargs -n1 exit255; echo $?'), { code: 0, stdout: '124\n', stderr: 'xargs: exit255: exited with status 255; aborting\n' });
    assert.deepEqual(await run('echo x | xargs no-such-command; echo $?'), { code: 0, stdout: '127\n', stderr: 'xargs: no-such-command: No such file or directory\n' });
  });

  await check('a file or directory xargs may not execute is 126, a program that exits 126 is 123', async () => {
    assert.deepEqual(await run('touch /tmp/noexec; chmod 644 /tmp/noexec; printf "a\\nb\\n" | xargs -n1 /tmp/noexec; echo $?'), { code: 0, stdout: '126\n', stderr: 'xargs: /tmp/noexec: Permission denied\n' });
    assert.deepEqual(await run('printf x | xargs /tmp; echo $?'), { code: 0, stdout: '126\n', stderr: 'xargs: /tmp: Permission denied\n' });
    assert.deepEqual(await run('echo x | xargs exit126; echo $?'), { code: 0, stdout: '123\n', stderr: '' });
  });

  await check('sudo finds no file it may not execute', async () => {
    assert.deepEqual(await run('touch /tmp/noexec; chmod 644 /tmp/noexec; sudo -u user /tmp/noexec; echo $?'), { code: 0, stdout: '1\n', stderr: 'sudo: /tmp/noexec: command not found\n' });
  });

  await check('a child a kill ends ends xargs at once, with 125 and the signal', async () => {
    const started = performance.now();
    const pending = ws.exec("printf '30\\n31\\n' | xargs -n1 sleep");
    let child;
    for (let i = 0; i < 200 && !child; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      child = ws.processes.getRunning().find((entry) => entry.argv.join(' ') === 'sleep 30');
    }
    assert.ok(child, 'the first sleep runs as a process of the table');
    assert.deepEqual(await run(`kill ${child.pid}`), { code: 0, stdout: '', stderr: '' });
    const r = await pending;
    assert.deepEqual({ code: r.exitCode, stderr: r.stderr }, { code: 125, stderr: 'xargs: sleep: terminated by signal 15\n' });
    assert.ok(performance.now() - started < 10_000, 'the second sleep never ran');
  });

  await check('a child killed while its cancellation meets a closed pipe ends as the kill, as the table says', async () => {
    const pending = ws.exec('echo 1 | xargs pipe-on-abort');
    let child;
    for (let i = 0; i < 200 && !child; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      child = ws.processes.getRunning().find((entry) => entry.argv.join(' ') === 'pipe-on-abort 1');
    }
    assert.ok(child, 'the child runs as a process of the table');
    assert.deepEqual(await run(`kill ${child.pid}`), { code: 0, stdout: '', stderr: '' });
    const r = await pending;
    assert.deepEqual({ code: r.exitCode, stderr: r.stderr }, { code: 125, stderr: 'xargs: pipe-on-abort: terminated by signal 15\n' });
  });

  await check('a killed child its session has pruned before its program returns still ends as the kill', async () => {
    const pending = ws.exec('echo 1 | xargs late-after-abort');
    let child;
    for (let i = 0; i < 200 && !child; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      child = ws.processes.getRunning().find((entry) => entry.argv.join(' ') === 'late-after-abort 1');
    }
    assert.ok(child, 'the child runs as a process of the table');
    assert.deepEqual(await run(`kill ${child.pid}`), { code: 0, stdout: '', stderr: '' });
    // Its work ignores the stop past the bound on it; a prune then forgets its entry.
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    await ws.processes.reap(0);
    assert.equal(ws.processes.get(child.pid), undefined, 'the entry was pruned before the program returned');
    releaseLate();
    const r = await pending;
    assert.deepEqual({ code: r.exitCode, stderr: r.stderr }, { code: 125, stderr: 'xargs: late-after-abort: terminated by signal 15\n' });
  });

  await check('command NAME runs the builtin: command kill %1 ends the shell\'s job', async () => {
    const r = await ws.exec('sleep 5 & command kill %1; wait %1; echo "status=$?"', { timeout: 3000 });
    assert.deepEqual({ code: r.exitCode, stdout: r.stdout, stderr: r.stderr }, { code: 0, stdout: 'status=143\n', stderr: '' });
  });

  await check('command NAME never runs a function by that name', async () => {
    assert.deepEqual(await run('echo() { printf "function\\n"; }; command echo builtin'), { code: 0, stdout: 'builtin\n', stderr: '' });
  });

  await check('a function named command is that function', async () => {
    assert.deepEqual(await run('command() { printf "custom\\n"; }; command echo ignored'), { code: 0, stdout: 'custom\n', stderr: '' });
  });
} finally {
  await ws.close();
}

assert.deepEqual(failures, []);
console.log('shell registry children: ok');
