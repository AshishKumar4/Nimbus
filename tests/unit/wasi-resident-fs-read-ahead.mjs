#!/usr/bin/env bun
/**
 * wasi-resident-fs-read-ahead — a WASI program that reads a directory's files
 * one after another fetches them in batches, not one round trip each.
 *
 * rolldown (Nimbus's wasm build) loads modules one at a time, and each file
 * the process does not hold yet is a fill: a round trip to the session. Vite
 * 8's optimizer pre-bundling lucide-react reads 2,145 modules: cold, 30.5 s;
 * with the same files fetched ahead in parallel, 8.3 s for the whole run
 * (measured on a throwaway, session twilight-thistle-5922), and Vite's dev
 * server, its CPU spent on the fills, was killed ("Worker exceeded CPU time
 * limit") before it answered.
 *
 * Read-ahead is earned: from a directory's second miss, a fill brings with
 * it the directory's next files of the missed file's extension that the
 * process does not hold (lucide's .mjs, not their .map), a window that
 * doubles with each further miss there, bounded per batch and per process;
 * a later read of any of them waits on its batch rather than repeating it. A
 * program that reads one file of a directory fetches only that file.
 */

import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { residentFilesystem } from '../../packages/core/src/runtime/wasi/resident-filesystem.ts';
import { FACET_RESIDENT_STORE_SOURCE } from '../../packages/worker/src/vfs/facet-resident-store.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();
const USER = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000]), umask: 0o022 });
const ROOT = 'home/user';
const k = (p) => `/${ROOT}/${p}`;
const beneath = (path) => ({ root: ROOT, path, beneath: true });

const harness = createSqliteVfsTestHarness();
const files = new ProcessFiles(new SqliteVFS(harness.sql, harness.ctx));
const kernel = files.bind({ pid: 1, cred: CRED_KERNEL });
const authority = files.bind({ pid: 2, cred: USER });
for (const dir of ['/home', `/${ROOT}`]) await kernel.mkdir(dir, { recursive: true });
await kernel.chown(`/${ROOT}`, 1000, 1000);
const ICONS = 400;
const body = (i) => `export default "icon-${i}";\n// ${'x'.repeat(900 + (i % 7) * 13)}\n`;
for (const dir of ['pkg', 'pkg/icons', 'other']) { await kernel.mkdir(k(dir)); await kernel.chown(k(dir), 1000, 1000); }
for (let i = 0; i < ICONS; i++) {
  const name = `icons/i${String(i).padStart(3, '0')}`;
  await kernel.writeFile(k(`pkg/${name}.mjs`), enc.encode(body(i)));
  await kernel.writeFile(k(`pkg/${name}.mjs.map`), enc.encode(`{"version":3,"file":"${name}"}`));
}
for (let i = 0; i < 50; i++) await kernel.writeFile(k(`other/f${i}.mjs`), enc.encode(`export const f = ${i};\n`));

const store = new Function(
  FACET_RESIDENT_STORE_SOURCE
    + '\nreturn { __residentBindInMemory, __residentSetStorage, __residentBootLazy, __residentNamespaceView };',
)();
store.__residentBindInMemory(64 * 1024 * 1024);
const seen = { batches: 0, read: [] };
const supervisor = {
  fsAcquire: (...args) => authority.acquire(...args),
  fsList: (...args) => authority.list(...args),
  readdir: (path) => authority.readdir(path),
  readlink: (path) => authority.readlink(path),
  stat: (path, options) => authority.stat(path, options),
  async fsReadBatch(requests) {
    seen.batches++;
    // A round trip takes a turn, as the session's does.
    await new Promise((resolve) => setTimeout(resolve, 1));
    const out = [];
    for (const request of requests) {
      try {
        if (request.lstat) out.push({ stat: await authority.stat(request.path, { followSymlinks: false }) });
        else { seen.read.push(request.path); out.push({ bytes: await authority.readRange(request.path, request.offset, request.length) }); }
      } catch (error) { out.push({ error }); }
    }
    return out;
  },
};
store.__residentSetStorage(undefined, supervisor);
assert.equal(await store.__residentBootLazy(supervisor), true);
const device = (await authority.stat('/')).dev;
const fs = residentFilesystem(authority, store.__residentNamespaceView(supervisor, device, USER));

// ── one file of a directory: that file, and nothing more ──
{
  const before = seen.read.length;
  assert.equal(dec.decode(await fs.readFile(beneath('other/f7.mjs'))), 'export const f = 7;\n');
  assert.deepEqual(seen.read.slice(before), [k('other/f7.mjs')], 'a lone read fetches only its file');
}

// ── a directory read one file after another: batches ──
{
  const before = { batches: seen.batches, read: seen.read.length };
  for (let i = 0; i < ICONS; i++) {
    const name = `pkg/icons/i${String(i).padStart(3, '0')}.mjs`;
    assert.equal(dec.decode(await fs.readFile(beneath(name))), body(i), `${name} reads back whole`);
  }
  const batches = seen.batches - before.batches;
  const read = seen.read.slice(before.read);
  assert.ok(batches <= 16, `${ICONS} files in ${batches} round trips (one each, and a lookup each, without read-ahead)`);
  assert.ok(fs.stats().readAhead >= ICONS - 20, `read ahead: ${fs.stats().readAhead}`);
  assert.equal(read.filter((path) => path.endsWith('.map')).length, 0, 'only the extension being read is read ahead');
  assert.equal(new Set(read).size, read.length, `no file is fetched twice (${read.length} reads for ${new Set(read).size} files)`);
}

// ── and the other directory is still not read ahead by its one read ──
assert.equal(seen.read.filter((path) => path.startsWith(k('other/'))).length, 1, 'read-ahead is per directory, earned by its own misses');

console.log('wasi-resident-fs-read-ahead: ok');
