#!/usr/bin/env bun
// Witness 2 of the VFS coherence protocol: a facet's outbound fetch does not
// go through the supervisor. The facet inherits the parent worker's network,
// so the response resumes user code with no supervisor message an
// invalidation could ride on — and an external third party can carry a
// happens-before edge between two facets that never touches the authority.
//
// The protocol was documented as closing this at the dispatcher, and it was
// not: no fsAcquire existed on that path. Both halves are asserted here
// against the real shim and the real session.
//
//   RELEASE — what the process wrote is at the session BEFORE the request
//             leaves, so nothing outside can observe an effect of a write the
//             session does not have yet.
//   ACQUIRE — a sync read after the response sees a peer write that landed
//             while the request was in flight.

import assert from 'node:assert/strict';
import { createAuthority } from './lib/resident-body.mjs';
import { shimsOnSession } from './lib/shims-on-session.mjs';

const authority = createAuthority();
const dir = '/home/user/t';
const peerPath = `${dir}/peer.txt`;
const minePath = `${dir}/mine.txt`;
authority.kfs.mkdir(dir, { recursive: true });
authority.kfs.writeFile(peerPath, 'V1');

// The stub stands in for the external network AND for the third party that
// observes this facet's effects. It is installed before the shims evaluate,
// so it is what the dispatcher's __origFetch resolves to.
let sawAtEgress = null;
let egressCalls = 0;
let network = async () => {
  sawAtEgress = authority.kfs.exists(minePath) ? authority.kfs.readFileString(minePath) : null;
  // A peer writes while the request is in flight. Nothing tells the facet.
  authority.kfs.writeFile(peerPath, 'REWRITTEN_DURING_FETCH');
  return new Response('ok');
};
// The dispatcher binds __origFetch once, at shim-eval time, so the stub has
// to stay the same function and vary behind it.
globalThis.fetch = async (...args) => { egressCalls++; return network(...args); };

const { fs, fetch: out } = shimsOnSession({ authority, cwd: dir, bundle: { 'home/user/t/peer.txt': 'V1' } });

// Warm the cursor: a facet's first ACQUIRE reports a poison, which evicts and
// refetches the whole resident set. Spend that before measuring.
assert.equal(await fs.promises.readFile(peerPath, 'utf8'), 'V1');

// A synchronous write parks. Nothing has carried it to the authority yet.
fs.writeFileSync(minePath, 'MY_WORK');
assert.equal(authority.kfs.exists(minePath), false, 'parked, not written through');

const response = await out('https://third-party.invalid/notify');
assert.equal(response.status, 200, 'the dispatcher still returns the real response');
assert.equal(egressCalls, 1, 'exactly one request left the facet');

// RELEASE: the third party could not have seen an effect of a write the
// session did not have. Before the barrier this read null.
assert.equal(
  sawAtEgress,
  'MY_WORK',
  'parked writes reached the authority before the request left the facet',
);

// ACQUIRE: the response resumed user code, and a synchronous read now sees
// the peer write that landed while the request was in flight.
assert.equal(
  fs.readFileSync(peerPath, 'utf8'),
  'REWRITTEN_DURING_FETCH',
  'a sync read after an outbound fetch sees a write that landed during it',
);

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
      controller.enqueue(new TextEncoder().encode('late-body'));
      controller.close();
    },
  }),
);
const streamed = await out('https://third-party.invalid/slow');
authority.kfs.writeFile(peerPath, 'REWRITTEN_DURING_BODY');
bodyGate();
assert.equal(await streamed.text(), 'late-body');
assert.equal(
  fs.readFileSync(peerPath, 'utf8'),
  'REWRITTEN_DURING_BODY',
  'a sync read after reading a response body sees a write that landed during it',
);

console.log('node-shims-fetch-coherence: all assertions passed');
