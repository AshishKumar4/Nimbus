#!/usr/bin/env bun
// Many synchronous reads' fault-ins wait on a ledger that refuses.
//
// Their reservations wait in line for room (node-shims-fault-in-at-cap-many).
// The ledger grants part of what is asked, then nothing: the reservations
// that fit in what it granted land, and the rest are refused, so their reads
// stay misses. None is left waiting: the settle the exit report owes returns.

import assert from 'node:assert/strict';
import { VFS_WRITE_LEDGER_SOURCE } from '../../packages/core/src/_shared/vfs-write-ledger.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { processBridge } from './lib/process-bridge.mjs';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { SHIMS_STORE_PRELUDE, declareNamespace } from './lib/shims-namespace.mjs';

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const vfs = rawVfs.as(CRED_KERNEL);
const bridge = processBridge(rawVfs, vfs);
const enc = new TextEncoder();
const dec = new TextDecoder();

const dir = '/home/user/locales';
// zod's locales run 2 to 12 KB; sizes that differ, as theirs do.
const FILES = Object.fromEntries(Array.from({ length: 48 }, (_, i) => [`l${i}.js`, String.fromCharCode(97 + (i % 26)).repeat(2048 + ((i * 1597) % 10240))]));
vfs.mkdir(dir, { recursive: true });
for (const [name, body] of Object.entries(FILES)) vfs.writeFile(`${dir}/${name}`, enc.encode(body));

const grants = [];
const left = { taken: 0 };
const supervisor = {
  readFile: async (path) => {
    const bytes = await bridge.readFile(path);
    return bytes ? dec.decode(bytes) : null;
  },
  stat: (path) => bridge.stat(path),
  lstat: (path) => bridge.stat(path, { followSymlinks: false }),
  readdir: (path) => bridge.readdir(path),
  exists: async (path) => (await bridge.stat(path)) !== null,
  fsReadRange: (path, offset, length) => bridge.readRange(path, offset, length),
  // A session's ledger near its limit: 20000 bytes in all, after a turn.
  fsStorageGrant: async (facet, want) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    grants.push(want);
    const granted = Math.min(want, 20000 - left.taken);
    left.taken += granted;
    return { granted };
  },
};

// A process facet's store, its cap exactly what it holds: full.
const factory = new Function(
  '__vfsBundle', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";' + VFS_WRITE_LEDGER_SOURCE + '\n' + SHIMS_STORE_PRELUDE + generateShimsCode()
    + '\n;__residentSetStorage({ facet: "proc-slot-0", grant: 0 }, __supervisor);'
    + '\n;return { fs: __fsMod, cap: () => __residentStorageCap(), bytes: () => __residentDbBytes() };',
);
const statOf = (size) => ({ type: 'file', size, mode: 0o644, uid: 1000, gid: 1000 });
const metadata = { 'home/user/locales': { type: 'directory', size: 0, mode: 0o755, uid: 1000, gid: 1000 } };
for (const [name, body] of Object.entries(FILES)) metadata[`home/user/locales/${name}`] = statOf(body.length);
const { fs, cap, bytes } = (declareNamespace({ metadata, manifest: { 'home/user': ['locales'], 'home/user/locales': Object.keys(FILES) } }), factory(
  {}, {}, supervisor, { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }, dir, [], {}, `${dir}/entry.js`, dir,
));
assert.ok(bytes() >= cap(), `the store starts full (${bytes()} of ${cap()} bytes)`);

// Every read misses in the same turn, as a module's requests do.
for (const name of Object.keys(FILES)) {
  assert.throws(() => fs.readFileSync(`${dir}/${name}`, 'utf8'), { code: 'EAGAIN' }, `${name} is not held yet`);
}
const settled = await Promise.race([
  globalThis.__nimbusVfsResidencySettle().then(() => true),
  new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
]);
assert.ok(settled, 'every fault-in settles: none waits for room that will not come');

const landed = Object.keys(FILES).filter((name) => {
  try { return fs.readFileSync(`${dir}/${name}`, 'utf8') === FILES[name]; } catch { return false; }
});
assert.ok(landed.length > 0, 'the fills the grant covered landed');
assert.ok(landed.length < Object.keys(FILES).length, `the rest were refused (${landed.length} landed)`);
assert.ok(bytes() <= cap(), `and the store holds no more than it was granted (${bytes()} of ${cap()})`);
console.log('node-shims-fault-in-refused: ok');
