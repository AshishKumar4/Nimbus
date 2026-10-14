#!/usr/bin/env bun
// A job's state is its own, and a subshell sees its parent's jobs. Nothing
// can pause a job's work, so a stop signal is refused (status 1, as a
// resident refuses it) and the job is never listed as stopped; SIGCONT to a
// running job succeeds and does nothing, as on Linux. `%N` names a job to
// the shell's own kill only: kill as a program (xargs kill) has no job
// table, as procps kill has none, and reaches the job by its pid.
import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
try {
  const r = await ws.exec([
    'sleep 30 & p1=$!; sleep 31 & p2=$!',
    'kill -STOP %1 2>/tmp/stop.err; echo "stop=$?"; sed "s/($p1)/(P1)/" /tmp/stop.err; jobs',
    '( jobs -s )',
    'kill -CONT %1; echo "cont=$?"; jobs -r',
    'echo %2 | xargs kill 2>&1; echo "external=$?"',
    'echo $p2 | xargs kill; wait %2; echo "wait2=$?"',
    'kill %1; wait; jobs; echo end',
  ].join('\n'));
  assert.equal(r.stderr, '');
  assert.equal(r.stdout, [
    'stop=1',
    'kill: (P1) - Operation not supported (SIGSTOP cannot be delivered to a hosted process)',
    '[1]-  Running                    sleep 30 &',
    '[2]+  Running                    sleep 31 &',
    'cont=0',
    '[1]-  Running                    sleep 30 &',
    '[2]+  Running                    sleep 31 &',
    'kill: %2: no such job',
    'external=123',
    'wait2=143',
    'end',
    '',
  ].join('\n'));
} finally {
  await ws.close();
}
console.log('shell-job-state: ok');
