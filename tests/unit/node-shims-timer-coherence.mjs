#!/usr/bin/env bun
// The owner's invariant: a node process sees the latest coherent filesystem
// through sync OR async APIs. A facet-local timer resumption carries no
// supervisor message, so without a barrier a sync read inside a timer
// callback serves the spawn-time cell even after a peer overwrote the file.
//
// The shim wraps every timer callback in an ACQUIRE-and-refetch, manufacturing
// the message the resumption lacked. This test drives a REAL setTimeout and a
// REAL peer write against the real SqliteVFS, and asserts the sync read inside
// the callback sees the peer's bytes — the case that was stale before.

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
const enc = new TextEncoder(); const dec = new TextDecoder();
const dir = '/home/user/t'; const resident = `${dir}/r.txt`;
vfs.mkdir(dir, { recursive: true });
vfs.writeFile(resident, enc.encode('V1'));

let acquireCalls = 0;
const supervisor = {
  readFile: async (p) => { const b = await bridge.readFile(p); return b ? dec.decode(b) : null; },
  writeFile: (p, c) => bridge.writeFile(p, c),
  stat: (p) => bridge.stat(p), lstat: (p) => bridge.stat(p, { followSymlinks: false }),
  readdir: (p) => bridge.readdir(p), exists: async (p) => (await bridge.stat(p)) !== null,
  access: (p, m) => bridge.access(p, m), mkdir: (p) => bridge.mkdir(p, { recursive: true }),
  fsReadRange: (p, o, l) => bridge.readRange(p, o, l),
  fsAcquire: (epoch, cursor) => { acquireCalls++; return bridge.acquire(epoch, cursor); },
};
const factory = new Function('__vfsBundle','__vfsMetadata','__vfsDirs','__vfsManifest','__supervisor','cred','cwd','argv','env','filename','dirname',
  '"use strict";' + VFS_WRITE_LEDGER_SOURCE + '\n' + generateShimsCode() + '\n;return { fs: __fsMod, setTimeout: globalThis.setTimeout };');
const out = factory({ 'home/user/t/r.txt': 'V1' },
  { 'home/user/t': { type:'directory', size:0, mode:0o755, uid:1000, gid:1000 },
    'home/user/t/r.txt': { type:'file', size:2, mode:0o644, uid:1000, gid:1000 } },
  {}, { 'home/user': ['t'], 'home/user/t': ['r.txt'] }, supervisor,
  { uid:1000, gid:1000, groups:[1000], umask:0o022 }, dir, [], {}, `${dir}/s.mjs`, dir);
const { fs } = out;

// Warm the resident cell into the cursor's known state via one async touch.
assert.equal(await fs.promises.readFile(resident, 'utf8'), 'V1');

// A peer overwrites AFTER the facet is idle. No supervisor message reaches
// the facet — the only thing that will wake it is the timer below.
vfs.writeFile(resident, enc.encode('REWRITTEN_BY_PEER'));

const seen = await new Promise((resolve) => {
  // globalThis.setTimeout is the shim-wrapped one inside the factory scope.
  out.setTimeout(() => { resolve(fs.readFileSync(resident, 'utf8')); }, 5);
});

// Before the fix this was 'V1' — the spawn-time cell served with no error.
assert.equal(seen, 'REWRITTEN_BY_PEER', 'sync read inside a timer callback sees the peer write');

// The barrier fired: the callback paid exactly one ACQUIRE.
assert.ok(acquireCalls >= 1, 'timer callback performed an ACQUIRE');

// And the stat is consistent with the bytes — no fresh-content/stale-size split.
assert.equal(fs.statSync(resident).size, 'REWRITTEN_BY_PEER'.length);

// A timer that changes nothing still pays a "still R" round trip (the cost the
// owner accepted); it must NOT drop or corrupt the resident cell.
const before = acquireCalls;
const stable = await new Promise((resolve) => {
  out.setTimeout(() => resolve(fs.readFileSync(resident, 'utf8')), 5);
});
assert.equal(stable, 'REWRITTEN_BY_PEER', 'a no-op resumption leaves the cache intact');
assert.equal(acquireCalls, before + 1, 'exactly one ACQUIRE per timer callback');

console.log('node-shims-timer-coherence: all assertions passed');
