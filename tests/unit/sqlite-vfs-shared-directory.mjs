#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
const A = { uid: 2000, gid: 2000, groups: [2000, 1000], umask: 0o022 };
const B = { uid: 2001, gid: 2001, groups: [2001, 1000], umask: 0o022 };
const h = createSqliteVfsTestHarness();
const v = new SqliteVFS(h.sql, h.ctx, undefined, { inodeCacheEntries: 2 });
const k = v.as(CRED_KERNEL), a = v.as(A), b = v.as(B);
const mode = p => k.stat(p).mode & 0o7777;
try {
  k.mkdir('team'); k.chown('team', 0, 1000); k.chmod('team', 0o3775); k.setDefaultAcl('team', 0o775);
  k.mkdir('private/draft', { recursive: true });
  for (const p of ['private','private/draft']) k.chown(p, A.uid, A.gid);
  v.confinePrincipal(A.uid, 'tmp/a');
  const dispose = v.registerSharedDirectory('team');
  assert.throws(() => v.registerSharedDirectory('team'), { code: 'EBUSY' });
  a.mkdir('team/site', { mode: 0o755 }); a.writeFile('team/site/f', 'one', { mode: 0o644 });
  assert.equal(mode('team/site'), 0o2775); assert.equal(mode('team/site/f'), 0o664);
  b.writeFile('team/site/f', 'two');
  a.chmod('team/site', 0o555); assert.equal(mode('team/site'), 0o2555);
  a.chmod('team/site', 0o755); assert.equal(mode('team/site'), 0o2775);
  assert.throws(() => b.chmod('team/site/f', 0o600), { code: 'EPERM' });
  assert.throws(() => a.chmod('team/site/f', 0o777), { code: 'EPERM' });
  a.writeFile('private/draft/f', 'bytes'); const ino = a.stat('private/draft/f').ino;
  a.rename('private/draft', 'team/draft');
  assert.equal(mode('team/draft'), 0o2775); assert.equal(mode('team/draft/f'), 0o664);
  assert.equal(a.stat('team/draft/f').ino, ino); assert.equal(a.stat('team/draft/f').gid, 1000);
  b.writeFile('team/draft/f', 'shared');
  dispose(); const next = v.registerSharedDirectory('team'); dispose();
  a.chmod('team/draft', 0o755); assert.equal(mode('team/draft'), 0o2775);
  next(); a.chmod('team/draft', 0o755); assert.equal(mode('team/draft'), 0o755);
  a.chmod('team/site/f', 0o600); assert.equal(mode('team/site/f'), 0o600);
  console.log('sqlite-vfs-shared-directory: creation, chmod, adoption, disposal and POSIX controls pass');
} finally { h.db.close(); }

function fixture(body) {
  const h = createSqliteVfsTestHarness();
  const v = new SqliteVFS(h.sql, h.ctx, undefined, { inodeCacheEntries: 2 });
  const k = v.as(CRED_KERNEL), a = v.as(A), b = v.as(B);
  k.mkdir('team'); k.chown('team', 0, 1000); k.chmod('team', 0o3775); k.setDefaultAcl('team', 0o775);
  k.mkdir('private'); k.chown('private', A.uid, A.gid);
  v.confinePrincipal(A.uid, 'tmp/a');
  const mode = p => k.stat(p).mode & 0o7777;
  try { body({ h, v, k, a, b, mode }); } finally { h.db.close(); }
}

