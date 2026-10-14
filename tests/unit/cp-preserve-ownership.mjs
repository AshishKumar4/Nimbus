#!/usr/bin/env bun
/**
 * `cp -p` and `cp -a` keep an entry's mode, owner and times on every path
 * cp takes, as GNU cp 9.7 does: a new file, an overwritten one, a merge into
 * an existing tree, a new tree, and a symbolic link (its own owner and mtime,
 * lchown and lutimes). Root keeps the source's owner; another caller cannot,
 * and cp then keeps its own, silently. A symbolic link named on the command
 * line is followed, unless -R, -a or -P/-d copies it as the link.
 *
 * The copies run through the workspace shell; the fixture's owners and times
 * are set, and the results read, through the kernel's view.
 */

import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({
  sql: harness.sql,
  transactions: harness.ctx,
  processes: new SessionProcessSupervisor(),
  ctxExports: { Supervisor: ({ props }) => ({ props }) },
  fabric: { supervisorEntrypoint: 'Supervisor', hostNamespace: 'ACTORS', hostDispatchMethod: 'workspaceCall' },
  supervisorOps: {},
});
const kernel = ws.vfs.as(CRED_KERNEL);
const sh = async (line) => {
  const result = await ws.exec(line);
  return { code: result.exitCode, out: result.stdout, err: result.stderr };
};
const FILE_TIME = Date.UTC(2001, 0, 1);
const LINK_TIME = Date.UTC(2002, 1, 2);
const DIR_TIME = Date.UTC(2003, 2, 3);
/** Owner, group, permission bits and mtime of `path` itself (a link not followed). */
const meta = (path) => {
  const st = kernel.lstat(path);
  return { type: st.type, uid: st.uid, gid: st.gid, mode: st.mode & 0o7777, mtime: st.mtime };
};

try {
  // The source tree is another user's: /srv/s, its file f, its directory sub, and a link l to f.
  kernel.mkdir('srv/s/sub', { recursive: true });
  kernel.writeFile('srv/s/f', 'x');
  kernel.writeFile('srv/s/sub/g', 'y');
  kernel.symlink('f', 'srv/s/l');
  kernel.chmod('srv/s/f', 0o640);
  kernel.chmod('srv/s/sub/g', 0o640);
  kernel.chmod('srv/s/sub', 0o750);
  for (const path of ['srv/s', 'srv/s/f', 'srv/s/sub', 'srv/s/sub/g']) kernel.chown(path, 1001, 1002);
  kernel.chown('srv/s/l', 1003, 1004, { followSymlinks: false });
  kernel.utimes('srv/s/f', FILE_TIME, FILE_TIME);
  kernel.utimes('srv/s/sub/g', FILE_TIME, FILE_TIME);
  kernel.utimes('srv/s/l', LINK_TIME, LINK_TIME, { followSymlinks: false });
  kernel.utimes('srv/s/sub', DIR_TIME, DIR_TIME);
  const file = { type: 'file', uid: 1001, gid: 1002, mode: 0o640, mtime: FILE_TIME };
  const link = { type: 'symlink', uid: 1003, gid: 1004, mode: meta('srv/s/l').mode, mtime: LINK_TIME };
  const dir = { type: 'directory', uid: 1001, gid: 1002, mode: 0o750, mtime: DIR_TIME };

  // Root, a new file and an overwritten one.
  assert.equal((await sh('sudo mkdir /srv/out && sudo cp -p /srv/s/f /srv/out/f')).code, 0);
  assert.deepEqual(meta('srv/out/f'), file, 'cp -p as root: a new file keeps the owner, mode and mtime');
  kernel.writeFile('srv/out/old', 'old');
  const over = await sh('sudo cp -p /srv/s/f /srv/out/old');
  assert.equal(over.code, 0, over.err);
  assert.deepEqual(meta('srv/out/old'), file, 'cp -p as root: an overwritten file takes the owner, mode and mtime');
  console.log('  ✓ cp -p as root: a new and an overwritten file keep owner, mode and mtime');

  // Root, a merge into an existing tree, and a new tree.
  kernel.mkdir('srv/t/s', { recursive: true });
  const merged = await sh('sudo cp -a /srv/s /srv/t');
  assert.equal(merged.code, 0, merged.err);
  assert.deepEqual([meta('srv/t/s/f'), meta('srv/t/s/sub'), meta('srv/t/s/sub/g'), meta('srv/t/s/l')], [file, dir, file, link],
    'cp -a as root into an existing tree: every entry, the link too, keeps its own');
  const fresh = await sh('sudo cp -a /srv/s /srv/n');
  assert.equal(fresh.code, 0, fresh.err);
  assert.deepEqual([meta('srv/n/f'), meta('srv/n/sub'), meta('srv/n/l')], [file, dir, link], 'cp -a as root into a new tree');
  console.log('  ✓ cp -a as root: a merge into an existing tree and a new tree keep every entry\'s own');

  // Another caller keeps its own owner, and says nothing.
  kernel.chmod('srv/s/f', 0o644);
  const user = await sh('cp -p /srv/s/f /home/user/g');
  assert.deepEqual({ code: user.code, err: user.err }, { code: 0, err: '' }, 'cp -p of another user\'s file succeeds silently');
  assert.deepEqual(meta('home/user/g'), { ...file, uid: 1000, gid: 1000, mode: 0o644 }, 'the copy is the caller\'s, with the mode and mtime kept');
  console.log('  ✓ cp -p as another user: the caller\'s own owner, silently');

  // A command-line link is followed unless -R, -a, -P or -d copies the link.
  for (const flags of ['', '-p']) {
    const out = `/home/user/o${flags}`;
    assert.equal((await sh(`cp ${flags} /srv/s/l ${out}`)).code, 0);
    assert.equal(meta(out.slice(1)).type, 'file', `cp ${flags} of a link copies what it names`);
  }
  for (const flags of ['-r', '-R', '-a', '-P', '-d']) {
    const out = `/home/user/k${flags}`;
    assert.equal((await sh(`cp ${flags} /srv/s/l ${out}`)).code, 0);
    assert.equal(meta(out.slice(1)).type, 'symlink', `cp ${flags} of a link copies the link`);
  }
  console.log('  ✓ a command-line link: followed by cp and cp -p, copied as the link by -r, -R, -a, -P and -d');
} finally {
  await ws.close();
}
console.log('cp-preserve-ownership: ok');
