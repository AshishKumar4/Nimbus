#!/usr/bin/env bun
// The process's stat never reports a stat the session did not give. A path the
// session describes shows that owner and mode. A path the session lists
// without a stat is not given the reader's own ownership and an invented mode:
// the shims used to fabricate both for bundle content, manifest directories and
// capped-out files, so a root-owned file read as the reader's own and writable.
// A file the process creates shows its real owner and its umask's mode.

import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createAuthority } from './lib/resident-body.mjs';
import { shimsOnSession } from './lib/shims-on-session.mjs';


const APP = '/home/user/app';

const authority = createAuthority();
const kernel = authority.rawVfs.as(CRED_KERNEL);
authority.kfs.mkdir(APP, { recursive: true });
kernel.writeFile(`${APP}/root-owned.json`, '{"root":true}');
kernel.chown(`${APP}/root-owned.json`, 0, 0);
kernel.mkdir(`${APP}/etc-like`, { mode: 0o755 });
kernel.chown(`${APP}/etc-like`, 0, 0);
kernel.writeFile(`${APP}/etc-like/anything`, 'root\'s');
kernel.chown(`${APP}/etc-like/anything`, 0, 0);
authority.kfs.writeFile(`${APP}/mine-already.txt`, 'mine');
authority.kfs.chmod(`${APP}/mine-already.txt`, 0o600);
// /tmp is the session's from its creation; make it what a shared, sticky /tmp is.
kernel.chmod('tmp', 0o1777);
kernel.chown('tmp', 0, 0);
kernel.writeFile('tmp/theirs.txt', 'theirs');
kernel.chown('tmp/theirs.txt', 1001, 1001);
assert.equal((await authority.peer.stat('/tmp')).mode & 0o7777, 0o1777, 'the session\'s /tmp is sticky and world-writable');

const { fs } = shimsOnSession({
  authority,
  cwd: APP,
  bundle: { [`${APP.slice(1)}/root-owned.json`]: '{"root":true}', [`${APP.slice(1)}/mine-already.txt`]: 'mine' },
});

const t = (f) => { try { return f(); } catch (e) { return `ERR:${e.code}`; } };
const own = (p) => t(() => { const s = fs.statSync(p); return { uid: s.uid, gid: s.gid, mode: (s.mode & 0o7777).toString(8) }; });

// Described: exactly what the session says.
assert.deepEqual(own(`${APP}/root-owned.json`), { uid: 0, gid: 0, mode: '644' });
assert.deepEqual(own(`${APP}/etc-like`), { uid: 0, gid: 0, mode: '755' });
const dated = fs.statSync(`${APP}/root-owned.json`);
const described = await authority.peer.stat(`${APP}/root-owned.json`);
assert.equal(dated.ino, described.ino, 'chokidar sees the inode identity the session gives');
assert.equal(dated.mtime.getTime(), described.mtime, 'and the session\'s own timestamps');

// Stat'ed from the session, never the reader's own: a file the reader cannot
// change, and one it cannot see into.
assert.equal(t(() => fs.writeFileSync(`${APP}/root-owned.json`, 'pwned')), 'ERR:EACCES');
assert.equal(fs.readFileSync(`${APP}/root-owned.json`, 'utf8'), '{"root":true}');
assert.deepEqual(own(`${APP}/root-owned.json`), { uid: 0, gid: 0, mode: '644' });
assert.equal(t(() => fs.writeFileSync(`${APP}/etc-like/new`, 'x')), 'ERR:EACCES');

// The process's own: a new file and directory are its, with its umask; a
// rewrite keeps the existing owner and mode.
fs.writeFileSync(`${APP}/mine.txt`, 'mine');
fs.mkdirSync(`${APP}/mine-dir`);
assert.deepEqual(own(`${APP}/mine.txt`), { uid: 1000, gid: 1000, mode: '644' });
assert.deepEqual(own(`${APP}/mine-dir`), { uid: 1000, gid: 1000, mode: '755' });
fs.writeFileSync(`${APP}/mine-already.txt`, 'rewritten');
assert.deepEqual(own(`${APP}/mine-already.txt`), { uid: 1000, gid: 1000, mode: '600' });

// A file the process did not write has the session's times, however often it
// is stated: a stat records no time of its own for it.
{
  const times = (path) => { const st = fs.statSync(path); return [st.mtimeMs, st.atimeMs]; };
  const paths = [`${APP}/root-owned.json`, `${APP}/etc-like`, '/tmp/theirs.txt'];
  const first = paths.map(times);
  for (let i = 0; i < 50; i++) assert.deepEqual(paths.map(times), first, 'stats of existing files answer the same times each time');
}

// Its own write has one mtime until it writes again: a watcher polling
// mtimeMs sees an unchanged file as unchanged, and a rewrite as an edit.
{
  const written = fs.statSync(`${APP}/mine.txt`).mtimeMs;
  const until = Date.now() + 5;
  while (Date.now() < until) { /* let the clock move */ }
  assert.equal(fs.statSync(`${APP}/mine.txt`).mtimeMs, written, 'stat again: the same mtime');
  fs.writeFileSync(`${APP}/mine.txt`, 'mine again');
  assert.ok(fs.statSync(`${APP}/mine.txt`).mtimeMs > written, 'a rewrite moves the mtime');
}

// Only the owner (or root) may change a mode: a local chmod of a root-owned
// file would otherwise make it read as writable and let the write through.
assert.equal(t(() => fs.chmodSync(`${APP}/root-owned.json`, 0o777)), 'ERR:EPERM');
assert.deepEqual(own(`${APP}/root-owned.json`), { uid: 0, gid: 0, mode: '644' });
assert.equal(t(() => fs.writeFileSync(`${APP}/root-owned.json`, 'pwned')), 'ERR:EACCES');
fs.chmodSync(`${APP}/mine.txt`, 0o600);
assert.deepEqual(own(`${APP}/mine.txt`), { uid: 1000, gid: 1000, mode: '600' });

// In a sticky directory only the owner removes or replaces a file.
assert.equal(t(() => fs.unlinkSync('/tmp/theirs.txt')), 'ERR:EPERM');
assert.equal(fs.existsSync('/tmp/theirs.txt'), true, 'the refusal left the view intact');
fs.writeFileSync('/tmp/mine.txt', 'mine');
assert.equal(t(() => fs.renameSync('/tmp/mine.txt', '/tmp/theirs.txt')), 'ERR:EPERM', 'nor replaced by a rename');
assert.equal(t(() => fs.renameSync('/tmp/theirs.txt', '/tmp/stolen.txt')), 'ERR:EPERM', 'nor renamed away');
assert.equal(t(() => fs.unlinkSync('/tmp/mine.txt')), undefined, 'its own file it may remove');
// And no removal from a directory the reader cannot write (of a name in it: one that is not there is ENOENT first, as Linux looks it up first).
assert.equal(t(() => fs.unlinkSync(`${APP}/etc-like/anything`)), 'ERR:EACCES');
assert.equal(t(() => fs.unlinkSync(`${APP}/etc-like/nothing`)), 'ERR:ENOENT');

console.log('node-shims-stat-ownership: ok');
