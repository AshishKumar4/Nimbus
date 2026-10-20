#!/usr/bin/env bun
// ProcessView.scan answers what a walk by name answers: each directory the
// caller may read lists the names the scan gives under it, each entry's
// lstat is the scan's, and each directory the walk cannot list (one the
// caller may not read or search, one on a mount the scan does not list) is
// marked byName for the caller to ask by name. On a tree with each case: an
// unreadable directory, a search-only and a read-only one, links to a file
// and a directory, empty and deep directories, names that sort across '/',
// a mount, and a delegation whose holder has not sent what it decided.

import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const USER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
const kernel = ws.vfs.as(CRED_KERNEL);
const user = ws.vfs.as(USER);
kernel.mkdir('home/user/w', { recursive: true });
kernel.chown('home/user', 1000, 1000);
kernel.chown('home/user/w', 1000, 1000);
const w = 'home/user/w';
for (const name of ['a-b', 'a/b', 'a.b', 'a0', 'a/c/d/e', 'deep/1/2/3/4/f']) {
  user.mkdir(`${w}/${name.slice(0, name.lastIndexOf('/'))}`, { recursive: true });
  user.writeFile(`${w}/${name}`, name);
}
user.mkdir(`${w}/empty`);
user.symlink('a0', `${w}/to-file`);
user.symlink('a', `${w}/to-dir`);
for (const [dir, mode] of [['shut', 0o000], ['search-only', 0o100], ['read-only', 0o400], ['open', 0o755]]) {
  user.mkdir(`${w}/${dir}/in`, { recursive: true });
  user.writeFile(`${w}/${dir}/in/f`, dir);
  user.chmod(`${w}/${dir}`, mode);
}
// A root-owned directory the user may enter and read but not change.
kernel.mkdir(`${w}/roots`);
kernel.writeFile(`${w}/roots/r`, 'root');

// A mount under the tree.
const backing = new MemoryVFS({ uid: 1000, gid: 1000 });
await backing.mkdir('/sub', { recursive: true });
await backing.writeFile('/sub/m', 'mounted');
ws.filesystem.vfs.mount(`/${w}/mnt`, backing);

// A delegation under the tree, its holder's decided writes not yet sent.
const pending = new Map([[`${w}/held/new`, 'decided']]);
kernel.mkdir(`${w}/held`);
kernel.chown(`${w}/held`, 1000, 1000);
let owned = null;
const lease = ws.vfs.acquireExclusiveMutation(`${w}/held`, {
  delegation: {
    reads: true,
    async recall() {
      for (const [path, text] of pending) owned.writeFile(path, text);
      pending.clear();
    },
  },
});
owned = ws.vfs.as(CRED_KERNEL, { mutationOwner: lease.owner });

const view = ws.filesystem.view({ pid: 900, cred: USER });
const root = `/${w}`;

const scanned = { stats: new Map(), listings: new Map([['', []]]), byName: new Set() };
for await (const entry of view.scan(root)) {
  const cut = entry.path.lastIndexOf('/');
  const dir = cut < 0 ? '' : entry.path.slice(0, cut);
  if ([...scanned.byName].some((marked) => dir === marked || dir.startsWith(`${marked}/`))) continue;
  scanned.listings.get(dir)?.push(entry.path.slice(cut + 1));
  scanned.stats.set(entry.path, entry.stat);
  if (entry.stat.type === 'directory') {
    if (entry.byName) scanned.byName.add(entry.path);
    else scanned.listings.set(entry.path, []);
  }
}

assert.deepEqual(pending.size, 0, 'the scan recalled the delegation, as an lstat in it does');

// The walk by name: each directory listed, each entry lstat'd; a directory it cannot list, noted.
const byNameWalk = { stats: new Map(), listings: new Map(), refused: new Set() };
const walk = async (dir) => {
  let names;
  try { names = (await view.readdir(dir === '' ? root : `${root}/${dir}`)).map((entry) => entry.name).sort(); }
  catch (error) { if (error.code === 'EACCES') { byNameWalk.refused.add(dir); return; } throw error; }
  byNameWalk.listings.set(dir, names);
  for (const name of names) {
    const path = dir === '' ? name : `${dir}/${name}`;
    let st;
    try { st = await view.stat(`${root}/${path}`, { follow: false }); }
    catch (error) { if (error.code === 'EACCES') continue; throw error; }
    byNameWalk.stats.set(path, st);
    if (st.type === 'directory') await walk(path);
  }
};
await walk('');

assert.ok(byNameWalk.stats.has('held/new') && scanned.stats.has('held/new'), 'what the holder decided is seen by both');
for (const dir of byNameWalk.refused) assert.ok(scanned.byName.has(dir), `${dir}: refused to a walk by name, marked byName by the scan`);
assert.deepEqual([...byNameWalk.refused].sort(), ['search-only', 'shut'].sort(), 'the walk is refused the unreadable directories');
assert.ok(scanned.byName.has('read-only'), 'a directory the caller may read but not search is asked by name');
for (const [dir, names] of byNameWalk.listings) {
  if (scanned.byName.has(dir) || [...scanned.byName].some((marked) => dir.startsWith(`${marked}/`))) continue;
  assert.deepEqual([...(scanned.listings.get(dir) ?? [])].sort(), names, `${dir || '.'}: the scan's names are the listing's`);
}
const fields = (st) => ({ type: st.type, size: st.size, mode: st.mode, uid: st.uid, gid: st.gid, ino: st.ino, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs });
let compared = 0;
for (const [path, st] of byNameWalk.stats) {
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  if ([...scanned.byName].some((marked) => dir === marked || dir.startsWith(`${marked}/`))) continue;
  assert.deepEqual(fields(scanned.stats.get(path) ?? {}), fields(st), `${path}: the scan's lstat is the walk's`);
  compared++;
}
assert.ok(scanned.byName.has('mnt') || scanned.listings.get('mnt')?.includes('sub'), 'the mount is listed or asked by name');
console.log(`  ✓ the scan answers as a walk by name on ${compared} entries; asked by name: ${[...scanned.byName].sort().join(', ')}`);

// A write under a tree while it is scanned, past its first page: its pages
// are not one tree, and the scan says so. (A tree with a mount under it keeps
// no revision, and is judged by its pages': this one has none.)
{
  kernel.mkdir('home/user/big', { recursive: true });
  kernel.chown('home/user/big', 1000, 1000);
  for (let i = 0; i < 1500; i++) user.writeFile(`home/user/big/f${String(i).padStart(4, '0')}`, `${i}`);
  let wrote = false;
  const refused = (async () => {
    for await (const entry of view.scan('/home/user/big')) {
      // Committed at once, through the filesystem itself.
      if (!wrote) { wrote = true; user.writeFile('home/user/big/f0000', 'changed while scanned'); }
      void entry;
    }
  })();
  await assert.rejects(refused, (error) => error.code === 'EAGAIN', 'a scan the tree changed under is refused');
  console.log('  ✓ a tree changed while it is scanned is refused EAGAIN');
}
console.log('process-scan-parity: ok');
