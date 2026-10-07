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
const FILES = {
  'direct.js': 'module.exports = "direct";\n',
  'prefetched.js': 'module.exports = "prefetched";\n',
  'shared.js': 'module.exports = "shared";\n',
  'never.js': 'module.exports = "never";\n',
  'node_modules/pinned/package.json': JSON.stringify({ name: 'pinned', main: 'lib/main.js' }),
  'node_modules/pinned/lib/main.js': 'module.exports = "main";\n',
  'node_modules/pinned/index.js': 'module.exports = "index";\n',
};

/**
 * A process over these files whose store is full, and a ledger that answers
 * an ask for room with \`grant(path)\`: the room asked for, or none. A
 * fetch with no room does not land.
 */
function world(grant) {
  const harness = createSqliteVfsTestHarness();
  const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
  const vfs = rawVfs.as(CRED_KERNEL);
  const bridge = processBridge(rawVfs, vfs);
  const enc = new TextEncoder();
  const metadata = {};
  const manifest = {};
  const add = (parent, entry) => { if (!(manifest[parent] ??= []).includes(entry)) manifest[parent].push(entry); };
  for (const [name, body] of Object.entries(FILES)) {
    const path = `${dir}/${name}`;
    vfs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    vfs.writeFile(path, enc.encode(body));
    const k = path.slice(1);
    metadata[k] = { type: 'file', size: body.length, mode: 0o644, uid: 1000, gid: 1000 };
    // Each directory from home/user down, with its entry in its parent's listing.
    const segs = k.split('/');
    for (let i = 2; i < segs.length; i++) {
      const at = segs.slice(0, i + 1).join('/');
      add(segs.slice(0, i).join('/'), segs[i]);
      if (i < segs.length - 1) metadata[at] ??= { type: 'directory', size: 0, mode: 0o755, uid: 1000, gid: 1000 };
    }
  }
  const io = { reads: 0 };
  const supervisor = {
    readFile: async (path) => { const bytes = await bridge.readFile(path); return bytes ? new TextDecoder().decode(bytes) : null; },
    stat: (path) => bridge.stat(path),
    lstat: (path) => bridge.stat(path, { followSymlinks: false }),
    readdir: (path) => bridge.readdir(path),
    exists: async (path) => (await bridge.stat(path)) !== null,
    fsReadRange: (path, offset, length) => { io.reads++; return bridge.readRange(path, offset, length); },
    fsStorageGrant: async (facet, want) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return { granted: grant() ? want : 0 };
    },
  };
  const factory = new Function(
    '__vfsBundle', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
    '"use strict";' + VFS_WRITE_LEDGER_SOURCE + '\n' + SHIMS_STORE_PRELUDE + generateShimsCode()
      + '\n;__residentSetStorage({ facet: "proc-slot-0", grant: 0 }, __supervisor);'
      + '\n;return { fs: __fsMod, hydrated: __nimbusHydrated, read: __readFileOr, resolveFrom: __resolveFrom, quota: (s) => __nimbusPrefetchQuota(s) };',
  );
  declareNamespace({ metadata, manifest });
  const shims = factory({}, {}, supervisor, { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }, dir, [], {}, `${dir}/entry.js`, dir);
  return { ...shims, vfs, io };
}
// Every other ask for room is refused, starting with the first.
let asks = 0;
const { fs, hydrated, read, quota, vfs, io } = world(() => ++asks % 2 === 0);
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
  const before = io.reads;
  assert.equal(await hydrated(() => read('home/user/retry/gone.js', null), quota('gone')), null);
  assert.equal(io.reads, before, 'an absent file costs no content read');
}

// ── two imports reading the same file at once: the one that joins the other's
// fetch reruns as the one that issued it does (DustyPanther, fifth recheck) ──
{
  const k = 'home/user/retry/shared.js';
  const [first, second] = await Promise.all([
    hydrated(() => read(k, null), quota('first')),
    hydrated(() => read(k, null), quota('second')),
  ]);
  assert.equal(first, FILES['shared.js']);
  assert.equal(second, FILES['shared.js'], 'the import that joined a fetch read what it fetched, not its first miss');
}

// ── a file whose fetches never land: the prefetch fails, named, rather than
// stand on a partial resolution ──
{
  const never = world(() => false);
  const unreadable = async (step) => {
    try { await never.hydrated(step, never.quota('never')); } catch (error) { return error; }
    return null;
  };
  const read = await unreadable(() => never.read('home/user/retry/never.js', null));
  assert.equal(read?.code, 'ERR_NIMBUS_PREFETCH_UNREADABLE', `a module never fetched: ${read}`);
  assert.match(read.message, /never\.js/);
  // pinned's package.json names lib/main.js; unread, the resolver would fall
  // back to index.js.
  const resolved = await unreadable(() => never.resolveFrom('pinned', 'home/user/retry'));
  assert.equal(resolved?.code, 'ERR_NIMBUS_PREFETCH_UNREADABLE', `a resolution on an unread manifest: ${resolved}`);
  assert.match(resolved.message, /pinned\/package\.json/);
}

console.log('node-shims-fault-in-retry: ok');
