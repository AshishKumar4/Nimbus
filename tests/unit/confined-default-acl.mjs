#!/usr/bin/env bun
// A confined principal's default ACL widens no further than its chmod
// (Kinu ask 74). A default ACL is the mode of every entry made beneath it, so
// for a confined credential:
// - setDefaultAcl refuses (EPERM, never clamps) an ACL whose group or other
//   entries hold a bit the directory's current default ACL does not (none:
//   no bits), as its chmod refuses `o+w`; narrowing, removing it
//   (`setfacl -k`) and the owner entry stay free;
// - what it creates grants others no write, whatever its process umask:
//   creation masks other-write as it masks setuid/setgid.
// Both of Kinu's spellings: `setfacl -d -m u::rwx,g::rwx,o::rwx dir && touch
// dir/f`, and `setfacl -k dir && umask 000 && touch dir/f` (or a directory
// made with umask 000 in /tmp and moved in). An unconfined principal keeps
// every one of these.
import assert from 'node:assert/strict';

import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const VIEWER = Object.freeze({ uid: 2000, gid: 2000, groups: Object.freeze([2000, 1001]), umask: 0o077 });
const PLAIN = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000, 1001]), umask: 0o022 });

const harness = createSqliteVfsTestHarness();
const raw = new SqliteVFS(harness.sql, harness.ctx);
const root = raw.as(CRED_KERNEL);
root.mkdir('tmp', { mode: 0o1777 });
root.chmod('tmp', 0o1777);
root.mkdir('var/agents/viewer/tmp', { recursive: true, mode: 0o700 });
root.chown('var/agents/viewer/tmp', VIEWER.uid, VIEWER.gid);
// The owner's project: setgid to the project group, a group-rwx default ACL.
root.mkdir('home/main', { recursive: true, mode: 0o2775 });
root.chown('home/main', 1000, 1001);
root.chmod('home/main', 0o2775);
root.setDefaultAcl('home/main', 0o775);
raw.confinePrincipal(VIEWER.uid, 'var/agents/viewer/tmp');

const failures = [];
const check = (name, body) => {
  try {
    body();
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
};
const modeOf = (fs, path) => fs.stat(path).mode & 0o7777;
const refused = (body) => {
  try {
    body();
  } catch (error) {
    return error.code;
  }
  return 'allowed';
};

for (const [who, cred, confined] of [['viewer', VIEWER, true], ['owner', PLAIN, false]]) {
  const fs = raw.as(cred);
  const dir = `home/main/opened-${who}`;
  fs.mkdir(dir);

  check(`${who}: a default ACL that grants others write`, () => {
    // The directory inherited the project's 0775: o+w is a bit it does not hold.
    assert.equal(refused(() => fs.setDefaultAcl(dir, 0o777)), confined ? 'EPERM' : 'allowed');
    if (confined) {
      assert.equal(fs.getDefaultAcl(dir), 0o775, 'refused, not clamped: the ACL is as it was');
      fs.writeFile(`${dir}/f`, 'x', { mode: 0o666 });
      assert.equal(modeOf(fs, `${dir}/f`) & 0o002, 0, 'nothing made beneath it is other-writable');
    }
  });

  check(`${who}: narrowing, the owner entry, and setfacl -k`, () => {
    assert.equal(refused(() => fs.setDefaultAcl(dir, 0o755)), 'allowed', 'narrowing');
    assert.equal(refused(() => fs.setDefaultAcl(dir, 0o355)), 'allowed', 'the owner entry moves freely');
    assert.equal(refused(() => fs.setDefaultAcl(dir, 0o375)), confined ? 'EPERM' : 'allowed', 'widening back past what it narrowed to');
    assert.equal(refused(() => fs.setDefaultAcl(dir, null)), 'allowed', 'setfacl -k');
    // With none, any group or other bit is a widening.
    assert.equal(refused(() => fs.setDefaultAcl(dir, 0o700)), 'allowed');
    assert.equal(refused(() => fs.setDefaultAcl(dir, null)), 'allowed');
    assert.equal(refused(() => fs.setDefaultAcl(dir, 0o750)), confined ? 'EPERM' : 'allowed', 'none held: no bits');
  });

  check(`${who}: setfacl -k, umask 000, and a new file`, () => {
    const bare = `home/main/bare-${who}`;
    fs.mkdir(bare);
    fs.setDefaultAcl(bare, null);
    const loose = raw.as({ ...cred, umask: 0 });
    loose.writeFile(`${bare}/f`, 'x', { mode: 0o666 });
    assert.equal(modeOf(fs, `${bare}/f`), confined ? 0o664 : 0o666);
    loose.mkdir(`${bare}/d`, { mode: 0o777 });
    assert.equal(modeOf(fs, `${bare}/d`) & 0o777, confined ? 0o775 : 0o777);
  });

  check(`${who}: made with umask 000 elsewhere, then moved in`, () => {
    const loose = raw.as({ ...cred, umask: 0 });
    loose.mkdir(`tmp/d-${who}`, { mode: 0o777 });
    loose.writeFile(`tmp/d-${who}/f`, 'x', { mode: 0o666 });
    loose.rename(`tmp/d-${who}`, `home/main/moved-${who}`);
    assert.equal(modeOf(fs, `home/main/moved-${who}/f`), confined ? 0o664 : 0o666);
  });
}

assert.deepEqual(failures, []);
console.log('confined-default-acl: a confined principal grants others nothing through a default ACL or its umask');