fixture(({ v, k, a, mode }) => {
  v.registerSharedDirectory('team');
  k.mkdir('team/nested'); k.chmod('team/nested', 0o2775); k.setDefaultAcl('team/nested', 0o775);
  assert.throws(() => v.registerSharedDirectory('team/nested'), { code: 'EBUSY' });
  a.mkdir('team/d'); a.writeFile('team/d/f', 'fd');
  const fd = v.openDescription('team/d/f', A, { read: true, write: true });
  k.chmod('team/d', 0o000);
  fd.chmod(0o700); assert.equal(fd.stat().mode & 0o7777, 0o770);
  assert.throws(() => a.chmod('team/d/f', 0o700), { code: 'EACCES' });
  k.chmod('team/d', 0o755);
  const lease = v.acquireExclusiveMutation('team/d');
  assert.throws(() => fd.chmod(0o600), { code: 'EBUSY' }); v.releaseExclusiveMutation(lease.owner);
  a.rename('team/d/f', 'private/moved'); fd.chmod(0o600); assert.equal(mode('private/moved'), 0o600);
  a.unlink('private/moved'); assert.throws(() => fd.chmod(0o660), { code: 'EPERM' }); fd.close();
});

fixture(({ v, k, a, mode }) => {
  v.registerSharedDirectory('team');
  a.mkdir('team/d');
  const outsider = v.as({ ...A, groups: [A.gid] });
  assert.throws(() => outsider.chmod('team/d', 0o755), { code: 'EPERM' });
  assert.throws(() => a.chmod('team', 0o755), { code: 'EPERM' });
  assert.throws(() => a.setDefaultAcl('team', null), { code: 'EPERM' });
  a.chmod('team/d', 0o755); assert.equal(mode('team/d'), 0o2775);
  a.writeFile('private/secret', 'private'); a.chmod('private/secret', 0o600);
  a.symlink('/private/secret', 'team/link');
  assert.throws(() => a.chmod('team/link', 0o660), { code: 'EPERM' });
  assert.equal(mode('private/secret'), 0o600);
});

for (const revoke of [
  k => k.chmod('team', 0o775),
  k => k.chown('team', 0, 2000),
  k => k.chown('team', A.uid, 1000),
  k => k.setDefaultAcl('team', 0o750),
]) fixture(({ v, k, a, mode }) => {
  v.snapshot('before'); v.registerSharedDirectory('team'); revoke(k);
  v.restore('before');
  a.mkdir('team/d', { mode: 0o755 }); a.chmod('team/d', 0o755);
  assert.equal(mode('team/d'), 0o755, 'restore must not resurrect the registration');
});

fixture(({ v, k, a, mode }) => {
  v.registerSharedDirectory('team'); k.rename('team', 'moved'); k.rename('moved', 'team');
  a.mkdir('team/d'); a.chmod('team/d', 0o755); assert.equal(mode('team/d'), 0o755);
  k.removeRecursive('team'); k.mkdir('team'); k.chown('team',0,1000); k.chmod('team',0o3775); k.setDefaultAcl('team',0o775);
  a.mkdir('team/e'); a.chmod('team/e',0o755); assert.equal(mode('team/e'),0o755);
});

fixture(({ h, v, k, a, b, mode }) => {
  a.mkdir('private/draft'); a.writeFile('private/draft/own', 'own');
  k.writeFile('private/draft/foreign', 'private'); k.chown('private/draft/foreign', B.uid, B.gid); k.chmod('private/draft/foreign',0o600);
  v.registerSharedDirectory('team');
  assert.throws(() => a.rename('private/draft','team/draft'), {code:'EPERM'});
  assert.equal(k.exists('team/draft'),false); assert.equal(k.readFileString('private/draft/own'),'own');
  k.unlink('private/draft/foreign'); a.symlink('/private/missing','private/draft/link');
  v.snapshot('old'); const ino=a.stat('private/draft/own').ino;
  a.rename('private/draft','team/draft');
  assert.equal(k.readlink('team/draft/link'),'/private/missing'); assert.equal(k.exists('private/missing'),false);
  assert.equal(a.stat('team/draft/own').ino,ino); assert.equal(v.at('old').readFileString('private/draft/own'),'own');
  assert.throws(()=>b.rename('team/draft','team/stolen'),{code:'EPERM'});
  assert.throws(()=>b.removeRecursive('team/draft'),{code:'EPERM'});
  k.chmod('team/draft',0o755); assert.equal(mode('team/draft'),0o2775);
  h.failOnTransactionStatement(1);
  assert.throws(()=>k.chmod('team',0o755)); h.clearFault();
  assert.equal(mode('team'),0o3775);
  a.chmod('team/draft',0o755); assert.equal(mode('team/draft'),0o755,'authorized failed root publication conservatively revokes');
});

