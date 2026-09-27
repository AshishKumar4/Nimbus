#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const cases = [
  ['sleep 30 & sleep 31 & jobs; kill %1 %2; wait', '[1]-  Running                    sleep 30 &\n[2]+  Running                    sleep 31 &\n'],
  ['sleep 30 & sleep 31 & jobs %+; jobs %-; kill %1 %2; wait', '[2]+  Running                    sleep 31 &\n[1]-  Running                    sleep 30 &\n'],
  ['sleep 30 & p=$!; test "$(jobs -p)" = "$p"; echo p=$?; kill -s TERM %1; wait %1; echo w=$?', 'p=0\nw=143\n'],
  ['sleep 30 & sleep 31 & kill %?30; wait %1; echo first=$?; kill %+; wait %2; echo second=$?', 'first=143\nsecond=143\n'],
  ['sleep 30 & kill -s TERM %sleep; wait %%; echo w=$?', 'w=143\n'],
  ['(exit 4) & wait %1; echo first=$?; wait %1; echo again=$?', 'first=4\nagain=4\n'],
  ['kill -l TERM; kill -l 15; kill -l 143', '15\nTERM\nTERM\n'],
  ['(exit 4) & wait %1; (exit 7) & wait %1; echo reused=$?', 'reused=7\n'],
  ['(exit 9) & wait; echo bare=$?', 'bare=0\n'],
  ['sleep 30 & a=$!; sleep 31 & b=$!; kill %sleep 2>/dev/null; echo ambiguous=$?; kill -0 $a; echo live=$?; kill -n15 $a $b; wait', 'ambiguous=1\nlive=0\n'],
  ['sleep 30 & p=$!; jobs -l > /tmp/job-list; read mark pid state < /tmp/job-list; test "$pid" = "$p"; echo long=$?; kill $p; wait', 'long=0\n'],
  ['sleep 30 & p=$!; kill -s NOPE $p 2>/dev/null; echo invalid=$?; kill -0 $p; echo live=$?; kill -sTERM $p; wait $p; echo status=$?', 'invalid=1\nlive=0\nstatus=143\n'],
  ['fg 2>/dev/null; echo fg=$?; bg 2>/dev/null; echo bg=$?', 'fg=1\nbg=1\n'],
  ['wait 999999 2>/dev/null; echo unknown=$?', 'unknown=127\n'],
];
const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
try {
  for (const [command, expected] of cases) {
    const result = await ws.exec(command, { timeout: 2000 });
    assert.equal(result.stdout, expected, command);
    assert.equal(result.stderr, '', command);
    assert.equal(result.exitCode, 0, command);
  }
  await ws.shell.execute('true &');
  const completed = ws.shell.getJobTable().list().at(-1);
  await completed.promise;
  const listed = await ws.shell.execute('jobs | cat');
  assert.match(listed.stdout, /Done\s+true/);
  const waited = await ws.shell.execute(`wait %${completed.id}; echo preserved=$?`);
  assert.equal(waited.stdout, 'preserved=0\n', 'a pipeline jobs listing must not reap the parent job');
  assert.equal(waited.stderr, '');
} finally {
  await ws.close();
}
console.log('shell-job-control: job names, markers, signals and repeat waits');
