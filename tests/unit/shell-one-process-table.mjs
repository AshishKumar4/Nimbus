#!/usr/bin/env bun
// A shell's background jobs are processes of the session's table, the one
// table ps, jobs, kill and wait read: `$!` names a pid that table holds and
// ps lists, kill ends that process there, and nothing outside the shell's
// own processes is reached by number.
import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
const failures = [];
const check = async (what, run) => {
  try { await run(); console.log(`  ✓ ${what}`); } catch (error) { failures.push(what); console.log(`  ✗ ${what}: ${error.message}`); }
};
const run = async (script) => {
  const r = await ws.exec(script);
  return { code: r.exitCode, stdout: r.stdout, stderr: r.stderr };
};
/** Holds until /tmp/go exists: a job that runs until the test lets it end. */
const HOLD = 'rm -f /tmp/go; hold() { while [ ! -e /tmp/go ]; do sleep 0.05; done; }';

try {
  await check('$! is the session table\'s pid of the job, running there under the shell', async () => {
    const pid = Number((await run(`${HOLD}; hold & echo $!`)).stdout.trim());
    const entry = ws.processes.get(pid);
    assert.ok(entry, `pid ${pid} is in the session table`);
    assert.equal(entry.state, 'running');
    assert.equal(entry.parentPid, ws.shellProcessPid, 'a child of the shell');
    await run('touch /tmp/go; wait');
    assert.notEqual(ws.processes.get(pid)?.state, 'running', 'it ended there with the job');
  });

  await check('ps lists the job $! names', async () => {
    const r = await run(`${HOLD}; hold & p=$!; ps | awk -v p=$p '$1 == p { print "listed" }'; touch /tmp/go; wait`);
    assert.equal(r.stdout, 'listed\n');
  });

  await check('kill $! ends the job in the table, and wait $! answers its signal status', async () => {
    const r = await run(`${HOLD}; hold & p=$!; kill $p; wait $p; echo "status=$?"; echo "p=$p"`);
    assert.match(r.stdout, /^status=143\n/);
    const pid = Number(/p=(\d+)/.exec(r.stdout)[1]);
    assert.equal(ws.processes.get(pid)?.state, 'killed');
  });

  await check('wait $! answers the job\'s own status', async () => {
    assert.equal((await run('(exit 3) & wait $!; echo "status=$?"')).stdout, 'status=3\n');
  });

  await check('kill -STOP %1 marks the job Stopped for jobs, and -CONT running again', async () => {
    const r = await run(`${HOLD}; hold & kill -STOP %1; jobs; kill -CONT %1; jobs; touch /tmp/go; wait`);
    assert.match(r.stdout, /Stopped\s+hold/);
    assert.match(r.stdout, /Running\s+hold/);
  });

  await check('a process outside the shell\'s own is not killed by number', async () => {
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
} finally {
  await ws.close();
}

assert.deepEqual(failures, []);
console.log('shell one process table: ok');
