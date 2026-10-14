#!/usr/bin/env bun
// A process that ends after the exec that started it has returned (a
// background job) leaves a core workspace's process table as it leaves a
// hosted session's: kept for the 60 s an ended process stays listed, then
// forgotten when the next exec starts. Before, nothing in a core workspace
// pruned the table, and every such process stayed until close.
import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
// The table's clock (ProcessTable reads Date.now), moved forward by `ahead` ms.
const realNow = Date.now;
let ahead = 0;
Date.now = () => realNow() + ahead;

try {
  const started = await ws.exec('rm -f /tmp/go; (while [ ! -e /tmp/go ]; do sleep 0.05; done) & echo $!');
  const pid = Number(started.stdout.trim());
  assert.equal(ws.processes.get(pid)?.state, 'running', 'the job outlives the exec that started it');

  await ws.fs.writeFile('/tmp/go', '');
  assert.equal(await ws.processes.whenEnded(pid), 0);
  await ws.exec('true');
  assert.equal(ws.processes.get(pid)?.state, 'exited', 'an ended process stays listed for 60 s');

  ahead = 61_000;
  await ws.exec('true');
  assert.equal(ws.processes.get(pid), undefined, 'the next exec after 60 s forgets it');
  console.log('  ✓ an ended job is kept 60 s, then the next exec forgets it');

  // The exec itself, and what it ended, still leave at its return.
  const before = ws.processes.getAll().length;
  await ws.exec('true; (exit 3)');
  assert.equal(ws.processes.getAll().length, before, 'an exec leaves nothing behind');
  console.log('  ✓ an exec leaves nothing behind');
} finally {
  Date.now = realNow;
  await ws.close();
}
console.log('workspace prunes ended processes: ok');
