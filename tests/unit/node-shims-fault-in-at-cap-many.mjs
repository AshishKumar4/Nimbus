#!/usr/bin/env bun
// Many synchronous reads' fault-ins land together in a store at its budget.
//
// `astro dev` imports zod's locales, a hundred modules at once, into a store
// its launch has filled. Each fault-in reserves its room before it fetches,
// and room is asked of the ledger, which grants it. But each ask was for the
// asker's own shortfall, and a waiter that saw room free after someone else's
// grant took it as its own without holding it: so one fill was served per
// grant round, and a reservation gave up after eight rounds. Past the first
// few, the fills were refused with the ledger granting every byte asked
// ("reserve refused …/zod/v4/locales/fi.js cap=42470256 db=42418176", traced
// live, with no grant short or failed), and the import failed: "could not
// fetch …; its fetches did not land".
//
// Waiting reservations are admitted in order as room comes, holding it as
// they are admitted, and one ask covers what they all still need. A
// reservation is refused only when the ledger grants less than is asked.

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
await globalThis.__nimbusVfsResidencySettle();

const missed = Object.keys(FILES).filter((name) => {
  try { return fs.readFileSync(`${dir}/${name}`, 'utf8') !== FILES[name]; } catch { return true; }
});
assert.deepEqual(missed, [], `every fault-in landed in the full store (${missed.length} of ${Object.keys(FILES).length} did not; ${grants.length} grants)`);
// Room for a batch is asked for together, not one fill per round trip.
assert.ok(grants.length <= 4, `the batch's room took ${grants.length} asks of the ledger`);
assert.ok(bytes() <= cap(), `and the store holds no more than it was granted (${bytes()} of ${cap()})`);

console.log('node-shims-fault-in-at-cap-many: ok');
