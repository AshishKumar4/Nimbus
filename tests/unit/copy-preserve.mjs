#!/usr/bin/env bun
// A copy with `preserve` is cp -p's, by every path a copy takes. GNU cp is
// the oracle: the host runs the same copies (umask 022) and the mode and
// times each leaves are compared with ours.
//   - a file on SQLite, copied natively (NimbusWorkspace.fs.copy without
//     `recursive`): its mode (no umask), its times, onto a new name and
//     onto a file there; without preserve, cp's mode and the time now;
//   - a tree between backends (the namespace's fallback copy, as an
//     awaiting mount takes it), SQLite to a mounted MemoryVFS and back: each
//     entry's mode and time, a directory's set after its entries (a
//     read-only one is still filled), and a link's target left as it was;
//   - as root, the source's owner, natively and between backends.
//
// Red before: the native file copy dropped `preserve` (the time now, the
// mode less the umask, a file there keeping its own), and the fallback
// set no time, left the umask on a SQLite destination, and made a
// read-only directory before writing into it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { testBox } from './lib/test-box.mjs';
import { asyncOnly } from './lib/async-memory-vfs.mjs';

const enc = new TextEncoder();
const perms = (mode) => (mode & 0o7777).toString(8);
const OLD = Date.UTC(2001, 1, 3, 4, 5, 6);
const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(['ok', name]); } catch (error) { results.push(['FAIL', name, String(error.message).split('\n')[0]]); }
};

// ── The oracle: GNU cp, with and without -p, umask 022 ───────────────────
const host = mkdtempSync(join(tmpdir(), 'nimbus-cp-p-'));
const sh = (script) => {
  const run = spawnSync('sh', ['-c', `umask 022 && cd '${host}' && ${script}`], { encoding: 'utf8' });
  assert.equal(run.status, 0, `host: ${script}: ${run.stderr}`);
};
const touchOld = `touch -m -d @${OLD / 1000}`;
sh(`printf src > src && chmod 751 src && ${touchOld} src && printf old > there && chmod 600 there && printf old > plain && chmod 600 plain`);
sh(`cp -p src new && cp -p src there && cp src plain && cp src fresh`);
sh(`mkdir -p tree/ro && printf a > tree/a && chmod 777 tree/a && printf b > tree/ro/b && ln -s ../../outside tree/link && printf o > outside && ${touchOld} tree/a tree/ro/b tree/ro tree && chmod 555 tree/ro && ${touchOld} tree/ro`);
sh(`cp -rp tree copied`);
const hostStat = (name) => { const stat = statSync(join(host, name)); return { mode: perms(stat.mode), mtime: Math.round(stat.mtimeMs) }; };
const want = {
  new: hostStat('new'), there: hostStat('there'), plain: hostStat('plain'), fresh: hostStat('fresh'),
  tree: hostStat('copied'), a: hostStat('copied/a'), ro: hostStat('copied/ro'), b: hostStat('copied/ro/b'),
};
assert.deepEqual([want.new, want.there], [{ mode: '751', mtime: OLD }, { mode: '751', mtime: OLD }], 'GNU cp -p keeps the mode and the time, onto a file there too');
assert.deepEqual([want.plain.mode, want.fresh.mode], ['600', '751'], 'without -p, a file there keeps its mode, a new one is the source\'s less the umask');
assert.deepEqual([want.a.mode, want.ro.mode, want.ro.mtime, want.tree.mtime], ['777', '555', OLD, OLD], 'cp -rp: every entry\'s mode and time');
// Its read-only directories are made writable again, or nothing can remove their entries.
sh('chmod -R u+w .');
rmSync(host, { recursive: true, force: true });

const ours = (stat) => ({ mode: perms(stat.mode), mtime: Math.round(stat.mtimeMs) });

