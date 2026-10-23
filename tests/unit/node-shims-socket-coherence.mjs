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
// boundaries take. This drives the real shim against the real session with a
// relay that writes as a peer between frames.

import assert from 'node:assert/strict';
import { createAuthority, sleep } from './lib/resident-body.mjs';
import { shimsOnSession } from './lib/shims-on-session.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();
const dir = '/home/user/t';
const peerPath = `${dir}/peer.txt`;
const minePath = `${dir}/mine.txt`;
const closingPath = `${dir}/closing.txt`;
const openingPath = `${dir}/opening.txt`;

const authority = createAuthority();
authority.kfs.mkdir(dir, { recursive: true });
authority.kfs.writeFile(peerPath, 'V1');

// What the relay saw at each supervisor call, as the pending writes stood.
let sawAtSend = null;
let sawAtOpen = null;
let sawAtClose = null;
const sentFrames = [];
let closedWith = null;
const parked = async (path) => ((await authority.peer.exists(path)) ? authority.peer.readFileString(path) : null);

// The relay queue, as the session would hold it. Each poll hands back one
// batch; the third party writes to the filesystem just before the frame is
// released, which is exactly the race the barrier has to win.
const frames = [
  [{ kind: 'open', protocol: 'chat' }],
  [{ kind: 'message', text: 'peer-wrote', bytes: null }],
  [{ kind: 'message', text: null, bytes: enc.encode('binary') }],
];
let pollIndex = 0;

const { fs, WebSocket } = shimsOnSession({
  authority,
  cwd: dir,
  bundle: { 'home/user/t/peer.txt': 'V1' },
  overrides: {
    wsOpen: async (url, protocols) => {
      assert.equal(url, 'wss://third-party.invalid/socket');
      assert.deepEqual(protocols, ['chat']);
      sawAtOpen = await parked(openingPath);
      return { id: 42, protocol: 'chat' };
    },
    wsPoll: async (id) => {
      assert.equal(id, 42);
      if (pollIndex === 1) {
        // The peer writes while the facet is parked on the poll. Nothing else
        // will tell the facet, which is the whole point of witness 3.
        await authority.peer.writeFile(peerPath, 'REWRITTEN_BY_PEER');
      }
      if (pollIndex >= frames.length) return new Promise(() => {});
      return frames[pollIndex++];
    },
    wsSend: async (id, text, bytes) => {
      sawAtSend = await parked(minePath);
      sentFrames.push(text !== null ? text : dec.decode(bytes));
    },
    wsClose: async (id, code, reason) => {
      sawAtClose = await parked(closingPath);
      closedWith = { id, code, reason };
    },
  },
});

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

// A frame handler that throws never resolves the frames above: fail in seconds, not at the file's timeout.
await Promise.race([gotBoth, sleep(5_000).then(() => { throw new Error('the relayed frames never reached the handler'); })]);

assert.deepEqual(opened, ['chat'], 'the open event carried the negotiated subprotocol');
assert.equal(socket.readyState, WebSocket.OPEN);
assert.equal(observed[0].data, 'peer-wrote', 'a text frame arrives as a string');
assert.equal(observed[1].data, 'binary', 'a binary frame arrives as an ArrayBuffer');
assert.equal(
  observed[0].seen,
  'REWRITTEN_BY_PEER',
  'a sync read inside a relayed frame handler sees the peer write',
);

// Sending is an outward-visible effect of whatever this facet just wrote, so
// the pending writes go first — otherwise the peer can act on a write the
// session does not have.
fs.writeFileSync(minePath, 'MY_WORK');
socket.send('notify');
await sleep(40);
assert.deepEqual(sentFrames, ['notify'], 'the frame reached the relay');
assert.equal(
  sawAtSend,
  'MY_WORK',
  'pending writes reached the session before the frame left the facet',
);
assert.equal(socket.bufferedAmount, 0, 'bufferedAmount settles back after the send');

socket.send(new Uint8Array([0x68, 0x69]));
await sleep(40);
assert.deepEqual(sentFrames, ['notify', 'hi'], 'a binary send crosses as bytes');

// So is its close (its code and reason), and another socket's handshake (its URL and headers).
fs.writeFileSync(closingPath, 'CLOSING');
const closed = new Promise((resolve) => { socket.onclose = resolve; });
socket.close(1000, 'done');
const closeEvent = await closed;
assert.equal(closeEvent.code, 1000);
assert.equal(closeEvent.wasClean, true);
assert.equal(socket.readyState, WebSocket.CLOSED);
assert.deepEqual(closedWith, { id: 42, code: 1000, reason: 'done' });
assert.equal(sawAtClose, 'CLOSING', 'pending writes reached the session before the close left the facet');
fs.writeFileSync(openingPath, 'OPENING');
const second = new WebSocket('wss://third-party.invalid/socket', ['chat']);
await sleep(40);
assert.equal(sawAtOpen, 'OPENING', 'pending writes reached the session before the handshake left the facet');
second.close(1000, 'done');

console.log('node-shims-socket-coherence: all assertions passed');
