#!/usr/bin/env bun
// A fault-in whose bytes did not land is asked for again.
//
// A synchronous read that misses faults the file in, once (_faultOnce). The
// fetch can complete without its bytes landing: a barrier that could not
// date them spoiled the fill (a poison moves the cursor with no delta), or
// the store refused them. Treated as answered, the path was never fetched
// again, so the import() prefetch, whose step re-reads until nothing new
// misses, stood with the module unread and the load failed: astro dev, 1 in
// 10 under concurrency, "Cannot load module '…/zod/v4/classic/index.js': it
// was not in this launch's module map", traced live as "install … declined:
// spoiled reported=Infinity rev=528 cursor=542" (a throwaway, astro-real).
//
// Now a fetch that did not land, and did not prove the file absent, leaves
// the path to be asked for again by the next miss, a few times; and the
// prefetch takes another round for a path it asked for again. Driven here
// through the other way a fill fails to land, a store that refuses it once.

import assert from 'node:assert/strict';
import { VFS_WRITE_LEDGER_SOURCE } from '../../packages/core/src/_shared/vfs-write-ledger.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { processBridge } from './lib/process-bridge.mjs';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { SHIMS_STORE_PRELUDE, declareNamespace } from './lib/shims-namespace.mjs';

const dir = '/home/user/retry';
const FILES = { 'direct.js': 'module.exports = "direct";\n', 'prefetched.js': 'module.exports = "prefetched";\n' };

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const vfs = rawVfs.as(CRED_KERNEL);
const bridge = processBridge(rawVfs, vfs);
const enc = new TextEncoder();
vfs.mkdir(dir, { recursive: true });
for (const [name, body] of Object.entries(FILES)) vfs.writeFile(`${dir}/${name}`, enc.encode(body));

// The session's ledger refuses each file's first ask for room, then grants.
const asked = new Map();
let reads = 0;
const supervisor = {
  readFile: async (path) => { const bytes = await bridge.readFile(path); return bytes ? new TextDecoder().decode(bytes) : null; },
  stat: (path) => bridge.stat(path),
  lstat: (path) => bridge.stat(path, { followSymlinks: false }),
  readdir: (path) => bridge.readdir(path),
  exists: async (path) => (await bridge.stat(path)) !== null,
  fsReadRange: (path, offset, length) => { reads++; return bridge.readRange(path, offset, length); },
  fsStorageGrant: async (facet, want) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    const n = (asked.get('ask') || 0) + 1;
    asked.set('ask', n);
    return { granted: n % 2 === 1 ? 0 : want };
  },
};

const factory = new Function(
  '__vfsBundle', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";' + VFS_WRITE_LEDGER_SOURCE + '\n' + SHIMS_STORE_PRELUDE + generateShimsCode()
    + '\n;__residentSetStorage({ facet: "proc-slot-0", grant: 0 }, __supervisor);'
    + '\n;return { fs: __fsMod, hydrated: __nimbusHydrated, read: __readFileOr, quota: (s) => __nimbusPrefetchQuota(s) };',
);
const metadata = { 'home/user/retry': { type: 'directory', size: 0, mode: 0o755, uid: 1000, gid: 1000 } };
for (const [name, body] of Object.entries(FILES)) metadata[`home/user/retry/${name}`] = { type: 'file', size: body.length, mode: 0o644, uid: 1000, gid: 1000 };
const { fs, hydrated, read, quota } = (declareNamespace({ metadata, manifest: { 'home/user': ['retry'], 'home/user/retry': Object.keys(FILES) } }), factory(
  {}, {}, supervisor, { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }, dir, [], {}, `${dir}/entry.js`, dir,
));
const settle = () => globalThis.__nimbusVfsResidencySettle();

// ── a program's own reads: the first fetch is refused, the next miss asks again ──
{
  const path = `${dir}/direct.js`;
  assert.throws(() => fs.readFileSync(path, 'utf8'), { code: 'EAGAIN' });
  await settle();
  assert.throws(() => fs.readFileSync(path, 'utf8'), { code: 'EAGAIN' }, 'the first fetch did not land');
  await settle();
  assert.equal(fs.readFileSync(path, 'utf8'), FILES['direct.js'], 'the second miss asked again, and it landed');
}

// ── the import() prefetch takes another round for it ──
{
  const k = 'home/user/retry/prefetched.js';
  const text = await hydrated(() => read(k, null), quota('retry'));
  assert.equal(text, FILES['prefetched.js'], 'one prefetch step reads the file whose first fetch was refused');
}

// ── a file that is not there is not asked for again ──
{
  const before = reads;
  vfs.unlink(`${dir}/direct.js`);
  assert.equal(await hydrated(() => read('home/user/retry/gone.js', null), quota('gone')), null);
  assert.equal(reads, before, 'an absent file costs no content read');
}

console.log('node-shims-fault-in-retry: ok');
