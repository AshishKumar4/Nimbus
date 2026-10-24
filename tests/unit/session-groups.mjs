#!/usr/bin/env bun
// The session user's supplementary groups are the host's to give (Kinu ask
// 73): NimbusWorkspace.create({ sessionGroups }) puts the session user
// (uid 1000) in a project group the host made, so the owner's project
// (setgid to that group, a group-rwx default ACL) is writable by the owner
// and by a viewer in the group, and by no one else. With them:
// - the workspace's shell and an exec with no identity of its own act in
//   them: the owner appends to a file a viewer made in the project
//   (`-rw-rw-r-- 2000 1001`), and `id` shows them;
// - a process the host starts with no parent and no credential has them;
// - the workspace's own `fs`, the shell's view, writes as they allow.
// Without them the same append is `Permission denied`, as before. Group 0 and
// ids that are not ids are refused, and the groups, once set, stay.
import assert from 'node:assert/strict';

import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const VIEWER = Object.freeze({ uid: 2000, gid: 2000, groups: Object.freeze([2000, 1001]), umask: 0o077 });

/** A workspace whose project a viewer has planted a file in, as Kinu's share does. */
async function sharedProject(options) {
  const harness = createSqliteVfsTestHarness();
  const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, ...options });
  const root = ws.vfs.as(CRED_KERNEL);
  root.mkdir('home/main', { recursive: true, mode: 0o2775 });
  root.chown('home/main', 1000, 1001);
  root.chmod('home/main', 0o2775);
  root.setDefaultAcl('home/main', 0o775);
  ws.vfs.as(VIEWER).writeFile('home/main/planted.txt', 'viewer\n');
  const planted = root.stat('home/main/planted.txt');
  assert.deepEqual([planted.uid, planted.gid, planted.mode & 0o777], [2000, 1001, 0o664], 'the viewer\'s file is the project group\'s');
  return ws;
}

{
  const ws = await sharedProject({ sessionGroups: [1001] });
  try {
    const appended = await ws.exec('printf owner >> /home/main/planted.txt');
    assert.equal(appended.exitCode, 0, appended.stderr);
    assert.equal(ws.vfs.as(CRED_KERNEL).readFileString('home/main/planted.txt'), 'viewer\nowner');
    const id = await ws.exec('id');
    assert.match(id.stdout, /^uid=1000\(user\) gid=1000\(\w+\) groups=1000\(\w+\),1001\(/, id.stdout);
    await ws.fs.writeFile('/home/main/planted.txt', 'owner\n');
    assert.equal(ws.vfs.as(CRED_KERNEL).readFileString('home/main/planted.txt'), 'owner\n', 'the workspace\'s own view');

    const host = ws.processes.spawn('host', ['host'], '/');
    assert.deepEqual(ws.processes.cred(host.pid).groups, [1000, 1001], 'a parentless process');
    const child = ws.processes.spawn('child', ['child'], '/', { parentPid: host.pid });
    assert.deepEqual(ws.processes.cred(child.pid).groups, [1000, 1001], 'and its child');
    ws.processes.exit(child.pid, 0);
    ws.processes.exit(host.pid, 0);
    assert.deepEqual(ws.processes.sessionCred.groups, [1000, 1001]);
    assert.throws(() => ws.processes.setSessionGroups([1002]), /already set/, 'set once');
    ws.processes.setSessionGroups([1001]);
    console.log('  ok  sessionGroups: the owner\'s shell, exec, id, view and processes act in the project group');
  } finally {
    await ws.close();
  }
}

{
  const ws = await sharedProject({});
  try {
    const appended = await ws.exec('printf owner >> /home/main/planted.txt');
    assert.equal(appended.exitCode, 1);
    assert.match(appended.stderr, /Permission denied/);
    assert.match((await ws.exec('id')).stdout, /groups=1000\(\w+\)\n$/);
    assert.equal(ws.processes.sessionCred, CRED_SESSION_USER);
    console.log('  ok  without sessionGroups the owner is outside the project group, as before');
  } finally {
    await ws.close();
  }
}

// A home the host made another's and the project group's (2770): the seed
// makes what it puts in it as the session user, in its groups.
for (const sessionGroups of [[1001], undefined]) {
  const harness = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const root = vfs.as(CRED_KERNEL);
  root.mkdir('home/main', { recursive: true, mode: 0o2770 });
  root.chown('home/main', 2000, 1001);
  root.chmod('home/main', 0o2770);
  const opened = NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, vfs, env: { HOME: '/home/main' }, ...(sessionGroups ? { sessionGroups } : {}) });
  if (!sessionGroups) {
    await assert.rejects(opened, /EACCES/, 'outside the group, the seed is refused as the user is');
    continue;
  }
  const ws = await opened;
  try {
    const config = root.stat('home/main/.config');
    assert.deepEqual([config.uid, config.gid], [1000, 1001], 'the seed\'s .config is the session user\'s, in the home\'s group');
    assert.equal((await ws.exec('touch /home/main/projects/x && echo ok')).stdout, 'ok\n');
  } finally {
    await ws.close();
  }
}
console.log('  ok  a home the session user reaches by its groups alone is seeded as the user');

for (const groups of [[0], [1.5], [-1], [Number.NaN]]) {
  assert.throws(() => new SessionProcessSupervisor().setSessionGroups(groups), TypeError, `refused: ${groups}`);
  const harness = createSqliteVfsTestHarness();
  await assert.rejects(NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, sessionGroups: groups }), TypeError);
}
const groupsOf = (groups) => {
  const processes = new SessionProcessSupervisor();
  processes.setSessionGroups(groups);
  return processes.sessionCred;
};
assert.equal(groupsOf([]), CRED_SESSION_USER);
assert.equal(groupsOf([1000]), CRED_SESSION_USER);
assert.deepEqual(groupsOf([1001, 1001, 1002]).groups, [1000, 1001, 1002]);
assert.ok(Object.isFrozen(groupsOf([1001]).groups));
{
  const processes = new SessionProcessSupervisor();
  processes.setSessionGroups([1001]);
  const harness = createSqliteVfsTestHarness();
  const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, processes });
  try {
    assert.match((await ws.exec('id')).stdout, /groups=1000\(\w+\),1001\(/, 'a host\'s own supervisor, set before');
  } finally {
    await ws.close();
  }
}
console.log('  ok  session groups: never 0 nor a non-id, and the same groups once');
