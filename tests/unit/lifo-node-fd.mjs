#!/usr/bin/env bun
/**
 * The shell's built-in node (lifo node-compat/fs.ts) keeps no descriptor
 * table of its own: a descriptor is the process's, whose file, offset,
 * rights and O_APPEND are the process's descriptor table's (descriptors.ts).
 * Each case was answered otherwise by the table it kept, which mapped a
 * descriptor to a name and an offset of its own.
 */

import assert from 'node:assert/strict';
import { createFs } from '../../packages/core/src/substrate/lifo/node-compat/fs.ts';
import { synchronousFilesystem } from '../../packages/core/src/substrate/lifo/node-compat/filesystem.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { processBridge } from './lib/process-bridge.mjs';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const kernel = rawVfs.as(CRED_KERNEL);
kernel.mkdir('t', { recursive: true });
const bridge = processBridge(rawVfs, CRED_KERNEL);
const fs = createFs(synchronousFilesystem({ process: bridge })(), '/t');
const text = (path) => new TextDecoder().decode(kernel.readFile(path));

const failed = [];
const check = (name, run) => {
  try { run(); } catch (error) { failed.push(`${name}: ${String(error?.message ?? error).split('\n').slice(0, 4).join(' | ')}`); }
};
const code = (run) => { try { run(); return null; } catch (error) { return error.code; } };

check('a descriptor not open for writing refuses a write (EBADF), and one not open for reading a read', () => {
  kernel.writeFile('t/r', 'abc');
  const ro = fs.openSync('/t/r', 'r');
  assert.equal(code(() => fs.writeSync(ro, 'X')), 'EBADF');
  assert.equal(text('t/r'), 'abc');
  fs.closeSync(ro);
  const wo = fs.openSync('/t/r', 'r+');
  fs.closeSync(wo);
  const only = fs.openSync('/t/w', 'w');
  assert.equal(code(() => fs.readSync(only, Buffer.alloc(1), 0, 1, 0)), 'EBADF');
  fs.closeSync(only);
});

check('a positional write leaves the descriptor\'s offset where it was', () => {
  const fd = fs.openSync('/t/p', 'w+');
  fs.writeSync(fd, 'aaaa');
  fs.writeSync(fd, 'Z', 0);
  fs.writeSync(fd, 'b');
  fs.closeSync(fd);
  assert.equal(text('t/p'), 'Zaaab');
});

check('an O_APPEND write lands at the end as it is then', () => {
  kernel.writeFile('t/log', '12');
  const fd = fs.openSync('/t/log', 'a');
  kernel.writeFile('t/log', '12345');
  fs.writeSync(fd, '6');
  fs.closeSync(fd);
  assert.equal(text('t/log'), '123456');
});

check('O_EXCL refuses a name that is there (EEXIST)', () => {
  kernel.writeFile('t/there', 'x');
  assert.equal(code(() => fs.openSync('/t/there', 'wx')), 'EEXIST');
  assert.equal(code(() => fs.openSync('/t/there', 'ax')), 'EEXIST');
  assert.equal(text('t/there'), 'x');
});

check('O_NOFOLLOW of a link is ELOOP', () => {
  kernel.writeFile('t/target', 'x');
  kernel.symlink('/t/target', 't/link');
  assert.equal(code(() => fs.openSync('/t/link', fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)), 'ELOOP');
});

check('a descriptor holds its file across a rename and an unlink', () => {
  kernel.writeFile('t/held', 'held');
  const fd = fs.openSync('/t/held', 'r');
  kernel.rename('t/held', 't/moved');
  kernel.writeFile('t/held', 'other');
  const buffer = Buffer.alloc(4);
  assert.equal(fs.readSync(fd, buffer, 0, 4, 0), 4);
  assert.equal(buffer.toString(), 'held');
  assert.equal(fs.fstatSync(fd).ino, kernel.stat('t/moved').ino);
  fs.closeSync(fd);
});

check('ftruncate grows the file with zeros and keeps the offset', () => {
  const fd = fs.openSync('/t/grow', 'w+');
  fs.writeSync(fd, 'ab');
  fs.ftruncateSync(fd, 4);
  fs.writeSync(fd, 'c');
  fs.closeSync(fd);
  assert.deepEqual([...kernel.readFile('t/grow')], [97, 98, 99, 0]);
});

check('fs and fs/promises share the process\'s descriptors', () => {
  const fd = fs.openSync('/t/shared', 'w+');
  fs.writeSync(fd, 'shared');
  const other = createFs(synchronousFilesystem({ process: bridge })(), '/t');
  const buffer = Buffer.alloc(6);
  assert.equal(other.readSync(fd, buffer, 0, 6, 0), 6);
  assert.equal(buffer.toString(), 'shared');
  fs.closeSync(fd);
  assert.equal(code(() => other.readSync(fd, buffer, 0, 1, 0)), 'EBADF');
});

check('readFileSync of a descriptor reads from its offset', () => {
  kernel.writeFile('t/rest', 'head:tail');
  const fd = fs.openSync('/t/rest', 'r');
  fs.readSync(fd, Buffer.alloc(5), 0, 5, null);
  assert.equal(fs.readFileSync(fd, 'utf8'), 'tail');
  fs.closeSync(fd);
});

check('an unknown flag string is refused as Node refuses it', () => {
  assert.equal(code(() => fs.openSync('/t/r', 'bogus')), 'ERR_INVALID_ARG_VALUE');
  assert.equal(code(() => fs.openSync('/t/r', 'toString')), 'ERR_INVALID_ARG_VALUE', 'a name every object has is no flag string');
});

check('a positional write to an O_APPEND descriptor lands at the end and leaves its offset', () => {
  kernel.writeFile('t/a-plus', 'abc');
  const fd = fs.openSync('/t/a-plus', 'a+');
  fs.writeSync(fd, 'X', 0);
  const buffer = Buffer.alloc(1);
  assert.equal(fs.readSync(fd, buffer, 0, 1, null), 1);
  assert.equal(buffer.toString(), 'a');
  fs.closeSync(fd);
  assert.equal(text('t/a-plus'), 'abcX');
});

check('ftruncateSync of a negative length truncates to 0, as Node clamps it', () => {
  kernel.writeFile('t/clamp', 'abc');
  const fd = fs.openSync('/t/clamp', 'r+');
  fs.ftruncateSync(fd, -1);
  fs.closeSync(fd);
  assert.equal(text('t/clamp'), '');
});

check('a creat of a mode without write, by a user, writes what it made', () => {
  kernel.mkdir('u', { recursive: true });
  kernel.chown('u', 1000, 1000);
  const user = createFs(synchronousFilesystem({ process: processBridge(rawVfs, { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }) })(), '/u');
  const fd = user.openSync('/u/ro', 'wx', 0o444);
  user.writeSync(fd, 'made');
  user.closeSync(fd);
  assert.equal(text('u/ro'), 'made');
  assert.equal(code(() => user.openSync('/u/ro', 'r+')), 'EACCES', 'its mode governs a later open');
});

check('a standard stream is no descriptor of the filesystem\'s', () => {
  assert.equal(code(() => fs.fstatSync(1)), 'EBADF');
  const fd = fs.openSync('/t/r', 'r');
  assert.ok(fd > 2, `an open answers above the standard streams (${fd})`);
  fs.closeSync(fd);
});

assert.deepEqual(failed, []);
console.log('lifo-node-fd: ok');
