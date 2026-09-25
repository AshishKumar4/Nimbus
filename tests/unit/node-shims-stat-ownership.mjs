#!/usr/bin/env bun
// The one-shot node view (spawn-time tables, no resident store) never reports
// a stat the authority did not give. A path the staged metadata describes
// shows that owner and mode. A path it does not describe is not given the
// reader's own ownership and an invented mode: the shims used to fabricate
// both for bundle content, manifest directories and capped-out files, so a
// root-owned file read as the reader's own and writable. A file the process
// creates shows its real owner and its umask's mode.

import assert from 'node:assert/strict';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { VFS_WRITE_LEDGER_SOURCE } from '../../packages/core/src/_shared/vfs-write-ledger.ts';

const CRED = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const factory = new Function(
  '__vfsBundle', '__vfsMetadata', '__vfsDirs', '__vfsManifest',
  '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";' + VFS_WRITE_LEDGER_SOURCE + '\n' + generateShimsCode() + '\n;return __fsMod;',
);

const APP = 'home/user/app';
const fs = factory(
  {
    [`${APP}/root-owned.json`]: '{"root":true}',
    [`${APP}/undescribed.json`]: '{"who":"unknown"}',
    [`${APP}/mine-already.txt`]: 'mine',
  },
  {
    [APP]: { type: 'directory', size: 0, mode: 0o40755, uid: 1000, gid: 1000 },
    [`${APP}/root-owned.json`]: { type: 'file', size: 13, mode: 0o100644, uid: 0, gid: 0 },
    [`${APP}/etc-like`]: { type: 'directory', size: 0, mode: 0o40755, uid: 0, gid: 0 },
    [`${APP}/mine-already.txt`]: { type: 'file', size: 4, mode: 0o100600, uid: 1000, gid: 1000 },
    tmp: { type: 'directory', size: 0, mode: 0o41777, uid: 0, gid: 0 },
    'tmp/theirs.txt': { type: 'file', size: 4, mode: 0o100644, uid: 1001, gid: 1001 },
  },
  {},
  {
    [APP]: ['root-owned.json', 'undescribed.json', 'etc-like', 'undescribed-dir', 'capped.bin', 'mine-already.txt'],
    tmp: ['theirs.txt', 'listed-only.txt'],
    [`${APP}/etc-like`]: [],
    [`${APP}/undescribed-dir`]: [],
  },
  null, CRED, `/${APP}`, [], {}, `/${APP}/main.js`, `/${APP}`,
);

const t = (f) => { try { return f(); } catch (e) { return `ERR:${e.code}`; } };
const own = (p) => t(() => { const s = fs.statSync(p); return { uid: s.uid, gid: s.gid, mode: (s.mode & 0o7777).toString(8) }; });
const notFabricated = (p) => {
  const got = own(p);
  assert.ok(typeof got === 'string' || got.uid !== CRED.uid,
    `${p} reads as the reader's own (${JSON.stringify(got)}) with no metadata saying so`);
};

// Described: exactly what the metadata says.
assert.deepEqual(own(`/${APP}/root-owned.json`), { uid: 0, gid: 0, mode: '644' });
assert.deepEqual(own(`/${APP}/etc-like`), { uid: 0, gid: 0, mode: '755' });

// Not described: never the reader's own.
notFabricated(`/${APP}/undescribed.json`);   // bundle content, no metadata row
notFabricated(`/${APP}/undescribed-dir`);    // manifest directory, no metadata row
notFabricated(`/${APP}/capped.bin`);         // listed in the parent, content capped out

// Not writable when the metadata says so, and nothing parked locally.
assert.equal(t(() => fs.writeFileSync(`/${APP}/root-owned.json`, 'pwned')), 'ERR:EACCES');
assert.equal(fs.readFileSync(`/${APP}/root-owned.json`, 'utf8'), '{"root":true}');
assert.deepEqual(own(`/${APP}/root-owned.json`), { uid: 0, gid: 0, mode: '644' });
assert.equal(t(() => fs.writeFileSync(`/${APP}/etc-like/new`, 'x')), 'ERR:EACCES');

// The process's own: a new file and directory are its, with its umask; a
// rewrite keeps the existing owner and mode.
fs.writeFileSync(`/${APP}/mine.txt`, 'mine');
fs.mkdirSync(`/${APP}/mine-dir`);
assert.deepEqual(own(`/${APP}/mine.txt`), { uid: 1000, gid: 1000, mode: '644' });
assert.deepEqual(own(`/${APP}/mine-dir`), { uid: 1000, gid: 1000, mode: '755' });
fs.writeFileSync(`/${APP}/mine-already.txt`, 'rewritten');
assert.deepEqual(own(`/${APP}/mine-already.txt`), { uid: 1000, gid: 1000, mode: '600' });

// Only the owner (or root) may change a mode: a local chmod of a root-owned
// file would otherwise make it read as writable and let the write through.
assert.equal(t(() => fs.chmodSync(`/${APP}/root-owned.json`, 0o777)), 'ERR:EPERM');
assert.deepEqual(own(`/${APP}/root-owned.json`), { uid: 0, gid: 0, mode: '644' });
assert.equal(t(() => fs.writeFileSync(`/${APP}/root-owned.json`, 'pwned')), 'ERR:EACCES');
fs.chmodSync(`/${APP}/mine.txt`, 0o600);
assert.deepEqual(own(`/${APP}/mine.txt`), { uid: 1000, gid: 1000, mode: '600' });

// A name a listing shows, with no record: someone's file, not a creation.
// (A writable parent, /tmp 1777, must not turn it into the reader's.)
assert.notEqual(t(() => fs.writeFileSync('/tmp/listed-only.txt', 'pwned')), undefined, 'refused, not written');
assert.notEqual(t(() => fs.readFileSync('/tmp/listed-only.txt', 'utf8')), 'pwned');
notFabricated('/tmp/listed-only.txt');
// In a sticky directory only the owner removes or replaces a file.
assert.equal(t(() => fs.unlinkSync('/tmp/theirs.txt')), 'ERR:EPERM');
assert.equal(fs.existsSync('/tmp/theirs.txt'), true, 'the refusal left the view intact');
fs.writeFileSync('/tmp/mine.txt', 'mine');
assert.equal(t(() => fs.renameSync('/tmp/mine.txt', '/tmp/theirs.txt')), 'ERR:EPERM', 'nor replaced by a rename');
assert.equal(t(() => fs.renameSync('/tmp/theirs.txt', '/tmp/stolen.txt')), 'ERR:EPERM', 'nor renamed away');
assert.equal(t(() => fs.unlinkSync('/tmp/mine.txt')), undefined, 'its own file it may remove');
// And no removal from a directory the reader cannot write.
assert.equal(t(() => fs.unlinkSync(`/${APP}/etc-like/anything`)), 'ERR:EACCES');

console.log('node-shims-stat-ownership: ok');
