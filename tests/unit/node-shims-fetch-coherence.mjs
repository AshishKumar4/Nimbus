#!/usr/bin/env bun
// Witness 2 of the VFS coherence protocol: a facet's outbound fetch does not
// go through the supervisor. The facet inherits the parent worker's network,
// so the response resumes user code with no supervisor message an
// invalidation could ride on — and an external third party can carry a
// happens-before edge between two facets that never touches the authority.
//
// The protocol was documented as closing this at the dispatcher, and it was
// not: no fsAcquire existed on that path. Both halves are asserted here
// against the real shim and the real SqliteVFS.
//
//   RELEASE — parked writes are at the authority BEFORE the request leaves,
//             so nothing outside can observe an effect of a write the
//             authority has not got yet.
//   ACQUIRE — a sync read after the response sees a peer write that landed
//             while the request was in flight.

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
const dir = '/home/user/t';
const peerPath = `${dir}/peer.txt`;
const minePath = `${dir}/mine.txt`;
vfs.mkdir(dir, { recursive: true });
vfs.writeFile(peerPath, enc.encode('V1'));

let acquireCalls = 0;
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
  fsAcquire: (epoch, cursor) => { acquireCalls++; return bridge.acquire(epoch, cursor); },
};

// The stub stands in for the external network AND for the third party that
// observes this facet's effects. It is installed before the shims evaluate,
// so it is what the dispatcher's __origFetch resolves to.
let sawAtEgress = null;
let egressCalls = 0;
let network = async () => {
  const bytes = await bridge.readFile(minePath);
  sawAtEgress = bytes === null ? null : dec.decode(bytes);
  // A peer writes while the request is in flight. Nothing tells the facet.
  vfs.writeFile(peerPath, enc.encode('REWRITTEN_DURING_FETCH'));
  return new Response('ok');
};
// The dispatcher binds __origFetch once, at shim-eval time, so the stub has
// to stay the same function and vary behind it.
globalThis.fetch = async (...args) => { egressCalls++; return network(...args); };

const factory = new Function(
  '__vfsBundle', '__vfsMetadata', '__vfsDirs', '__vfsManifest', '__supervisor',
  'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";' + VFS_WRITE_LEDGER_SOURCE + '\n' + generateShimsCode() +
    '\n;return { fs: __fsMod, fetch: globalThis.fetch };',
);
const out = factory(
  { 'home/user/t/peer.txt': 'V1' },
  {
    'home/user/t': { type: 'directory', size: 0, mode: 0o755, uid: 1000, gid: 1000 },
    'home/user/t/peer.txt': { type: 'file', size: 2, mode: 0o644, uid: 1000, gid: 1000 },
  },
  {},
  { 'home/user': ['t'], 'home/user/t': ['peer.txt'] },
  supervisor,
  { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
  dir, [], {}, `${dir}/s.mjs`, dir,
);
const { fs } = out;

// Warm the cursor: a facet's first ACQUIRE reports a poison, which evicts and
// refetches the whole resident set. Spend that before measuring.
assert.equal(await fs.promises.readFile(peerPath, 'utf8'), 'V1');

// A synchronous write parks. Nothing has carried it to the authority yet.
fs.writeFileSync(minePath, 'MY_WORK');
assert.equal(await bridge.readFile(minePath), null, 'parked, not written through');

const before = acquireCalls;
const response = await out.fetch('https://third-party.invalid/notify');
assert.equal(response.status, 200, 'the dispatcher still returns the real response');
assert.equal(egressCalls, 1, 'exactly one request left the facet');

// RELEASE: the third party could not have seen an effect of a write the
// authority did not have. Before the barrier this read null.
assert.equal(
  sawAtEgress,
  'MY_WORK',
  'parked writes reached the authority before the request left the facet',
);

// ACQUIRE: the response resumed user code, and a synchronous read now sees
// the peer write that landed while the request was in flight. Before the
// barrier this served the spawn-time cell, with no error.
assert.equal(
  fs.readFileSync(peerPath, 'utf8'),
  'REWRITTEN_DURING_FETCH',
  'a sync read after an outbound fetch sees a write that landed during it',
);
assert.ok(acquireCalls > before, 'the outbound fetch paid an ACQUIRE');

// The stat view moved with the bytes — no fresh-content/stale-size split.
assert.equal(fs.statSync(peerPath).size, 'REWRITTEN_DURING_FETCH'.length);

// Reading the body is a SECOND resumption from the network, and a program
// that reads a file after parsing a response is no less entitled to current
// bytes than one that reads after the headers. Arrange for the peer write to
// land between the headers and the body this time.
let bodyGate;
const bodyLanded = new Promise((resolve) => { bodyGate = resolve; });
network = async () => new Response(
  new ReadableStream({
    async start(controller) {
      await bodyLanded;
      controller.enqueue(enc.encode('late-body'));
      controller.close();
    },
  }),
);
const streamed = await out.fetch('https://third-party.invalid/slow');
vfs.writeFile(peerPath, enc.encode('REWRITTEN_DURING_BODY'));
bodyGate();
assert.equal(await streamed.text(), 'late-body');
assert.equal(
  fs.readFileSync(peerPath, 'utf8'),
  'REWRITTEN_DURING_BODY',
  'a sync read after reading a response body sees a write that landed during it',
);

console.log('node-shims-fetch-coherence: all assertions passed');
