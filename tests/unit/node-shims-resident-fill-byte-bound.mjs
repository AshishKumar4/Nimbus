#!/usr/bin/env bun
// What a facet keeps from its own reads is bounded, and refusing to keep
// something never leaves an older answer behind.
//
// A facet's synchronous filesystem view is one object on the heap, and every
// async whole-file read installed its bytes into it for the life of the
// process. The boot snapshot that object starts as is bounded twice —
// BUNDLE_MAX_ENCODED_BYTES for the whole of it, CWD_SNAPSHOT_MAX_FILE_BYTES
// for any one file the working-tree sweep guesses at — so those ceilings
// described what a facet STARTED with and nothing about where it ended up: a
// program reached any heap it liked by reading files. The facet shares its
// isolate with the session's Durable Object, so that heap is the session's.
//
// Bounded by a TOTAL, not per file: the fill is what makes a synchronous read
// of an unstaged file succeed on the next attempt, and refusing by size would
// make an ordinary `readFileSync` of a large fixture unrepairable however much
// room the facet has. Age decides instead — oldest first.
//
// And the obligation the fill exists for — an async read must not leave a
// synchronous read able to go backwards to an older value — has to survive the
// bound, which means a refused fill DROPS what it was holding.

import assert from 'node:assert/strict';
import { VFS_WRITE_LEDGER_SOURCE } from '../../packages/core/src/_shared/vfs-write-ledger.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { SqliteRuntimeFsBridge } from '../../packages/core/src/runtime/sqlite-runtime-fs-bridge.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { RESIDENT_FILL_MAX_BYTES } from '../../packages/core/src/constants.ts';

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const vfs = rawVfs.as(CRED_KERNEL);
const bridge = new SqliteRuntimeFsBridge(vfs, rawVfs);
const enc = new TextEncoder();
const dec = new TextDecoder();

const dir = '/home/user/app';
// One file past the whole budget, and enough admissible ones that their sum
// crosses it.
const OVERSIZE_BYTES = RESIDENT_FILL_MAX_BYTES + 64 * 1024;
const MID_BYTES = Math.floor(RESIDENT_FILL_MAX_BYTES / 5);
const MID_COUNT = 7;

const oversize = `${dir}/catalogue.json`;
const small = `${dir}/config.json`;
const mids = Array.from({ length: MID_COUNT }, (_, i) => `${dir}/chunk-${i}.dat`);

const OVERSIZE_BODY = 'o'.repeat(OVERSIZE_BYTES);
const SMALL_BODY = '{"small":true}';
const midBody = (i) => String(i % 10).repeat(MID_BYTES);

vfs.mkdir(dir, { recursive: true });
vfs.writeFile(oversize, enc.encode(OVERSIZE_BODY));
vfs.writeFile(small, enc.encode(SMALL_BODY));
for (let i = 0; i < MID_COUNT; i++) vfs.writeFile(mids[i], enc.encode(midBody(i)));

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
};

const strip = (p) => p.replace(/^\/+/, '');
const statOf = (size) => ({ type: 'file', size, mode: 0o644, uid: 1000, gid: 1000 });

// The bundle the facet boots with. Held here so the test can read what the
// process is holding — this object IS the facet's synchronous view.
const bundle = {};
const metadata = {
  [strip(dir)]: { type: 'directory', size: 0, mode: 0o755, uid: 1000, gid: 1000 },
  [strip(oversize)]: statOf(OVERSIZE_BYTES),
  [strip(small)]: statOf(SMALL_BODY.length),
};
for (let i = 0; i < MID_COUNT; i++) metadata[strip(mids[i])] = statOf(MID_BYTES);

