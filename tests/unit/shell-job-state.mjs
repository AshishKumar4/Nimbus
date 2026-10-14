#!/usr/bin/env bun
// A job's state is its own: `jobs` shows it stopped after SIGSTOP and
// running after SIGCONT, and a subshell sees its parent's jobs. `%N` names
// a job to the shell's own kill only: kill as a program (xargs kill) has no
// job table, as procps kill has none, and reaches the job by its pid. The
// states are those bash reports with job control on (an interactive shell);
// a `bash -c` without it never sees a job stop.
import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
try {
  const r = await ws.exec([
    'sleep 30 & sleep 31 & p2=$!',
    'kill -STOP %1; jobs',
    '( jobs -s )',
    'kill -CONT %1; jobs -r',
    'echo %2 | xargs kill 2>&1; echo "external=$?"',
    'echo $p2 | xargs kill; wait %2; echo "wait2=$?"',
    'kill %1; wait; jobs; echo end',
  ].join('\n'));
  assert.equal(r.stderr, '');
  assert.equal(r.stdout, [
    '[1]-  Stopped                    sleep 30',
    '[2]+  Running                    sleep 31 &',
    '[1]-  Stopped                    sleep 30',
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
