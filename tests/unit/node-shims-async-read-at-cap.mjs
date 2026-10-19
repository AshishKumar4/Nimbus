#!/usr/bin/env bun
// An asynchronous read of a file the store holds, with the store at its cap.
//
// An async read goes to the authority and writes its bytes through, dated at
// its cursor, so the next synchronous read is not older than what the
// program was just handed. A dev server reads its sources that way (vite's
// transform), and a big launch fills its store to the cap. The write-through
// removed the row it was replacing before asking whether the replacement
// fit; at the cap it did not, and the file the store held was gone. Tailwind
// v4's scanner reads synchronously and skips a file that is not held, so the
// first stylesheet lacked the classes App.tsx uses (vite-tailwind4-real, the
// row dropped by a fill of the same bytes 80 ms after it was read).
//
// Bytes the store already holds are its own, as text or as bytes: such a
// read only dates the row at its cursor. Bytes that differ replace it as
// before. The supervisor reads by ranges, as a session's does, so the store
// holds text a fault-in filled and the async read returns bytes.

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

const dir = '/home/user/reread';
const FILES = { 'App.tsx': 'export const App = () => <div className="text-red-500" />;\n'.repeat(40), 'main.tsx': 'import { App } from "./App";\n'.repeat(60) };
vfs.mkdir(dir, { recursive: true });
for (const [name, body] of Object.entries(FILES)) vfs.writeFile(`${dir}/${name}`, enc.encode(body));

// The session's ledger grants what is asked until the store holds the sources; then it has none left,
// and the store's allowance is what it holds.
let granting = true;
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
  fsStorageGrant: async (_facet, want) => ({ granted: granting ? want : 0 }),
};

const factory = new Function(
  '__vfsBundle', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";' + VFS_WRITE_LEDGER_SOURCE + '\n' + SHIMS_STORE_PRELUDE + generateShimsCode()
    + '\n;__resident.admission.setStorage({ facet: "proc-slot-0", grant: 0 }, __supervisor);'
    + '\n;const allow = (grant) => __resident.admission.setStorage({ facet: "proc-slot-0", grant }, __supervisor);'
    + '\n;return { fs: __fsMod, held: (path) => __resident.cells.has(path), room: () => allow(1 << 20), full: () => allow(0),'
    + ' synced: (path, text) => __resident.cells.fill(path, text, __resident.coherence.cursor().rev) };',
);
const statOf = (size) => ({ type: 'file', size, mode: 0o644, uid: 1000, gid: 1000 });
const metadata = { 'home/user/reread': { type: 'directory', size: 0, mode: 0o755, uid: 1000, gid: 1000 } };
for (const [name, body] of Object.entries(FILES)) metadata[`home/user/reread/${name}`] = statOf(body.length);
const { fs, held, room, full, synced } = (declareNamespace({ metadata, manifest: { 'home/user': ['reread'], 'home/user/reread': Object.keys(FILES) } }), factory(
  {}, {}, supervisor, { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }, dir, [], {}, `${dir}/entry.js`, dir,
));

// App.tsx is held as text, as the boot's synchronize fills a planned source;
// main.tsx faults in, as bytes.
room();
assert.ok(synced('home/user/reread/App.tsx', FILES['App.tsx']), 'App.tsx is filled as text');
assert.throws(() => fs.readFileSync(`${dir}/main.tsx`, 'utf8'), { code: 'EAGAIN' });
await globalThis.__nimbusVfsResidencySettle();
for (const [name, body] of Object.entries(FILES)) assert.equal(fs.readFileSync(`${dir}/${name}`, 'utf8'), body, `${name} is held`);

// Now the store is at its cap, and the ledger has nothing more.
granting = false;
full();
for (const [name, body] of Object.entries(FILES)) {
  assert.equal(await fs.promises.readFile(`${dir}/${name}`, 'utf8'), body, `${name} reads asynchronously`);
  assert.ok(held(`home/user/reread/${name}`), `${name} is still held after an async read of the same bytes, at the cap`);
  assert.equal(fs.readFileSync(`${dir}/${name}`, 'utf8'), body, `${name} still reads synchronously`);
}

// A changed file's async read still replaces what the store held.
vfs.writeFile(`${dir}/main.tsx`, enc.encode('changed'));
assert.equal(await fs.promises.readFile(`${dir}/main.tsx`, 'utf8'), 'changed');
assert.notEqual(held('home/user/reread/main.tsx') ? fs.readFileSync(`${dir}/main.tsx`, 'utf8') : 'changed', FILES['main.tsx'], 'no sync read serves the old bytes');
console.log('node-shims-async-read-at-cap: ok');
