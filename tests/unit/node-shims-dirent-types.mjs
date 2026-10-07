// A Worker Node program's Dirent says what readdir's d_type says, for every
// type, and asks lstat where the authority's listing cannot say ('unknown',
// as a mount that cannot type its entries answers). Before, the shim knew
// only directory and symlink: an untyped directory was a file, so
// fs.promises.cp read it as one, and a device was a file too.
//
// The authority here is SQLite, with its listing passed through a mount
// that cannot type: every entry under /tmp/untyped comes back 'unknown',
// and /tmp/untyped/dev/null-like entries come back exactly typed.

import assert from 'node:assert/strict';
import { VFS_WRITE_LEDGER_SOURCE } from '../../packages/core/src/_shared/vfs-write-ledger.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { processBridge } from './lib/process-bridge.mjs';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { SHIMS_STORE_PRELUDE, listAuthority } from './lib/shims-namespace.mjs';

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const vfs = rawVfs.as(CRED_KERNEL);
const bridge = processBridge(rawVfs, rawVfs.as({ uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }));
const enc = new TextEncoder();
const dec = new TextDecoder();

const APP = '/home/user/app';
const UNTYPED = '/tmp/untyped';
const TYPED = '/tmp/typed';
vfs.mkdir(APP, { recursive: true });
vfs.writeFile(`${APP}/entry.js`, enc.encode('module.exports = 1;\n'));
for (const root of [UNTYPED, TYPED]) {
  vfs.mkdir(`${root}/sub/deeper`, { recursive: true });
  vfs.writeFile(`${root}/top.txt`, enc.encode('top\n'));
  vfs.writeFile(`${root}/sub/mid.txt`, enc.encode('mid\n'));
  vfs.writeFile(`${root}/sub/deeper/low.txt`, enc.encode('low\n'));
}
for (const path of ['/home', '/home/user', APP, `${APP}/entry.js`, '/tmp', UNTYPED, TYPED]) vfs.chown(path.slice(1), 1000, 1000);
const own = (path) => {
  for (const entry of vfs.readdir(path.slice(1))) {
    vfs.chown(`${path.slice(1)}/${entry.name}`, 1000, 1000);
    if (entry.type === 'directory') own(`${path}/${entry.name}`);
  }
};
own(UNTYPED);
own(TYPED);

/** What a mount answers for a listing: nothing typed under UNTYPED, and TYPED's files as the special types. */
const SPECIAL = { 'top.txt': 'character' };
async function listing(path) {
  const entries = await bridge.readdir(path);
  if (path === UNTYPED || path.startsWith(`${UNTYPED}/`)) return entries.map((entry) => ({ name: entry.name, type: 'unknown' }));
  if (path === TYPED) return entries.map((entry) => ({ name: entry.name, type: SPECIAL[entry.name] ?? entry.type }));
  return entries;
}

const supervisor = {
  readFile: async (path) => { const bytes = await bridge.readFile(path); return bytes ? dec.decode(bytes) : null; },
  stat: (path) => bridge.stat(path),
  lstat: (path) => bridge.stat(path, { followSymlinks: false }),
  readdir: (path) => listing(path),
  exists: async (path) => (await bridge.stat(path)) !== null,
  fsReadRange: (path, offset, length) => bridge.readRange(path, offset, length),
  fsAcquire: (epoch, cursor, options) => bridge.acquire(epoch, cursor, options),
  mkdir: (path, options) => bridge.mkdir(path, options),
  writeFile: (path, content) => bridge.writeFile(path, typeof content === 'string' ? enc.encode(content) : content),
};

listAuthority(rawVfs);
// A device, as the session lists one from /dev: a file's kind, S_IFCHR in its mode.
globalThis.__nimbusTestAuthorityListing.push(['tmp/typed/null', {
  type: 'file', size: 0, mode: 0o020666, uid: 0, gid: 0, atime: 0, mtime: 0, ctime: 0, ino: 99,
}]);
globalThis.__nimbusVfsCursor = { epoch: rawVfs.epoch, rev: rawVfs.revision() };
const factory = new Function(
  '__vfsBundle', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";' + VFS_WRITE_LEDGER_SOURCE + '\n' + SHIMS_STORE_PRELUDE + generateShimsCode() +
    '\n;return { fs: __fsMod };',
);
const { fs } = factory(
  { 'home/user/app/entry.js': 'module.exports = 1;\n' },
  {},
  supervisor,
  { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
  APP,
  [],
  {},
  `${APP}/entry.js`,
  APP,
);

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
assert.deepEqual(kinds(await fs.promises.readdir(TYPED, { withFileTypes: true })), { sub: DIRECTORY, 'top.txt': CHARACTER },
  'a character device is a character device, not a file');

// ── The synchronous listing (the launch's namespace) types a device by its mode ──
assert.equal(fs.readdirSync(TYPED, { withFileTypes: true }).find((d) => d.name === 'null')?.isCharacterDevice(), true,
  'readdirSync says a listed device is a character device');
assert.equal(fs.opendirSync(TYPED).readSync()?.name, 'null', 'opendirSync lists it');

// ── fs.promises.cp walks an untyped tree as a tree ─────────────────────────
await fs.promises.cp(UNTYPED, '/tmp/copy', { recursive: true });
assert.equal(dec.decode(await bridge.readFile('/tmp/copy/sub/deeper/low.txt')), 'low\n', 'the deepest file is copied');
assert.equal((await bridge.stat('/tmp/copy/sub'))?.type, 'directory', 'and a directory is made a directory');

process.stdout.write('node-shims-dirent-types: all tests passed\n');
