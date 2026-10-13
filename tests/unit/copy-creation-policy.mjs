#!/usr/bin/env bun
// A copy makes its entries as any creation there makes them.
//
// Across filesystems (a mounted side), a process's copyFile goes through the
// namespace's one copy: the new file has the source's mode less the umask,
// as cp makes it, and a link named as the source is followed, as copyFile(2)
// follows it, on a mount answered synchronously and on one that only
// awaits. A tree copied off an awaiting mount answers how many entries it
// made. Before, the bridge wrote the bytes with no mode (0644 for a 0755 or
// a 0600 file), the awaiting path copied a link as a link, and a tree
// copied off an awaiting mount answered 0.
//
// A tree copied by reference on SQLite, without preserve, is made as mkdir
// and writeFile make entries there (creationAttrs): a setgid parent's group,
// setgid directories, and a parent's default ACL in place of the umask,
// inherited by each new directory. Before, it took the caller's group, the
// umask, and the source's default ACL.
import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { testBox } from './lib/test-box.mjs';
import { asyncOnly } from './lib/async-memory-vfs.mjs';

const perms = (stat) => (stat.mode & 0o7777).toString(8);
const enc = new TextEncoder();
const text = (bytes) => new TextDecoder().decode(bytes);
const USER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(['ok', name]); } catch (error) { results.push(['FAIL', name, String(error.message).split('\n')[0]]); }
};

// ── a process's copyFile across filesystems ──────────────────────────────
{
  const s = new MemoryVFS({ uid: 1000, gid: 1000 });
  const m = new MemoryVFS({ uid: 1000, gid: 1000 });
  for (const vfs of [s, m]) {
    vfs.writeFile('/run.sh', enc.encode('#!/bin/sh\n'), { mode: 0o755 });
    vfs.writeFile('/secret', enc.encode('key'), { mode: 0o600 });
    vfs.symlink('run.sh', '/link');
    vfs.mkdir('/tree');
    vfs.writeFile('/tree/a', enc.encode('a'), { mode: 0o644 });
    vfs.mkdir('/tree/sub');
    vfs.writeFile('/tree/sub/b', enc.encode('b'), { mode: 0o644 });
  }
  const box = await testBox({ mounts: { '/s': s, '/m': asyncOnly(m, { deep: true }) } });
  box.root.mkdir('home/user', { recursive: true });
  box.root.chown('home/user', 1000, 1000);
  box.root.writeFile('home/user/tool', 'tool');
  box.root.chown('home/user/tool', 1000, 1000);
  box.root.chmod('home/user/tool', 0o750);
  const fs = box.workspace.filesystem.bind({ pid: 81, cred: USER });
  const kept = async (point) => {
    await fs.copyFile(`${point}/run.sh`, `/home/user/run${point.slice(1)}.sh`);
    await fs.copyFile(`${point}/secret`, `/home/user/secret${point.slice(1)}`);
    await fs.copyFile(`${point}/link`, `/home/user/link${point.slice(1)}`);
    const linked = box.root.lstat(`home/user/link${point.slice(1)}`);
    return [
      perms(box.root.stat(`home/user/run${point.slice(1)}.sh`)),
      perms(box.root.stat(`home/user/secret${point.slice(1)}`)),
      linked.type, perms(linked), box.root.readFileString(`home/user/link${point.slice(1)}`),
    ];
  };
  await check('off a synchronous mount: the source\'s mode less the umask, and a link followed', async () =>
    assert.deepEqual(await kept('/s'), ['755', '600', 'file', '755', '#!/bin/sh\n']));
  await check('off an awaiting mount, the same', async () =>
    assert.deepEqual(await kept('/m'), ['755', '600', 'file', '755', '#!/bin/sh\n']));
  await check('onto a mount: the source\'s mode', async () => {
    await fs.copyFile('/home/user/tool', '/s/tool');
    assert.equal(perms(s.stat('/tool')), '750');
  });
  await check('a tree off an awaiting mount answers the entries it made', async () => {
    assert.equal(await fs.copyTree('/m/tree', '/home/user/tree'), 4);
    assert.equal(text(box.root.readFile('home/user/tree/sub/b')), 'b');
  });
  box.destroy();
}

