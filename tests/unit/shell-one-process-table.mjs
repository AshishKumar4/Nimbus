#!/usr/bin/env bun
// A shell's background jobs are processes of the session's table, the one
// table jobs, kill and wait read: `$!` names a pid that table holds, a child
// of the shell's own process (`$$`), kill ends that process there, another
// shell reaches it by pid as it would any process, and nothing outside what
// the workspace runs is reached by number.
import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
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
    assert.equal(ws.processes.get(pid)?.state, 'killed');
    assert.equal(ws.processes.get(pid)?.exitCode, 143);
  });

  await check('wait $! answers the job\'s own status', async () => {
    assert.equal((await run('(exit 3) & wait $!; echo "status=$?"')).stdout, 'status=3\n');
  });

  await check('kill -STOP %1 marks the job Stopped for jobs, and -CONT running again', async () => {
    const r = await run(`${HOLD}; hold & kill -STOP %1; jobs; kill -CONT %1; jobs; touch /tmp/go; wait`);
    assert.match(r.stdout, /Stopped\s+hold/);
    assert.match(r.stdout, /Running\s+hold/);
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

  await check('the workspace\'s own shell is not killed by number', async () => {
    const r = await run(`kill ${ws.shellProcessPid}; echo "status=$?"`);
    assert.equal(r.stdout, 'status=1\n');
    assert.equal(ws.processes.get(ws.shellProcessPid)?.state, 'running');
  });
} finally {
  await ws.close();
}

assert.deepEqual(failures, []);
console.log('shell one process table: ok');
