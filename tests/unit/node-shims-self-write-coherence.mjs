#!/usr/bin/env bun
// The invalidation log records WHAT changed, not WHO changed it, so the
// ACQUIRE barrier hands a facet back the paths it wrote itself. The facet
// then drops the cells it is holding and refetches bytes that never left —
// measured at 41 invalidations and 40 refetches for 40 written files, paid
// again at every resumption. A scaffolder or a build spends its whole run
// re-reading its own output.
//
// The repair is a revision stamp, not a "skip paths I wrote" rule: a peer
// may write the same path after us and that invalidation is real. This test
// pins both directions against the real SqliteVFS — a self-write survives
// the barrier, and a peer write to the same path still evicts.

import assert from 'node:assert/strict';
import { VFS_WRITE_LEDGER_SOURCE } from '../../packages/core/src/_shared/vfs-write-ledger.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { SqliteRuntimeFsBridge } from '../../packages/core/src/runtime/sqlite-runtime-fs-bridge.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const vfs = rawVfs.as(CRED_KERNEL);
const bridge = new SqliteRuntimeFsBridge(vfs, rawVfs);
const enc = new TextEncoder();
const dec = new TextDecoder();
const dir = '/home/user/p';
vfs.mkdir(dir, { recursive: true });

const supervisor = {
  readFile: async (p) => { const b = await bridge.readFile(p); return b ? dec.decode(b) : null; },
  writeFile: (p, c) => bridge.writeFile(p, c),
  stat: (p) => bridge.stat(p),
  lstat: (p) => bridge.stat(p, { followSymlinks: false }),
  readdir: (p) => bridge.readdir(p),
  exists: async (p) => (await bridge.stat(p)) !== null,
  access: (p, m) => bridge.access(p, m),
  mkdir: (p) => bridge.mkdir(p, { recursive: true }),
  fsReadRange: (p, o, l) => bridge.readRange(p, o, l),
  fsAcquire: (epoch, cursor) => bridge.acquire(epoch, cursor),
};

// The supervisor stamps a facet's bundle with the cursor it was read at, and
// the launcher seeds globalThis.__nimbusVfsCursor from it (FacetVfsState.cursor
// -> facets/manager.ts). Without that seed the first ACQUIRE carries a null
// epoch and is answered with a poison, which drops the resident set for a
// reason that has nothing to do with what this test is measuring.
globalThis.__nimbusVfsCursor = { epoch: rawVfs.epoch, rev: rawVfs.revision() };

const factory = new Function(
  '__vfsBundle', '__vfsMetadata', '__vfsDirs', '__vfsManifest', '__supervisor',
  'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";' + VFS_WRITE_LEDGER_SOURCE + '\n' + generateShimsCode()
  + '\n;return { fs: __fsMod, setTimeout: globalThis.setTimeout };',
);
const out = factory(
  {},
  { 'home/user/p': { type: 'directory', size: 0, mode: 0o755, uid: 1000, gid: 1000 } },
  {}, { 'home/user': ['p'], 'home/user/p': [] }, supervisor,
  { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }, dir, [], {}, `${dir}/s.mjs`, dir,
);
const { fs } = out;
const stats = globalThis.__nimbusVfsCoherence;

const FILES = 40;
const written = [];
for (let i = 0; i < FILES; i++) {
  const p = `${dir}/f${i}.txt`;
  written.push(p);
  fs.writeFileSync(p, `MINE_${i}`);
}

// `setTimeout` here is the SHIM-wrapped one — the factory installed it on
// globalThis — so each of these waits is itself a barriered resumption. That
// is the point: the debounced write-back lands between them, and the ACQUIRE
// that follows is exactly the one that used to evict all 40 self-authored
// cells and refetch them. Counting across the whole sequence rather than
// around a single timer is what keeps the ACQUIREs the waits perform inside
// the measurement instead of ahead of it.
await new Promise((resolve) => setTimeout(resolve, 200));
await new Promise((resolve) => setTimeout(resolve, 100));

