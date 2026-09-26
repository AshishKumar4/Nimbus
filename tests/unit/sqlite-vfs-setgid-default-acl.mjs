#!/usr/bin/env bun
// Kinu N26: a setgid directory shares what is made in it (the directory's
// group; a new directory is setgid too), and a directory's default ACL base
// entries (u::, g::, o::) replace the umask for what is made there, so a
// group member can edit what another member made. Also: moving a directory
// to another parent needs write permission on the directory (its `..`).

import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const perms = (stat) => (stat.mode & 0o7777).toString(8);
const code = (run) => { try { run(); return 'ok'; } catch (error) { return error.code ?? error.message; } };
const ADA = { uid: 2000, gid: 2000, groups: [2000, 1000], umask: 0o022 };
const BO = { uid: 2001, gid: 2001, groups: [2001, 1000], umask: 0o022 };
const STRANGER = { uid: 3000, gid: 3000, groups: [3000], umask: 0o022 };

function setup() {
  const harness = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = vfs.as(CRED_KERNEL);
  kernel.mkdir('shared');
  kernel.chown('shared', 0, 1000);
  kernel.chmod('shared', 0o2775);
  kernel.mkdir('home/ada/draft', { recursive: true });
  kernel.chown('home/ada', 2000, 2000);
  kernel.chown('home/ada/draft', 2000, 2000);
  return { vfs, kernel, ada: vfs.as(ADA), bo: vfs.as(BO) };
}

// Kinu's repro, POSIX part: the group and the setgid bit are inherited.
{
  const { kernel, ada, bo } = setup();
  ada.mkdir('shared/site');
  ada.writeFile('shared/site/index.html', 'hi');
  assert.deepEqual([kernel.stat('shared/site').gid, perms(kernel.stat('shared/site'))], [1000, '2755'], 'site: the group, setgid');
  assert.deepEqual([kernel.stat('shared/site/index.html').gid, perms(kernel.stat('shared/site/index.html'))], [1000, '644']);
  ada.mkdir('shared/site/deep');
  assert.deepEqual([kernel.stat('shared/site/deep').gid, perms(kernel.stat('shared/site/deep'))], [1000, '2755'], 'inherited down');
  // Without a default ACL the umask decides, as on Linux: 644 is not the group's to write.
  assert.equal(code(() => bo.writeFile('shared/site/index.html', 'bo')), 'EACCES');
  // A rename keeps the entry's group (POSIX): sharing a moved tree is the embedder's policy.
  ada.writeFile('home/ada/draft/app.js', 'x');
  ada.rename('home/ada/draft', 'shared/draft');
  assert.equal(kernel.stat('shared/draft').gid, 2000);
}