// ── a reference tree copy on SQLite, without preserve ────────────────────
const ADA = { uid: 2000, gid: 2000, groups: [2000, 1000], umask: 0o022 };
function engine() {
  const harness = createSqliteVfsTestHarness();
  const raw = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = raw.as(CRED_KERNEL);
  kernel.mkdir('home/ada/src/sub', { recursive: true });
  for (const dir of ['home/ada', 'home/ada/src', 'home/ada/src/sub']) kernel.chown(dir, 2000, 2000);
  const ada = raw.as(ADA);
  ada.writeFile('home/ada/src/a.txt', 'a');
  ada.writeFile('home/ada/src/sub/b.txt', 'b');
  return { kernel, ada };
}
const made = (kernel, path) => {
  const stat = kernel.stat(path);
  return [perms(stat), stat.gid, kernel.getDefaultAcl(path)];
};

// A setgid parent: its group, and each new directory setgid, as mkdir there.
await check('a setgid parent: its group, and each new directory setgid', async () => {
  const { kernel, ada } = engine();
  kernel.mkdir('shared');
  kernel.chown('shared', 0, 1000);
  kernel.chmod('shared', 0o2775);
  ada.mkdir('shared/dir');
  ada.writeFile('shared/file', 'f');
  assert.equal(ada.copyTree('home/ada/src', 'shared/copy'), 4);
  const dir = made(kernel, 'shared/dir');
  const file = made(kernel, 'shared/file');
  assert.deepEqual(['shared/copy', 'shared/copy/sub'].map((p) => made(kernel, p)), [dir, dir], 'directories: the group, setgid');
  assert.deepEqual(['shared/copy/a.txt', 'shared/copy/sub/b.txt'].map((p) => made(kernel, p)), [file, file], 'files: the group');
  ada.copyTree('home/ada/src/a.txt', 'shared/one.txt');
  assert.deepEqual(made(kernel, 'shared/one.txt'), file, 'a file copied as a tree of one');
  // Sliced (more than one page), the same.
  for (let i = 0; i < 300; i++) ada.writeFile(`home/ada/src/sub/f${i}`, 'x');
  assert.equal(await ada.copyTreeAsync('home/ada/src', 'shared/big'), 304);
  assert.deepEqual([made(kernel, 'shared/big/sub'), made(kernel, 'shared/big/sub/f299')], [dir, file]);
});

// A default ACL on the parent replaces the umask, and each new directory inherits it.
await check('a default ACL on the parent replaces the umask, and each new directory inherits it', async () => {
  const { kernel, ada } = engine();
  kernel.mkdir('pub');
  kernel.chmod('pub', 0o777);
  kernel.setDefaultAcl('pub', 0o700);
  ada.chmod('home/ada/src', 0o777);
  ada.chmod('home/ada/src/sub', 0o777);
  ada.chmod('home/ada/src/a.txt', 0o666);
  ada.copyTree('home/ada/src', 'pub/copy');
  assert.deepEqual(made(kernel, 'pub/copy'), ['700', 2000, 0o700], 'a 0777 directory is made 0700, the ACL with it');
  assert.deepEqual(made(kernel, 'pub/copy/sub'), ['700', 2000, 0o700], 'beneath it too');
  assert.deepEqual(made(kernel, 'pub/copy/a.txt'), ['600', 2000, null], 'a 0666 file is made 0600');
  ada.mkdir('pub/copy/new', { mode: 0o777 });
  assert.deepEqual(made(kernel, 'pub/copy/new'), made(kernel, 'pub/copy/sub'), 'as mkdir makes one in the copy');
});

for (const r of results) console.error(r.join('  '));
if (results.some((r) => r[0] === 'FAIL')) process.exit(1);
console.log('copy-creation-policy: ok');
