#!/usr/bin/env bun
// The import() prefetch's bound holds where the fetches are issued.
//
// One import() may fetch at most 4096 files and 64 MiB ahead of its load
// (node-shims.ts __nimbusStageImport). The bound was counted after the fact:
// a step queued a repair for every file it missed, then the count was
// checked, so 5,000 missed leaves issued 5,000 fetches before the rejection
// and they went on running after it; and bytes were counted as UTF-16 length
// of texts already fetched, manifests not at all (DustyPanther's third
// review of the prefetch).
//
// Now one quota is charged at the repair and read boundary, before any data
// I/O: a file when its repair would be issued, its raw size from the stat
// before its bytes are read, a manifest like a module. Past it nothing more
// is issued, and the rejection comes once the fetches it admitted have
// landed.

import assert from 'node:assert/strict';
import { VFS_WRITE_LEDGER_SOURCE } from '../../packages/core/src/_shared/vfs-write-ledger.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { processBridge } from './lib/process-bridge.mjs';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { SHIMS_STORE_PRELUDE, declareNamespace } from './lib/shims-namespace.mjs';

const LEAVES = 5000;
const BOUND_FILES = 4096;

function world(files, { afterStat } = {}) {
  const harness = createSqliteVfsTestHarness();
  const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
  const vfs = rawVfs.as(CRED_KERNEL);
  const bridge = processBridge(rawVfs, vfs);
  const enc = new TextEncoder();
  const metadata = {};
  const manifest = {};
  for (const [path, body] of Object.entries(files)) {
    const dir = path.slice(0, path.lastIndexOf('/'));
    vfs.mkdir('/' + dir, { recursive: true });
    vfs.writeFile('/' + path, enc.encode(body));
    metadata[path] = { type: 'file', size: enc.encode(body).length, mode: 0o644, uid: 1000, gid: 1000 };
    (manifest[dir] ??= []).push(path.slice(dir.length + 1));
    for (let at = dir; at.includes('/'); at = at.slice(0, at.lastIndexOf('/'))) {
      metadata[at] ??= { type: 'directory', size: 0, mode: 0o755, uid: 1000, gid: 1000 };
      const parent = at.slice(0, at.lastIndexOf('/'));
      const name = at.slice(parent.length + 1);
      if (!(manifest[parent] ??= []).includes(name)) manifest[parent].push(name);
    }
  }
  // The authority, counting data reads: issued, and in flight.
  const io = { reads: 0, inFlight: 0, readPaths: [], bytes: 0 };
  const supervisor = {
    readFile: async (path) => { const bytes = await bridge.readFile(path); return bytes ? new TextDecoder().decode(bytes) : null; },
    stat: async (path) => {
      const found = await bridge.stat(path);
      if (afterStat) afterStat(path, (body) => vfs.writeFile(path, enc.encode(body)));
      return found;
    },
    lstat: (path) => bridge.stat(path, { followSymlinks: false }),
    readdir: (path) => bridge.readdir(path),
    exists: async (path) => (await bridge.stat(path)) !== null,
    fsReadRange: async (path, offset, length) => {
      io.reads++;
      io.inFlight++;
      io.readPaths.push(path);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        const bytes = await bridge.readRange(path, offset, length);
        io.bytes += bytes ? bytes.byteLength : 0;
        return bytes;
      } finally {
        io.inFlight--;
      }
    },
  };
  const factory = new Function(
    '__vfsBundle', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
    '"use strict";' + VFS_WRITE_LEDGER_SOURCE + '\n' + SHIMS_STORE_PRELUDE + generateShimsCode()
      + '\n;return { hydrated: __nimbusHydrated, read: __readFileOr, resolveFrom: __resolveFrom,'
      + ' quota: (specifier, limits) => typeof __nimbusPrefetchQuota === "function" ? __nimbusPrefetchQuota(specifier, limits) : __nimbusPrefetchBudget(specifier) };',
  );
  declareNamespace({ metadata, manifest });
  const shims = factory({}, {}, supervisor, { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }, '/home/user/app', [], {}, '/home/user/app/entry.js', '/home/user/app');
  return { ...shims, io };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
