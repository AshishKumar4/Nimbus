#!/usr/bin/env bun
/**
 * `cp -r` in the workspace shell: directories copy recursively, a new
 * destination is copied by reference (no chunk written), an existing
 * directory receives SOURCE/basename, `-a`/`-p` preserve mode, and
 * a directory without -r is refused the way GNU cp refuses it.
 */

import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({
  sql: harness.sql,
  transactions: harness.ctx,
  processes: new SessionProcessSupervisor(),
  ctxExports: { Supervisor: ({ props }) => ({ props }) },
  fabric: { supervisorEntrypoint: 'Supervisor', hostNamespace: 'ACTORS', hostDispatchMethod: 'workspaceCall' },
  supervisorOps: {},
});
const sh = async (line) => {
  const result = await ws.exec(line);
  return { code: result.exitCode, out: result.stdout, err: result.stderr };
};
const chunks = () => harness.sql.exec('SELECT COUNT(*) AS n FROM vfs_chunks')[0].n;

try {
  const setup = await sh([
    'mkdir -p /home/user/src/lib/deep',
    'printf one > /home/user/src/a.txt',
    'printf two > /home/user/src/lib/b.txt',
    'printf three > /home/user/src/lib/deep/c.txt',
    'ln -s lib/b.txt /home/user/src/link',
    'chmod 700 /home/user/src/lib/deep',
    'head -c 300000 /dev/zero | tr "\\0" x > /home/user/src/big.txt',
  ].join(' && '));
  assert.equal(setup.code, 0, setup.err);

  const before = chunks();
  const copied = await sh('cp -r /home/user/src /home/user/dst');
  assert.equal(copied.code, 0, copied.err);
  assert.equal(chunks(), before, 'a new destination is copied by reference');
  assert.equal((await sh('cat /home/user/dst/lib/deep/c.txt')).out, 'three');
  assert.equal((await sh('readlink /home/user/dst/link')).out.trim(), 'lib/b.txt');
  assert.equal((await sh('wc -c < /home/user/dst/big.txt')).out.trim(), '300000');

  // An existing directory receives SOURCE/basename, several sources at once.
  assert.equal((await sh('mkdir /home/user/into && cp -R /home/user/src/lib /home/user/src/a.txt /home/user/into')).code, 0);
  assert.equal((await sh('cat /home/user/into/lib/b.txt /home/user/into/a.txt')).out, 'twoone');

  // A copy into an existing destination directory merges.
  assert.equal((await sh('mkdir -p /home/user/merge/lib && printf keep > /home/user/merge/lib/kept.txt')).code, 0);
  assert.equal((await sh('cp -r /home/user/src/lib /home/user/merge')).code, 0);
  assert.equal((await sh('cat /home/user/merge/lib/kept.txt /home/user/merge/lib/b.txt')).out, 'keeptwo');

  // Without -r a directory is omitted, and cp says so.
  const refused = await sh('cp /home/user/src /home/user/nope');
  assert.equal(refused.code, 1);
  assert.match(refused.err, /-r not specified; omitting directory/);
  assert.equal((await sh('test -e /home/user/nope; echo $?')).out.trim(), '1');

  // -a preserves mode (and times: sqlite-vfs-copy-tree covers them).
  assert.equal((await sh('chmod 640 /home/user/src/a.txt')).code, 0);
  assert.equal((await sh('cp -a /home/user/src /home/user/archived')).code, 0);
  assert.equal((await sh('stat -c %a /home/user/archived/a.txt')).out.trim(), '640');
  assert.equal((await sh('stat -c %a /home/user/archived/lib/deep')).out.trim(), '700');

  // A directory cannot be copied into itself.
  const inside = await sh('cp -r /home/user/src /home/user/src/sub');
  assert.equal(inside.code, 1);
  assert.match(inside.err, /into itself/);
} finally {
  await ws.dispose?.();
}

console.log('shell-cp-recursive: all assertions passed');
