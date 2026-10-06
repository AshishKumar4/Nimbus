#!/usr/bin/env bun
// read, exit, source, ., set and trap are the shell's builtins; run by name
// (xargs, find -exec) they are not found, as bash's are on a system with no
// /usr/bin copies (GNU xargs exits 127). The registry held stubs that
// answered 0 and did nothing. shopt and ulimit, which the registry answers,
// say what this shell does: no shopt options (bash's "invalid shell option
// name", 1), no enforced limits (`unlimited`; setting one fails, 1).
import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
try {
  for (const name of ['read', 'exit', 'source', '.', 'set', 'trap']) {
    const r = await ws.exec(`echo x | xargs ${name}`);
    assert.equal(r.exitCode, 127, `xargs ${name}: ${r.stderr}`);
  }
  assert.equal((await ws.exec('echo hi | { read v; echo "$v"; }')).stdout, 'hi\n', 'the builtin still reads');

  const shopt = await ws.exec('shopt -s globstar');
  assert.deepEqual([shopt.exitCode, shopt.stderr], [1, 'shopt: globstar: invalid shell option name\n']);
  assert.equal((await ws.exec('shopt -q nullglob')).exitCode, 1);
  assert.deepEqual([(await ws.exec('shopt')).exitCode, (await ws.exec('shopt')).stdout], [0, '']);

  assert.equal((await ws.exec('ulimit -n')).stdout, 'unlimited\n');
  assert.match((await ws.exec('ulimit -a')).stdout, /^open files \(-n\) +unlimited$/m);
  const set = await ws.exec('ulimit -n 1024');
  assert.deepEqual([set.exitCode, set.stderr], [1, 'ulimit: open files: cannot modify limit: Operation not permitted\n']);
} finally {
  await ws.close();
}
console.log('shell-by-name-builtins: ok');