fixture(({ v, k, a, mode }) => {
  a.mkdir('team/legacy',{mode:0o755}); a.writeFile('team/legacy/f','old',{mode:0o644});
  v.snapshot('old'); v.registerSharedDirectory('team');
  a.chmod('team/legacy',0o700); a.writeFile('team/legacy/f','new');
  v.restore('old',{subtree:'team/legacy'});
  assert.equal(mode('team/legacy'),0o2775); assert.equal(mode('team/legacy/f'),0o664);
  assert.equal(a.readFileString('team/legacy/f'),'old'); assert.equal(v.at('old').stat('team/legacy').mode&0o7777,0o2755);
  a.copyTree('team/legacy','team/copied',{preserve:true});
  assert.equal(mode('team/copied'),0o2775); assert.equal(mode('team/copied/f'),0o664);
});

fixture(({ v, k, a, mode }) => {
  const sourceHarness=createSqliteVfsTestHarness();
  try {
    const source=new SqliteVFS(sourceHarness.sql,sourceHarness.ctx),root=source.as(CRED_KERNEL);
    root.mkdir('tree');root.writeFile('tree/f','payload');source.snapshot('snap');
    v.registerSharedDirectory('team');
    let cursor=null;
    do {
      const page=source.exportPage({at:'snap',root:'tree',after:cursor,limit:1});
      const chunks=source.exportChunks(v.wantChunks(page)).chunks;
      const result=v.importPage('team/imported',page,chunks);
      assert.deepEqual(result.want,[]);
      assert.deepEqual(v.importPage('team/imported',page,chunks).want,[],'same-page replay validates normalized metadata');
      cursor=page.next;
    } while(cursor!==null);
    assert.equal(mode('team/imported'),0o2775); assert.equal(mode('team/imported/f'),0o664);
    assert.equal(k.readFileString('team/imported/f'),'payload');
  } finally {sourceHarness.db.close();}
});
console.log('sqlite-vfs-shared-directory: descriptor, lifecycle, adoption, restore/import and security regressions pass');


fixture(({ h, v, k, a, b, mode }) => {
  v.registerSharedDirectory('team');
  a.mkdir('private/many');
  for (let i=0;i<280;i++) a.writeFile('private/many/f'+i,'same');
  const key=a.contentKey('private/many/f0');
  k.chown('private/many/f279',B.uid,B.gid);
  assert.throws(()=>a.rename('private/many','team/many'),{code:'EPERM'});
  assert.equal(k.exists('team/many'),false); assert.equal(a.readdir('private/many').length,280);
  k.chown('private/many/f279',A.uid,A.gid);
  a.rename('private/many','team/many');
  assert.equal(a.readdir('team/many').length,280); assert.equal(a.contentKey('team/many/f0'),key);
  assert.equal(mode('team/many/f279'),0o664);
  const lease=v.acquireExclusiveMutation('team'); const owned=v.as(A,{mutationOwner:lease.owner});
  let callback;
  const stop=v.events.onPath('team/trigger',()=>{try{a.chmod('team/many/f0',0o600);}catch(e){callback=e.code;}});
  owned.writeFile('team/trigger','event');assert.equal(callback,'EBUSY');stop();v.releaseExclusiveMutation(lease.owner);
  a.chmod('team/many/f0',0o600);assert.equal(mode('team/many/f0'),0o660);
  const reopened=new SqliteVFS(h.sql,h.ctx);reopened.confinePrincipal(A.uid,'tmp/a');
  reopened.as(A).chmod('team/many/f0',0o600);assert.equal(reopened.as(CRED_KERNEL).stat('team/many/f0').mode&0o7777,0o600);
});
fixture(({ v, k, a, mode }) => {
  k.mkdir('outer'); k.rename('team','outer/team'); v.registerSharedDirectory('outer/team');
  k.rename('outer','elsewhere'); k.rename('elsewhere','outer');
  a.mkdir('outer/team/d');a.chmod('outer/team/d',0o755);assert.equal(mode('outer/team/d'),0o755);
  v.registerSharedDirectory('outer/team');v.rotateIncarnation();a.chmod('outer/team/d',0o755);assert.equal(mode('outer/team/d'),0o755);
});


