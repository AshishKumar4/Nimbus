#!/usr/bin/env bun
// A job's state is its process's (ProcessRegistry): `jobs` shows it stopped
// after SIGSTOP and running after SIGCONT with no bookkeeping of its own, a
// subshell sees its parent's jobs, and `%N` names the same job to the shell's
// kill and the registry's (xargs kill), both reading the job table's number.
// The states are those bash reports with job control on (an interactive
// shell); a `bash -c` without it never sees a job stop. Main passes this
// too: it guards the refactor that made the process table the state's
// only home.
import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
try {
  const r = await ws.exec([
    'sleep 30 & sleep 31 &',
    'kill -STOP %1; jobs',
    '( jobs -s )',
    'kill -CONT %1; jobs -r',
    'echo %2 | xargs kill; wait %2; echo "wait2=$?"',
    'kill %1; wait; jobs; echo end',
  ].join('\n'));
  assert.equal(r.stderr, '');
  assert.equal(r.stdout, [
    '[1]-  Stopped                    sleep 30',
    '[2]+  Running                    sleep 31 &',
    '[1]-  Stopped                    sleep 30',
    '[1]-  Running                    sleep 30 &',
    '[2]+  Running                    sleep 31 &',
    'wait2=143',
    'end',
    '',
  ].join('\n'));
} finally {
  await ws.close();
}
console.log('shell-job-state: ok');