// ── A file on SQLite, copied natively ────────────────────────────────────
{
  const box = await testBox();
  const fs = box.fs;
  box.root.mkdir('home/user', { recursive: true });
  box.root.chown('home/user', 1000, 1000);
  await fs.writeFile('/home/user/src', 'src');
  await fs.chmod('/home/user/src', 0o751);
  await fs.utimes('/home/user/src', OLD, OLD);
  for (const name of ['there', 'plain']) { await fs.writeFile(`/home/user/${name}`, 'old'); await fs.chmod(`/home/user/${name}`, 0o600); }
  await fs.copy('/home/user/src', '/home/user/new', { preserve: true });
  await fs.copy('/home/user/src', '/home/user/there', { preserve: true });
  await fs.copy('/home/user/src', '/home/user/plain');
  await fs.copy('/home/user/src', '/home/user/fresh');
  await check('a file, natively: cp -p\'s mode and time, onto a new name and a file there', async () => {
    assert.deepEqual(ours(await fs.stat('/home/user/new')), want.new);
    assert.deepEqual(ours(await fs.stat('/home/user/there')), want.there);
  });
  await check('without preserve, cp\'s mode, and the time now', async () => {
    assert.deepEqual([ours(await fs.stat('/home/user/plain')).mode, ours(await fs.stat('/home/user/fresh')).mode], [want.plain.mode, want.fresh.mode]);
    assert.ok((await fs.stat('/home/user/fresh')).mtimeMs > OLD, 'the time now');
  });
  await check('as root, the source\'s owner', async () => {
    box.root.writeFile('home/user/owned', 'owned');
    box.root.chown('home/user/owned', 1000, 1000);
    box.root.copyFile('home/user/owned', 'home/user/kept', { preserve: true });
    box.root.copyFile('home/user/owned', 'home/user/taken');
    const [kept, taken] = [box.root.stat('home/user/kept'), box.root.stat('home/user/taken')];
    assert.deepEqual([kept.uid, kept.gid, taken.uid, taken.gid], [1000, 1000, 0, 0]);
  });
  box.destroy();
}

// ── A tree between backends: SQLite to a mounted MemoryVFS, and back ─────
{
  const mounted = new MemoryVFS({ uid: 1000, gid: 1000 });
  const box = await testBox({ mounts: { '/m': asyncOnly(mounted, { deep: true }) } });
  const fs = box.fs;
  box.root.mkdir('home/user', { recursive: true });
  box.root.chown('home/user', 1000, 1000);
  const make = async (at) => {
    await fs.mkdir(`${at}/tree/ro`, { recursive: true });
    await fs.writeFile(`${at}/tree/a`, 'a');
    await fs.chmod(`${at}/tree/a`, 0o777);
    await fs.writeFile(`${at}/tree/ro/b`, 'b');
    await fs.writeFile(`${at}/outside`, 'o');
    await fs.symlink('../../outside', `${at}/tree/link`);
    for (const path of ['tree/a', 'tree/ro/b', 'tree/ro', 'tree']) await fs.utimes(`${at}/${path}`, OLD, OLD);
    await fs.chmod(`${at}/tree/ro`, 0o555);
    await fs.utimes(`${at}/tree/ro`, OLD, OLD);
  };
  await make('/home/user');
  const outsideBefore = (await fs.stat('/home/user/outside')).mtimeMs;
  const compare = async (at) => ({
    tree: ours(await fs.stat(`${at}/copied`)), a: ours(await fs.stat(`${at}/copied/a`)),
    ro: ours(await fs.stat(`${at}/copied/ro`)), b: ours(await fs.stat(`${at}/copied/ro/b`)),
  });
  const expected = { tree: want.tree, a: want.a, ro: want.ro, b: want.b };
  await check('SQLite to a mount: each entry\'s mode and time, a read-only directory filled', async () => {
    await fs.copy('/home/user/tree', '/m/copied', { recursive: true, preserve: true });
    const got = await compare('/m');
    // MemoryVFS keeps no access time and sets no set-id bits: the mode and mtime are cp -p's.
    assert.deepEqual(got, expected);
    assert.equal((await fs.stat('/home/user/outside')).mtimeMs, outsideBefore, 'a link\'s target is left as it was');
    assert.equal((await fs.stat('/m/copied/link', { follow: false })).type, 'symlink');
  });
  await check('a mount to SQLite: the same, no umask on the destination', async () => {
    await fs.copy('/m/copied', '/home/user/back', { recursive: true, preserve: true });
    const got = {
      tree: ours(await fs.stat('/home/user/back')), a: ours(await fs.stat('/home/user/back/a')),
      ro: ours(await fs.stat('/home/user/back/ro')), b: ours(await fs.stat('/home/user/back/ro/b')),
    };
    assert.deepEqual(got, expected);
  });
  await check('as root, between backends, the source\'s owner', async () => {
    const root = box.workspace.filesystem.bind({ pid: 90, cred: { uid: 0, gid: 0, groups: [0], umask: 0o022 } });
    await root.copyFile('/m/copied/a', '/home/user/rootcopy', { preserve: true });
    const stat = box.root.stat('home/user/rootcopy');
    assert.deepEqual([stat.uid, stat.gid, perms(stat.mode)], [1000, 1000, '777']);
  });
  box.destroy();
}

for (const [verdict, name, why] of results) console.log(`  ${verdict}  ${name}${why ? `: ${why}` : ''}`);
const failed = results.filter(([verdict]) => verdict === 'FAIL');
assert.deepEqual(failed, [], 'a preserving copy is cp -p\'s');
console.log('copy-preserve: ok');