fixture(({ h, v, k, a, mode }) => {
  a.mkdir('private/big');
  for(let i=0;i<450;i++) a.writeFile('private/big/f'+i,'retained');
  v.snapshot('prior'); v.registerSharedDirectory('team');
  h.failOnTransactionStatement(1,{transaction:h.transactionCount+2});
  assert.throws(()=>a.rename('private/big','team/big'));h.clearFault();
  assert.equal(k.exists('team/big'),false);assert.equal(a.readdir('private/big').length,450);
  assert.equal(mode('private/big/f449'),0o644);assert.equal(v.at('prior').readFileString('private/big/f449'),'retained');
  a.rename('private/big','team/big');assert.equal(mode('team/big/f449'),0o664);
});
fixture(({ v, k, a, mode }) => {
  a.mkdir('team/existing'); a.writeFile('team/existing/f','original'); k.chmod('team/existing/f',0o640);
  v.registerSharedDirectory('team'); a.writeFile('team/existing/f','updated');
  assert.equal(mode('team/existing/f'),0o640,'content writes do not implicitly normalize metadata');
  const lease=v.acquireExclusiveMutation('team');
  assert.throws(()=>k.chmod('team',0o755),{code:'EBUSY'});v.releaseExclusiveMutation(lease.owner);
  a.chmod('team/existing',0o755);assert.equal(mode('team/existing'),0o2775,'failed lease check did not revoke');
});
console.log('sqlite-vfs-shared-directory: bounded rename fault and nondelegating content writes pass');


for (const [label, cred, member] of [
  ['primary', { ...A, gid: 1000, groups: [] }, true],
  ['supplementary', { ...A, groups: [1000] }, true],
  ['nonmember', { ...A, groups: [] }, false],
]) fixture(({ v, k, mode }) => {
  const user = v.as(cred);
  k.chmod('team', 0o3777);
  k.mkdir('team/owned'); k.chown('team/owned', A.uid, 1000);
  k.chmod('team/owned', 0o2775);
  user.mkdir('private/source'); user.writeFile('private/source/f', 'body');
  v.registerSharedDirectory('team');
  const operations = [
    () => user.mkdir('team/new', { mode: 0o755 }),
    () => user.chmod('team/owned', 0o755),
    () => user.copyTree('private/source', 'team/copy'),
    () => user.rename('private/source', 'team/moved'),
  ];
  for (const operation of operations) {
    if (member) operation();
    else assert.throws(operation, { code: 'EPERM' }, label);
  }
  if (member) {
    for (const path of ['team/new', 'team/owned', 'team/copy', 'team/moved']) {
      assert.equal(mode(path), 0o2775, label + ': ' + path);
      assert.equal(k.stat(path).gid, 1000, label + ': shared gid');
    }
    assert.equal(user.readFileString('team/copy/f'), 'body');
    assert.equal(user.readFileString('team/moved/f'), 'body');
  } else {
    for (const path of ['team/new', 'team/copy', 'team/moved']) assert.equal(k.exists(path), false);
    assert.equal(user.readFileString('private/source/f'), 'body');
  }
});
console.log('sqlite-vfs-shared-directory: primary and supplementary group membership agree');