const factory = new Function(
  '__vfsBundle', '__vfsMetadata', '__vfsDirs', '__vfsManifest', '__supervisor',
  'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";' + VFS_WRITE_LEDGER_SOURCE + '\n' + generateShimsCode() +
    '\n;return { fs: __fsMod };',
);
const { fs } = factory(
  bundle,
  metadata,
  {},
  {
    'home/user': ['app'],
    [strip(dir)]: ['catalogue.json', 'config.json', ...mids.map((m) => m.split('/').pop())],
  },
  supervisor,
  { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
  dir,
  [], {},
  `${dir}/entry.js`,
  dir,
);

const cellBytes = (cell) => (
  typeof cell === 'string' ? enc.encode(cell).length
    : cell && cell.byteLength !== undefined ? cell.byteLength : 0
);
const heldBytes = () => Object.values(bundle).reduce((n, cell) => n + cellBytes(cell), 0);
const held = (path) => strip(path) in bundle;
const syncError = (path) => {
  try { fs.readFileSync(path, 'utf8'); return null; } catch (error) { return error; }
};

// ── 1. A small read still fills ─────────────────────────────────────────────
// The bound must not delete the mechanism: the fill is why a program that
// reads a file asynchronously can then read it synchronously.
assert.equal(await fs.promises.readFile(small, 'utf8'), SMALL_BODY);
assert.ok(held(small), 'a read inside the bound must still become resident');
assert.equal(
  fs.readFileSync(small, 'utf8'), SMALL_BODY,
  'the point of the fill is that the next synchronous read is served',
);

// ── 2. A file larger than the whole budget is read, and not retained ────────
// The program gets its bytes. What it must not get is a permanent copy of them
// in the object its isolate carries for the rest of the process — and it must
// not get there by evicting every other cell for something that still does not
// fit.
const readBack = await fs.promises.readFile(oversize, 'utf8');
assert.equal(readBack.length, OVERSIZE_BYTES, 'the read itself must still return the whole file');
assert.equal(
  held(oversize), false,
  `a ${OVERSIZE_BYTES}-byte read must not be retained: the budget is ${RESIDENT_FILL_MAX_BYTES}`,
);
assert.ok(held(small), 'refusing an oversized cell must not cost the cells that do fit');

// ── 3. Refusing to retain does not fabricate a missing file ─────────────────
// EAGAIN ("exists, not resident"), the same answer the supervisor's own
// eviction pass leaves behind — never ENOENT for a file that is plainly there.
const refused = syncError(oversize);
assert.ok(refused, 'a synchronous read of content nothing holds must throw');
assert.equal(
  refused.code, 'EAGAIN',
  `a file that exists must not be reported missing: got ${refused.code}`,
);
assert.equal(
  fs.existsSync(oversize), true,
  'the existence view must survive the refusal to hold the bytes',
);
assert.equal(
  fs.statSync(oversize).size, OVERSIZE_BYTES,
  'the size the read measured is still the honest one to report',
);

// ── 4. The total is bounded, oldest first ───────────────────────────────────
for (const path of mids) {
  const body = await fs.promises.readFile(path, 'utf8');
  assert.equal(body.length, MID_BYTES, `every read still returns its own bytes: ${path}`);
  assert.ok(
    heldBytes() <= RESIDENT_FILL_MAX_BYTES,
    `the resident view must stay inside ${RESIDENT_FILL_MAX_BYTES} bytes; `
    + `holding ${heldBytes()} after ${path}`,
  );
}
assert.ok(
  MID_BYTES * MID_COUNT > RESIDENT_FILL_MAX_BYTES,
  'the fixture must actually ask for more than the bound, or this proves nothing',
);
assert.ok(held(mids[MID_COUNT - 1]), 'the most recent read is the one kept');
assert.equal(held(mids[0]), false, 'the oldest fill is the one released');

// ── 5. A refused fill never leaves an older answer behind ───────────────────
// The obligation the fill exists for. A cell the process is already holding,
// an async read that returns different bytes, and a bound that refuses to keep
// them: the one outcome that must not happen is the next synchronous read
// answering with the value the program has already been told is stale.
const drifting = `${dir}/drifting.json`;
const STALE = '{"v":1}';
vfs.writeFile(drifting, enc.encode(STALE));
metadata[strip(drifting)] = statOf(STALE.length);
bundle[strip(drifting)] = STALE;
assert.equal(fs.readFileSync(drifting, 'utf8'), STALE, 'the stale cell starts out being served');

const FRESH = 'F'.repeat(OVERSIZE_BYTES);
vfs.writeFile(drifting, enc.encode(FRESH));
metadata[strip(drifting)] = statOf(FRESH.length);
const fresh = await fs.promises.readFile(drifting, 'utf8');
assert.equal(fresh.length, OVERSIZE_BYTES, 'the async read returns the new bytes');
assert.equal(held(drifting), false, 'bytes past the ceiling are not retained here either');
const afterRefusal = syncError(drifting);
assert.ok(
  afterRefusal && afterRefusal.code === 'EAGAIN',
  'a refused fill must drop the cell it was holding, not keep serving the older value: '
  + `got ${afterRefusal ? afterRefusal.code : JSON.stringify(fs.readFileSync(drifting, 'utf8'))}`,
);

console.log(
  `node-shims-resident-fill-byte-bound: ok — budget ${RESIDENT_FILL_MAX_BYTES}B, holding `
  + `${heldBytes()}B after ${MID_COUNT + 3} reads totalling `
  + `${MID_BYTES * MID_COUNT + OVERSIZE_BYTES * 2 + SMALL_BODY.length}B`,
);