for (let i = 0; i < FILES; i++) {
  assert.equal(await supervisor.readFile(written[i]), `MINE_${i}`, 'the write reached authority');
}
const seen = await new Promise((resolve) => {
  out.setTimeout(() => resolve(written.map((p) => fs.readFileSync(p, 'utf8'))), 5);
});
for (let i = 0; i < FILES; i++) {
  assert.equal(seen[i], `MINE_${i}`, 'a sync read after the barrier serves the facet own bytes');
}
assert.equal(stats.poisons, 0, 'a seeded cursor is never poisoned');
assert.equal(stats.fills, 0, `no cell was refetched (was ${stats.fills})`);
assert.ok(stats.selfWrites >= FILES, 'the barrier recognised the writes as this facet own');

// Every mutation also reports its PARENT, and that one entry is still
// honoured: the parent is deliberately left unstamped. A write stamps only
// the file it wrote, because the same revision on the directory would also
// vouch for a peer's earlier change to the directory itself — a chmod at an
// unacquired revision — that this facet has never applied. So exactly one
// record goes, once, instead of one per written file.
assert.equal(
  stats.invalidations, 1,
  `only the parent directory record is dropped (was ${stats.invalidations})`,
);

// The other direction, and the reason a name-only rule is unsound: a peer
// writes a path this facet also wrote. That invalidation is real and must
// still land, so the next sync read serves the peer bytes.
vfs.writeFile(written[0], enc.encode('PEER'));
const afterPeer = await new Promise((resolve) => {
  out.setTimeout(() => resolve(fs.readFileSync(written[0], 'utf8')), 5);
});
assert.equal(afterPeer, 'PEER', 'a peer write to a self-written path still invalidates');
assert.equal(fs.statSync(written[0]).size, 'PEER'.length, 'and the stat follows the bytes');

// The facet writing the path again re-establishes its own stamp, so the next
// barrier is quiet once more rather than permanently poisoned by the peer.
fs.writeFileSync(written[0], 'MINE_AGAIN');
await new Promise((resolve) => setTimeout(resolve, 200));
const quiet = stats.invalidations;
const back = await new Promise((resolve) => {
  out.setTimeout(() => resolve(fs.readFileSync(written[0], 'utf8')), 5);
});
assert.equal(back, 'MINE_AGAIN');
assert.equal(stats.invalidations, quiet, 'a re-written path is self-authored again');

// A speculative repair must never unstamp the facet's own write.
//
// A sync read that the view cannot serve issues a live read to make the next
// touch answerable. That read is in flight while the program carries on, and a
// program whose config was not there writes it next — so the repair lands AFTER
// the flush, installs the same bytes over the same cell, and drops the revision
// stamp that says the cell is this facet's own. The very next barrier then
// evicts the facet's own output: measured at selfWrites 0, invalidations 1 and
// fills 2 for one written file, where the same sequence without the refused
// read costs 1, 0 and 0. Live, the sync read that followed answered ENOENT for
// a file the program had written itself two turns earlier.
{
  // Under /opt, which no ancestor in this facet manifest enumerates — so the
  // first read cannot be answered from knowledge and a repair is put in flight.
  const CFG = '/opt/tool-nodejs/config.json';
  const before = { fills: stats.fills, invalidations: stats.invalidations, self: stats.selfWrites };

  // The refused read, which is what puts a repair in flight for this path.
  assert.throws(() => fs.readFileSync(CFG, 'utf8'), (error) => error.code === 'ENOENT');
  fs.mkdirSync('/opt/tool-nodejs', { recursive: true });
  fs.writeFileSync(CFG, '{"preferences":{}}');
  assert.equal(fs.readFileSync(CFG, 'utf8'), '{"preferences":{}}', 'read-your-own-writes, same turn');

  await new Promise((resolve) => setTimeout(resolve, 200));
  const acrossBarrier = await new Promise((resolve) => {
    out.setTimeout(() => {
      let answer;
      try { answer = fs.readFileSync(CFG, 'utf8'); } catch (error) { answer = error.code; }
      resolve(answer);
    }, 5);
  });
  assert.equal(
    acrossBarrier, '{"preferences":{}}',
    'a file the program wrote itself must survive the barrier that follows',
  );
  assert.ok(
    stats.selfWrites > before.self,
    'the barrier must recognise the write as this facet own despite the repair',
  );
  assert.equal(
    stats.invalidations, before.invalidations,
    `nothing this facet authored was evicted (was ${stats.invalidations - before.invalidations})`,
  );
  assert.equal(
    stats.fills, before.fills,
    `and nothing was refetched that never left (was ${stats.fills - before.fills})`,
  );
}

console.log('node-shims-self-write-coherence: all assertions passed');