const rejection = async (promise) => {
  try { await promise; } catch (error) { return error; }
  return null;
};

// ── 5,000 leaves: no more fetches issued than the bound, none after the rejection ──
{
  const files = {};
  for (let i = 0; i < LEAVES; i++) files[`home/user/app/node_modules/leaves/f${i}.js`] = `module.exports = ${i};\n`;
  const { hydrated, read, quota, io } = world(files);
  const names = Object.keys(files);
  const error = await rejection(hydrated(() => names.map((k) => read(k, null)), quota('leaves')));
  assert.equal(error?.code, 'ERR_NIMBUS_PREFETCH_BOUND', `5,000 leaves exceed the bound: ${error}`);
  assert.ok(io.reads <= BOUND_FILES, `at most ${BOUND_FILES} fetches were issued (${io.reads})`);
  assert.equal(io.inFlight, 0, 'none is still running when the import() is rejected');
  const issued = io.reads;
  await settle();
  assert.equal(io.reads, issued, 'and none is issued after it');
}

// ── raw bytes, before they are read ──
{
  // Two-byte characters: 4,000 raw bytes per file, 2,000 UTF-16 units.
  const body = 'é'.repeat(2000);
  const files = {
    'home/user/app/node_modules/heavy/a.js': body,
    'home/user/app/node_modules/heavy/b.js': body,
    'home/user/app/node_modules/heavy/c.js': body,
  };
  const { hydrated, read, quota, io } = world(files);
  const names = Object.keys(files);
  const error = await rejection(hydrated(() => names.map((k) => read(k, null)), quota('heavy', { bytes: 10000 })));
  assert.equal(error?.code, 'ERR_NIMBUS_PREFETCH_BOUND', `12,000 raw bytes exceed a 10,000-byte quota (6,000 as UTF-16): ${error}`);
  assert.ok(io.reads <= 2, `the third file's bytes were never read (${io.reads} reads)`);
  assert.equal(io.inFlight, 0);
}

// ── a file that grows between its stat and its read is charged as it is read ──
// (DustyPanther's fourth recheck: the quota charged the stat's size, and the
// read then took the file as it found it, whole.)
{
  const path = 'home/user/app/node_modules/growing/index.js';
  let grown = false;
  const { hydrated, read, quota, io } = world({ [path]: 'x'.repeat(1024) }, {
    afterStat: (statted, write) => {
      if (grown || statted !== '/' + path) return;
      grown = true;
      write('y'.repeat(1024 * 1024));
    },
  });
  const error = await rejection(hydrated(() => read(path, null), quota('growing', { bytes: 200 * 1024 })));
  assert.equal(error?.code, 'ERR_NIMBUS_PREFETCH_BOUND', `1 MiB read past a 200 KiB quota, admitted at its 1 KiB stat: ${error}`);
  assert.ok(io.bytes <= 200 * 1024, `no more than the quota was read (${io.bytes} bytes)`);
  assert.equal(io.inFlight, 0);
}

// ── a manifest is charged like a module ──
{
  const manifestText = JSON.stringify({ name: 'late-pkg', main: 'main.js', description: 'x'.repeat(200) });
  const files = {
    'home/user/app/node_modules/late-pkg/package.json': manifestText,
    'home/user/app/node_modules/late-pkg/main.js': 'module.exports = 1;\n',
  };
  const { hydrated, resolveFrom, quota, io } = world(files);
  const error = await rejection(hydrated(() => resolveFrom('late-pkg', 'home/user/app'), quota('late-pkg', { bytes: 64 })));
  assert.equal(error?.code, 'ERR_NIMBUS_PREFETCH_BOUND', `a ${manifestText.length}-byte manifest exceeds a 64-byte quota: ${error}`);
  assert.equal(io.reads, 0, 'and was not read');
  const { hydrated: again, resolveFrom: resolveAgain, quota: quotaAgain } = world(files);
  const found = await again(() => resolveAgain('late-pkg', 'home/user/app'), quotaAgain('late-pkg'));
  assert.match(String(found), /late-pkg\/main\.js$/, 'within the bound the resolution reads it and resolves');
}

console.log('import-prefetch-quota: ok');