// The default ACL (setfacl -d -m u::rwx,g::rwx,o::r-x): the umask is replaced,
// and a new directory inherits the ACL.
{
  const { kernel, ada, bo } = setup();
  kernel.setDefaultAcl('shared', 0o775);
  assert.equal(kernel.getDefaultAcl('shared'), 0o775);
  ada.mkdir('shared/site');
  ada.writeFile('shared/site/index.html', 'hi');
  assert.equal(perms(kernel.stat('shared/site')), '2775', 'directory: 0777 & ACL, plus setgid');
  assert.equal(kernel.getDefaultAcl('shared/site'), 0o775, 'a new directory inherits the ACL');
  assert.equal(perms(kernel.stat('shared/site/index.html')), '664', 'file: 0666 & ACL, no umask');
  assert.equal(code(() => bo.writeFile('shared/site/index.html', 'bo')), 'ok', 'the group writes what a member made');
  assert.equal(code(() => bo.writeFile('shared/site/about.html', 'about')), 'ok');
  assert.equal(kernel.stat('shared/site/about.html').gid, 1000);
  // A batch (npm, git) follows the same rule, parents staged in the batch included.
  ada.writeBatch({ inodes: [
    { path: '/shared/pkg', parentPath: '/shared', isDir: true, size: 0, mtime: 1, mode: 0o777, chunkCount: 0 },
    { path: '/shared/pkg/lib', parentPath: '/shared/pkg', isDir: true, size: 0, mtime: 1, mode: 0o777, chunkCount: 0 },
  ], chunks: [] });
  assert.deepEqual([perms(kernel.stat('shared/pkg/lib')), kernel.stat('shared/pkg/lib').gid, kernel.getDefaultAcl('shared/pkg/lib')], ['2775', 1000, 0o775]);
  // Only the owner (or root) sets it; setfacl -k removes it.
  assert.equal(code(() => ada.setDefaultAcl('shared', 0o777)), 'EPERM');
  assert.equal(code(() => ada.setDefaultAcl('shared/site/index.html', 0o777)), 'ENOTDIR');
  ada.setDefaultAcl('shared/site', null);
  assert.equal(kernel.getDefaultAcl('shared/site'), null);
  ada.writeFile('shared/site/plain.txt', 'x');
  assert.equal(perms(kernel.stat('shared/site/plain.txt')), '644', 'the umask again');
  // A rename keeps the ACL with the directory.
  kernel.rename('shared/pkg', 'shared/pkg2');
  assert.equal(kernel.getDefaultAcl('shared/pkg2'), 0o775);
}

// Moving a directory to another parent needs write permission on it.
{
  const { kernel, vfs } = setup();
  kernel.mkdir('p/d', { recursive: true });
  kernel.mkdir('q');
  for (const dir of ['p', 'q']) { kernel.chown(dir, 3000, 3000); kernel.chmod(dir, 0o755); }
  kernel.chown('p/d', 3000, 3000);
  kernel.chmod('p/d', 0o555);
  const owner = vfs.as(STRANGER);
  assert.equal(code(() => owner.rename('p/d', 'q/d')), 'EACCES', 'its .. would change');
  assert.equal(code(() => owner.rename('p/d', 'p/e')), 'ok', 'same parent: no ..');
  kernel.rename('p/e', 'q/e');
  assert.ok(kernel.isDirectory('q/e'), 'the kernel passes');
}

// setfacl / getfacl in the shell, as the session user, on a directory it owns.
{
  const { NimbusWorkspace } = await import('../../packages/core/src/workspace/nimbus-workspace.ts');
  const harness = createSqliteVfsTestHarness();
  const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
  const run = async (command) => { const r = await ws.exec(command); return { code: r.exitCode, out: r.stdout, err: r.stderr }; };
  assert.equal((await run('mkdir -p /home/user/team && chmod 2775 /home/user/team')).code, 0);
  assert.equal((await run('setfacl -d -m u::rwx,g::rwx,o::r-x /home/user/team')).code, 0);
  const shown = (await run('getfacl /home/user/team')).out;
  assert.match(shown, /# flags: -s-/);
  assert.match(shown, /default:user::rwx\ndefault:group::rwx\ndefault:other::r-x/);
  assert.equal((await run('touch /home/user/team/f && mkdir /home/user/team/d')).code, 0);
  assert.match((await run('stat -c %a /home/user/team/f /home/user/team/d')).out, /^664\n2775\n$/);
  assert.match((await run('getfacl /home/user/team/d')).out, /default:group::rwx/, 'inherited');
  assert.equal((await run('setfacl -k /home/user/team')).code, 0);
  assert.doesNotMatch((await run('getfacl /home/user/team')).out, /default:/);
  const refused = await run('setfacl -d -m u:bob:rwx /home/user/team');
  assert.equal(refused.code, 1);
  assert.match(refused.err, /only base entries/);
  assert.equal((await run('setfacl -d -m g::rwx /etc')).code, 1, 'not the owner');
  await ws.close?.();
}

console.log('sqlite-vfs-setgid-default-acl: ok');
