#!/usr/bin/env bun
/**
 * wasi-nimbus-fs — the Nimbus filesystem extension (import module nimbus_fs,
 * core runtime/wasi/types.ts NimbusFsImports) through the real WASI body and
 * the resident filesystem, over a session filesystem:
 *
 *   - path_stat answers what preview1's filestat leaves out: st_mode with its
 *     type and permission bits, uid and gid; lstat sees a link, stat its
 *     target, and the preview1 part is path_filestat_get's;
 *   - fd_stat answers a file's descriptor and stdout (a character device;
 *     a pipe's, a FIFO, is wasi-processes.mjs's);
 *   - path_chmod changes the session's mode, and the next stat sees it;
 *     without SYMLINK_FOLLOW it is ENOTSUP, as Linux has no lchmod;
 *   - fd_chmod changes a writable descriptor's file.
 */

import assert from 'node:assert/strict';
import { residentGuest, USER } from './lib/wasi-resident-guest.mjs';

const PREOPEN_FD = 3;
const E = { SUCCESS: 0, NOTSUP: 58 };
const S_IFREG = 0o100000, S_IFDIR = 0o040000, S_IFLNK = 0o120000, S_IFCHR = 0o020000;
const enc = new TextEncoder();

const guest = await residentGuest();
const { kernel, fsImport, wasiImport, memory } = guest;
const view = () => new DataView(memory.buffer);
const PATH = 8192, OUT = 9216, FILESTAT = 10240;
const putPath = (name) => { const b = enc.encode(name); new Uint8Array(memory.buffer).set(b, PATH); return b.length; };
const decode = (at) => ({
  dev: view().getBigUint64(at, true), ino: view().getBigUint64(at + 8, true), filetype: view().getUint8(at + 16),
  size: Number(view().getBigUint64(at + 32, true)), mode: view().getUint32(at + 64, true),
  uid: view().getUint32(at + 68, true), gid: view().getUint32(at + 72, true),
});
const pathStat = async (name, follow = true) => {
  const errno = await fsImport.path_stat(PREOPEN_FD, follow ? 1 : 0, PATH, putPath(name), OUT);
  return errno === E.SUCCESS ? decode(OUT) : errno;
};

kernel.writeFile('home/user/tool.sh', '#!/bin/sh\n', { mode: 0o755 });
kernel.chown('home/user/tool.sh', USER.uid, USER.gid);
kernel.writeFile('home/user/notes.txt', 'notes', { mode: 0o640 });
kernel.chown('home/user/notes.txt', USER.uid, USER.gid);
kernel.symlink('tool.sh', 'home/user/link');
kernel.mkdir('home/user/dir', { mode: 0o750 });

const tool = await pathStat('home/user/tool.sh');
assert.equal(tool.mode, S_IFREG | 0o755, 'an executable: type and permission bits');
assert.equal(tool.uid, USER.uid);
assert.equal(tool.gid, USER.gid);
assert.equal(tool.size, 10);
assert.equal(await wasiImport.path_filestat_get(PREOPEN_FD, 1, PATH, putPath('home/user/tool.sh'), FILESTAT), 0);
assert.deepEqual(new Uint8Array(memory.buffer, OUT, 64), new Uint8Array(memory.buffer, FILESTAT, 64), "the first 64 bytes are path_filestat_get's");
assert.equal((await pathStat('home/user/notes.txt')).mode, S_IFREG | 0o640);
assert.equal((await pathStat('home/user/dir')).mode, S_IFDIR | 0o750);
assert.equal((await pathStat('home/user/link', false)).mode & 0o170000, S_IFLNK, 'lstat sees the link');
assert.equal((await pathStat('home/user/link', true)).mode, S_IFREG | 0o755, 'stat its target');
assert.equal(await pathStat('home/user/absent'), 44);

const fd = await guest.open('home/user/notes.txt', { write: true });
assert.equal(await fsImport.fd_stat(fd, OUT), 0);
assert.equal(decode(OUT).mode, S_IFREG | 0o640, "a file's descriptor");
assert.equal(await fsImport.fd_chmod(fd, 0o600), 0);
assert.equal(kernel.stat('home/user/notes.txt').mode & 0o7777, 0o600, 'fd_chmod changes the file');
await guest.close(fd);

assert.equal(await fsImport.fd_stat(1, OUT), 0);
assert.equal(decode(OUT).mode & 0o170000, S_IFCHR, 'stdout is a character device');

assert.equal(await fsImport.path_chmod(PREOPEN_FD, 1, PATH, putPath('home/user/notes.txt'), S_IFREG | 0o751), 0);
assert.equal(kernel.stat('home/user/notes.txt').mode & 0o7777, 0o751, 'chmod reaches the session, type bits dropped');
assert.equal((await pathStat('home/user/notes.txt')).mode, S_IFREG | 0o751, 'and the next stat sees it');
assert.equal(await fsImport.path_chmod(PREOPEN_FD, 0, PATH, putPath('home/user/link'), 0o700), E.NOTSUP, 'no lchmod');

await guest.dispose();
console.log('wasi-nimbus-fs: ok');
