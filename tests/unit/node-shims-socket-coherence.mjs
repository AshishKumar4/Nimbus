#!/usr/bin/env bun
// Witness 3, the last unbarriered resumption: an inbound WebSocket frame.
//
// A directly-connected socket delivers `onmessage` as a bare resumption — an
// arbitrary third party wakes the facet at a time of its own choosing, and a
// synchronous read in that handler serves whatever the facet held when it
// last heard from the authority. Two facets on any common external endpoint
// therefore had a channel that never passed the supervisor.
//
// The supervisor now terminates the socket and relays frames, so a frame is a
// supervisor reply and the handler takes the same ACQUIRE the timer and fetch
// boundaries take. This drives the real shim against the real SqliteVFS with
// a supervisor that writes as a peer between frames.

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
let sentFrames = [];
let sawAtSend = null;
let closedWith = null;

// The relay queue, as the supervisor would hold it. Each poll hands back one
// batch; the third party writes to the filesystem just before the frame is
// released, which is exactly the race the barrier has to win.
const frames = [
  [{ kind: 'open', protocol: 'chat' }],
  [{ kind: 'message', text: 'peer-wrote', bytes: null }],
  [{ kind: 'message', text: null, bytes: enc.encode('binary') }],
];
let pollIndex = 0;

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
  wsOpen: async (url, protocols) => {
    assert.equal(url, 'wss://third-party.invalid/socket');
    assert.deepEqual(protocols, ['chat']);
    return { id: 42, protocol: 'chat' };
  },
  wsPoll: async (id) => {
    assert.equal(id, 42);
    if (pollIndex === 1) {
      // The peer writes while the facet is parked on the poll. Nothing else
      // will tell the facet, which is the whole point of witness 3.
      vfs.writeFile(peerPath, enc.encode('REWRITTEN_BY_PEER'));
    }
    if (pollIndex >= frames.length) return new Promise(() => {});
    return frames[pollIndex++];
  },
  wsSend: async (id, text, bytes) => {
    const parked = await bridge.readFile(minePath);
    sawAtSend = parked === null ? null : dec.decode(parked);
    sentFrames.push(text !== null ? text : dec.decode(bytes));
  },
  wsClose: async (id, code, reason) => { closedWith = { id, code, reason }; },
};

const factory = new Function(
  '__vfsBundle', '__vfsMetadata', '__vfsDirs', '__vfsManifest', '__supervisor',
  'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";' + VFS_WRITE_LEDGER_SOURCE + '\n' + generateShimsCode() +
    '\n;return { fs: __fsMod, WebSocket: globalThis.WebSocket };',
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
const { fs, WebSocket } = out;

// Warm the cursor past the first-ACQUIRE poison.
assert.equal(await fs.promises.readFile(peerPath, 'utf8'), 'V1');

const observed = [];
const opened = [];
const socket = new WebSocket('wss://third-party.invalid/socket', ['chat']);
assert.equal(socket.readyState, WebSocket.CONNECTING);
assert.equal(socket.url, 'wss://third-party.invalid/socket');

const gotBoth = new Promise((resolve) => {
  socket.onopen = () => { opened.push(socket.protocol); };
  socket.addEventListener('message', (event) => {
    // The synchronous read inside the frame handler is the assertion. Before
    // the relay this served the spawn-time cell with no error.
    observed.push({
      data: typeof event.data === 'string' ? event.data : dec.decode(new Uint8Array(event.data)),
      seen: fs.readFileSync(peerPath, 'utf8'),
    });
    if (observed.length === 2) resolve();
  });
});

await gotBoth;

assert.deepEqual(opened, ['chat'], 'the open event carried the negotiated subprotocol');
assert.equal(socket.readyState, WebSocket.OPEN);
assert.equal(observed[0].data, 'peer-wrote', 'a text frame arrives as a string');
assert.equal(observed[1].data, 'binary', 'a binary frame arrives as an ArrayBuffer');
assert.equal(
  observed[0].seen,
  'REWRITTEN_BY_PEER',
  'a sync read inside a relayed frame handler sees the peer write',
);
assert.ok(acquireCalls >= 2, 'each relayed frame paid an ACQUIRE');

// Sending is an outward-visible effect of whatever this facet just wrote, so
// the parked writes go first — otherwise the peer can act on a write the
// authority does not have.
fs.writeFileSync(minePath, 'MY_WORK');
socket.send('notify');
await new Promise((resolve) => setTimeout(resolve, 40));
assert.deepEqual(sentFrames, ['notify'], 'the frame reached the relay');
assert.equal(
  sawAtSend,
  'MY_WORK',
  'parked writes reached the authority before the frame left the facet',
);
assert.equal(socket.bufferedAmount, 0, 'bufferedAmount settles back after the send');

socket.send(new Uint8Array([0x68, 0x69]));
await new Promise((resolve) => setTimeout(resolve, 40));
assert.deepEqual(sentFrames, ['notify', 'hi'], 'a binary send crosses as bytes');

const closed = new Promise((resolve) => { socket.onclose = resolve; });
socket.close(1000, 'done');
const closeEvent = await closed;
assert.equal(closeEvent.code, 1000);
assert.equal(closeEvent.wasClean, true);
assert.equal(socket.readyState, WebSocket.CLOSED);
assert.deepEqual(closedWith, { id: 42, code: 1000, reason: 'done' });

console.log('node-shims-socket-coherence: all assertions passed');
