#!/usr/bin/env bun
// A synchronous read's fault-in lands in a store that is at its budget.
//
// A process facet's store has a storage cap the session's ledger grants, and
// a big launch fills it: nuxt dev's store sat at 23.71 of 23.72 MB. A fill
// that does not fit was refused, and only then was room asked for, without
// waiting. A synchronous read's fault-in fetches once (_faultOnce), so its
// bytes were declined and never fetched again: every late module stayed
// unreadable ("store refused cap=23720160 db=23715840", traced live on a
// throwaway, nuxt-real), and nuxt dev never served.
//
// A fault-in can wait, so it asks for the room first. And concurrent asks
// each get theirs: a caller that waited on another's ask asks again if that
// grant did not cover it, where it used to give up.

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

const dir = '/home/user/at-cap';
const FILES = { 'one.js': 'a'.repeat(12 * 1024), 'two.js': 'b'.repeat(3 * 1024), 'three.js': 'c'.repeat(40 * 1024) };
vfs.mkdir(dir, { recursive: true });
for (const [name, body] of Object.entries(FILES)) vfs.writeFile(`${dir}/${name}`, enc.encode(body));

const grants = [];
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
  // The session's ledger: it grants exactly what is asked, after a turn.
  fsStorageGrant: async (facet, want) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    grants.push(want);
    return { granted: want };
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
const metadata = { 'home/user/at-cap': { type: 'directory', size: 0, mode: 0o755, uid: 1000, gid: 1000 } };
for (const [name, body] of Object.entries(FILES)) metadata[`home/user/at-cap/${name}`] = statOf(body.length);
const { fs, cap, bytes } = (declareNamespace({ metadata, manifest: { 'home/user': ['at-cap'], 'home/user/at-cap': Object.keys(FILES) } }), factory(
  {}, {}, supervisor, { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }, dir, [], {}, `${dir}/entry.js`, dir,
));
assert.ok(bytes() >= cap(), `the store starts full (${bytes()} of ${cap()} bytes)`);

// Three reads miss together, as a module's requests do.
for (const name of Object.keys(FILES)) {
  assert.throws(() => fs.readFileSync(`${dir}/${name}`, 'utf8'), { code: 'EAGAIN' }, `${name} is not held yet`);
}
await globalThis.__nimbusVfsResidencySettle();

for (const [name, body] of Object.entries(FILES)) {
  assert.equal(fs.readFileSync(`${dir}/${name}`, 'utf8'), body, `${name}'s fault-in landed in the full store`);
}
assert.ok(grants.length >= 1, 'room was asked of the ledger');
assert.ok(bytes() <= cap(), `and the store holds no more than it was granted (${bytes()} of ${cap()})`);

console.log('node-shims-fault-in-at-cap: ok');
