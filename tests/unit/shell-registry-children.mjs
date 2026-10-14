#!/usr/bin/env bun
// Commands run by name (command, xargs, find -exec) are the registry's, and they must
// be the same programs the shell runs. `test` and `[` by name evaluate as the
// builtin does, and xargs starts each command as a child process, with xargs's
// stdout and stderr and what the shell knows of them.
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

try {
  await check('test by name compares integers as the builtin does', async () => {
    assert.deepEqual(await run('command test 1 -eq 2; echo $?'), { code: 0, stdout: '1\n', stderr: '' });
    assert.deepEqual(await run('command test 3 -gt 2; echo $?'), { code: 0, stdout: '0\n', stderr: '' });
    assert.deepEqual(await run('command test a = a -a 1 -gt 2; echo $?'), { code: 0, stdout: '1\n', stderr: '' });
    assert.deepEqual(await run('echo 2 | xargs test 1 -lt; echo $?'), { code: 0, stdout: '0\n', stderr: '' });
  });

  await check('test by name negates and tests files as the builtin does', async () => {
    assert.deepEqual(await run('command test ! -e /nope; echo $?'), { code: 0, stdout: '0\n', stderr: '' });
    assert.deepEqual(await run('touch f; command test -s f; echo $?'), { code: 0, stdout: '1\n', stderr: '' });
  });

  await check('[ by name needs its closing ], as the builtin does', async () => {
    const missing = await run('command [ 1 -eq 1; echo $?');
    assert.equal(missing.stdout, '2\n');
    assert.equal(missing.stderr, '[: missing ]\n');
    assert.deepEqual(await run('command [ 1 -eq 1 ]; echo $?'), { code: 0, stdout: '0\n', stderr: '' });
  });

  await check('xargs runs a child whose stdout is the pipe: an endless device streams into it', async () => {
    // The child ends of SIGPIPE once head has its byte, which GNU xargs reports so.
    assert.deepEqual(await run('printf x | xargs -I {} cat /dev/zero | head -c1 | od -An -tx1'), { code: 0, stdout: ' 00\n', stderr: 'xargs: cat: terminated by signal 13\n' });
  });

  await check('xargs keeps its exit policy: a failing command makes it fail, a missing one is 127', async () => {
    assert.deepEqual(await run('echo x | xargs false; echo $?'), { code: 0, stdout: '1\n', stderr: '' });
    assert.deepEqual(await run('echo x | xargs no-such-command; echo $?'), { code: 0, stdout: '127\n', stderr: 'xargs: no-such-command: No such file or directory\n' });
  });
} finally {
  await ws.close();
}

assert.deepEqual(failures, []);
console.log('shell registry children: ok');
