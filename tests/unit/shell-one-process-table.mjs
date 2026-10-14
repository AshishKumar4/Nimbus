#!/usr/bin/env bun
// A shell's background jobs are processes of the session's table, the one
// table jobs, kill and wait read: `$!` names a pid that table holds, a child
// of the shell's own process (`$$`), kill ends that process there, another
// shell reaches it by pid as it would any process, and nothing outside what
// the workspace runs is reached by number.
import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
const failures = [];
const check = async (what, run) => {
  try { await run(); console.log(`  ✓ ${what}`); } catch (error) { failures.push(what); console.log(`  ✗ ${what}: ${error.message}`); }
};
const run = async (script, options) => {
  const r = await ws.exec(script, options);
  return { code: r.exitCode, stdout: r.stdout, stderr: r.stderr };
};
/** Holds until /tmp/go exists: a job that runs until the test lets it end. */
const HOLD = 'rm -f /tmp/go; hold() { while [ ! -e /tmp/go ]; do sleep 0.05; done; }';

try {
  await check('$! is the session table\'s pid of the job, running there under $$', async () => {
    const [shell, pid] = (await run(`${HOLD}; hold & echo $$ $!`)).stdout.trim().split(' ').map(Number);
    const entry = ws.processes.get(pid);
    assert.ok(entry, `pid ${pid} is in the session table`);
    assert.equal(entry.state, 'running');
    assert.equal(entry.parentPid, shell, 'a child of the shell that started it');
    await run('touch /tmp/go');
    await ws.processes.whenEnded(pid);
    assert.equal(ws.processes.get(pid)?.state, 'exited', 'it ended there with the job');
  });

  await check('kill $! ends the job in the table, and wait $! answers its signal status', async () => {
    const r = await run(`${HOLD}; hold & p=$!; kill $p; wait $p; echo "status=$?"; echo "p=$p"`);
    assert.match(r.stdout, /^status=143\n/);
    const pid = Number(/p=(\d+)/.exec(r.stdout)[1]);
    assert.equal(ws.processes.get(pid), undefined, 'ended, it left the table with the exec that waited for it');
  });

  await check('wait $! answers the job\'s own status', async () => {
    assert.equal((await run('(exit 3) & wait $!; echo "status=$?"')).stdout, 'status=3\n');
  });

  await check('kill -STOP %1 is refused and the job runs on; -CONT succeeds', async () => {
    const r = await run(`${HOLD}; hold & kill -STOP %1; echo "stop=$?"; jobs; kill -CONT %1; echo "cont=$?"; touch /tmp/go; wait`);
    assert.match(r.stdout, /^stop=1\n\[1\]\+\s+Running\s+hold/);
    assert.match(r.stdout, /cont=0\n/);
    assert.doesNotMatch(r.stdout, /Stopped/);
    assert.match(r.stderr, /Operation not supported \(SIGSTOP cannot be delivered to a hosted process\)/);
  });

  await check('another shell ends a job by pid; its wait is not that shell\'s', async () => {
    const pid = Number((await run(`${HOLD}; hold & echo $!`)).stdout.trim());
    // Bounded: a wait that took the job for this shell's would hold until it ends.
    assert.deepEqual(await run(`wait ${pid}`, { timeout: 2000 }), { code: 127, stdout: '', stderr: `wait: pid ${pid} is not a child of this shell\n` });
    assert.deepEqual(await run(`kill ${pid}; echo "status=$?"`), { code: 0, stdout: 'status=0\n', stderr: '' });
    assert.equal(ws.processes.get(pid)?.state, 'killed');
  });

  await check('a process outside what the workspace runs is not killed by number', async () => {
    const other = ws.processes.spawn('other', ['other'], '/');
    try {
      const r = await run(`kill ${other.pid}; echo "status=$?"`);
      assert.equal(r.stdout, 'status=1\n');
      assert.match(r.stderr, /No such process/);
      assert.equal(ws.processes.get(other.pid)?.state, 'running');
    } finally {
      ws.processes.exit(other.pid, 0);
    }
  });

  await check('the workspace\'s idle shell answers kill -0, and refuses a kill', async () => {
    assert.deepEqual(await run(`kill -0 ${ws.shellProcessPid}; echo "status=$?"`), { code: 0, stdout: 'status=0\n', stderr: '' });
    const r = await run(`kill ${ws.shellProcessPid}; echo "status=$?"`);
    assert.deepEqual(r, { code: 0, stdout: 'status=1\n', stderr: `kill: (${ws.shellProcessPid}) - Operation not permitted\n` });
    assert.equal(ws.processes.get(ws.shellProcessPid)?.state, 'running');
  });

  await check('a process of another uid is not the session user\'s to kill (kill(2))', async () => {
    const root = ws.processes.spawn('rootjob', ['rootjob'], '/', { cred: CRED_KERNEL });
    const held = ws.processes.holdWork(root.pid);
    try {
      assert.deepEqual(await run(`kill ${root.pid}; echo "status=$?"`), { code: 0, stdout: 'status=1\n', stderr: `kill: (${root.pid}) - Operation not permitted\n` });
      assert.deepEqual(await run(`kill -0 ${root.pid}; echo "status=$?"`), { code: 0, stdout: 'status=1\n', stderr: `kill: (${root.pid}) - Operation not permitted\n` });
      assert.equal(ws.processes.get(root.pid)?.state, 'running');
    } finally {
      held();
      ws.processes.exit(root.pid, 0);
    }
  });

  await check('a default-ignored signal from a program reaches a job and leaves it running', async () => {
    const r = await run(`${HOLD}; hold & p=$!; echo $p | xargs kill -s WINCH; echo "rc=$?"; kill -0 $p; echo "live=$?"; touch /tmp/go; wait`);
    assert.deepEqual(r, { code: 0, stdout: 'rc=0\nlive=0\n', stderr: '' });
  });

  await check('a background job in an rc file starts, and the rest of the file runs', async () => {
    const rcHarness = createSqliteVfsTestHarness();
    const rcWs = await NimbusWorkspace.create({ sql: rcHarness.sql, transactions: rcHarness.ctx });
    try {
      await rcWs.fs.writeFile('/home/user/.liforc', ': & export READY=yes\n');
      await rcWs.shell.start();
      assert.equal(rcWs.shell.getEnv().READY, 'yes');
    } finally {
      await rcWs.close();
    }
  });
} finally {
  await ws.close();
}

assert.deepEqual(failures, []);
console.log('shell one process table: ok');
