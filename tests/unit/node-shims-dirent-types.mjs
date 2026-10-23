#!/usr/bin/env bun
// A Worker Node program's Dirent says what readdir's d_type says, for every
// type, and asks lstat where the authority's listing cannot say ('unknown',
// as a mount that cannot type its entries answers). Before, the shim knew
// only directory and symlink: an untyped directory was a file, so
// fs.promises.cp read it as one, and a device was a file too.
//
// The authority here is SQLite. A device is not a SQLite file, so the listing
// the session gives the launch names one (a character device at /tmp/typed/null,
// and /tmp/typed/top.txt typed as one too) beside the tree.

import assert from 'node:assert/strict';
import { createAuthority } from './lib/resident-body.mjs';
import { shimsOnSession } from './lib/shims-on-session.mjs';

const APP = '/home/user/app';
const UNTYPED = '/tmp/untyped';
const TYPED = '/tmp/typed';
const authority = createAuthority();
authority.kfs.mkdir(APP, { recursive: true });
authority.kfs.writeFile(`${APP}/entry.js`, 'module.exports = 1;\n');
for (const root of [UNTYPED, TYPED]) {
  authority.kfs.mkdir(`${root}/sub/deeper`, { recursive: true });
  authority.kfs.writeFile(`${root}/top.txt`, 'top\n');
  authority.kfs.writeFile(`${root}/sub/mid.txt`, 'mid\n');
  authority.kfs.writeFile(`${root}/sub/deeper/low.txt`, 'low\n');
}

const character = (ino) => ({ type: 'file', size: 0, mode: 0o020666, uid: 0, gid: 0, atime: 0, mtime: 0, ctime: 0, ino });
const { fs } = shimsOnSession({
  authority,
  cwd: APP,
  extraListing: [['tmp/typed/null', character(99)], ['tmp/typed/top.txt', character(98)]],
});

const kinds = (dirents) => Object.fromEntries(dirents.map((d) => [d.name, [
  d.isFile(), d.isDirectory(), d.isSymbolicLink(), d.isCharacterDevice(), d.isBlockDevice(), d.isFIFO(), d.isSocket(),
].map(Number).join('')]));
const FILE = '1000000';
const DIRECTORY = '0100000';
const CHARACTER = '0001000';

// ── readdir({ withFileTypes }) and opendir: 'unknown' is asked of lstat ─────
assert.deepEqual(kinds(await fs.promises.readdir(UNTYPED, { withFileTypes: true })), { sub: DIRECTORY, 'top.txt': FILE },
  'an untyped directory is a directory, an untyped file a file');
{
  const dir = await fs.promises.opendir(`${UNTYPED}/sub`);
  const read = [];
  for await (const entry of dir) read.push(entry);
  assert.deepEqual(kinds(read), { deeper: DIRECTORY, 'mid.txt': FILE }, 'opendir types its entries the same way');
}

// ── Every exact type is its own predicate ──────────────────────────────────
// The session lists the device beside the tree, so the listing has it too, typed as one.
assert.deepEqual(kinds(await fs.promises.readdir(TYPED, { withFileTypes: true })), { null: CHARACTER, sub: DIRECTORY, 'top.txt': CHARACTER },
  'a character device is a character device, not a file');

// ── The synchronous listing (the launch's namespace) types a device by its mode ──
assert.equal(fs.readdirSync(TYPED, { withFileTypes: true }).find((d) => d.name === 'null')?.isCharacterDevice(), true,
  'readdirSync says a listed device is a character device');
assert.equal(fs.opendirSync(TYPED).readSync()?.name, 'null', 'opendirSync lists it');

// ── fs.promises.cp walks an untyped tree as a tree ─────────────────────────
await fs.promises.cp(UNTYPED, '/tmp/copy', { recursive: true });
assert.equal(await authority.peer.readFileString('/tmp/copy/sub/deeper/low.txt'), 'low\n', 'the deepest file is copied');
assert.equal((await authority.peer.stat('/tmp/copy/sub')).type, 'directory', 'and a directory is made a directory');

console.log('node-shims-dirent-types: all assertions passed');
