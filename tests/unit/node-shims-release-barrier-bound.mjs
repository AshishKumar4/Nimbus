#!/usr/bin/env bun
// The RELEASE barrier ahead of egress must be BOUNDED.
//
// It was not, and it took `npx sv create` off main: RELEASE waited for every
// parked write to drain, which ends with `while (pendingMutations > 0)`.
// That wait is right at process exit, where no new writes are coming, and is a
// livelock anywhere else — a facet unpacking a tarball adds mutations faster
// than the loop retires them. Sited ahead of egress it meant the request never
// left the facet: the program ran, printed, and never reported an exit.
//
// The shape the original fetch-coherence test missed is a facet that writes
// CONTINUOUSLY WHILE fetching. That is the only condition under which the
// quiesce loop never terminates, and it is what this test reproduces: writes
// keep landing for as long as the fetch is outstanding.

import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createAuthority } from './lib/resident-body.mjs';
import { processBridge } from './lib/process-bridge.mjs';
import { observed, sessionShims } from './lib/session-shims.mjs';

const dec = new TextDecoder();
const dir = '/home/user/t';
const authority = createAuthority();
authority.kfs.mkdir(dir.slice(1), { recursive: true, mode: 0o755 });
const bridge = observed(processBridge(authority.rawVfs, authority.rawVfs.as(CRED_KERNEL)));

// The authority is a round trip away. Latency is what makes the starvation
// real: with an instant supervisor the drain always outpaces the writer, and
// the quiesce loop the old RELEASE rode on looks harmless. 20 ms spans the
// writer's 1 ms cadence twenty times over.
const rawSetTimeout = globalThis.setTimeout;
const wait = (ms) => new Promise((resolve) => rawSetTimeout(resolve, ms));
const LATENCY_MS = 20;
const slow = (fn) => async (...args) => { await wait(LATENCY_MS); return fn(...args); };

globalThis.__nimbusProcessExitPromise = new Promise(() => {});

// The network stub does not resolve until the test lets it, so the facet is
// genuinely mid-fetch while it keeps writing — an unpack streaming to disk.
let releaseNetwork;
const networkReached = { yes: false };
globalThis.fetch = async () => {
  networkReached.yes = true;
  await new Promise((resolve) => { releaseNetwork = resolve; });
  return new Response('ok');
};

const out = sessionShims(authority, {
  cwd: dir,
  overrides: (call) => ({
    fsAcquire: slow((...args) => call('fsAcquire', args)),
    fsReadBatch: slow((...args) => call('fsReadBatch', args)),
    writeBatchStream: slow((...args) => call('writeBatchStream', args)),
  }),
  tail: '\n;return { fs: __fsMod, fetch: globalThis.fetch };',
});
const { fs } = out;

// Writes are already parked when the request is issued, and more keep landing
// for as long as it is outstanding.
for (let i = 0; i < 40; i++) fs.writeFileSync(`${dir}/pre-${i}.txt`, `v${i}`);

let writing = true;
let written = 40;
// The writer's cadence must not pay the ACQUIRE barrier the shims wrap into
// setTimeout — that would slow it to the drain's pace and starve nothing.
// The deadline is raw for the same reason: it has to fire no matter what the
// barrier is doing.
const keepWriting = (async () => {
  while (writing) {
    fs.writeFileSync(`${dir}/stream-${written++}.txt`, 'x'.repeat(64));
    await wait(1);
  }
})();

const deadline = new Promise((_, reject) => {
  rawSetTimeout(() => reject(new Error(
    'the request never left the facet: RELEASE waited on a condition a writing process never reaches',
  )), 5_000);
});

// The barrier may delay the request. It may not prevent it.
const pending = out.fetch('https://registry.invalid/pkg.tgz');
await Promise.race([
  (async () => { while (!networkReached.yes) await wait(5); })(),
  deadline,
]);

assert.ok(networkReached.yes, 'the request reached the network while the facet was still writing');
assert.ok(written > 40, 'the facet really was writing continuously across the barrier');

releaseNetwork();
const response = await pending;
assert.equal(response.status, 200, 'and the caller still gets its response');

writing = false;
await keepWriting;

// RELEASE is a barrier, not a best-effort: everything parked when the request
// was issued must be at the authority, or an outside observer could act on an
// effect of a write the authority does not have.
const settle = async () => {
  for (let i = 0; i < 40; i++) {
    if (await bridge.readFile(`${dir}/pre-39.txt`) !== null) return;
    await wait(25);
  }
};
await settle();
assert.equal(
  dec.decode(await bridge.readFile(`${dir}/pre-39.txt`)),
  'v39',
  'the writes parked when the request was issued reached the authority',
);

console.log(`node-shims-release-barrier-bound: all assertions passed (${written} writes across the barrier)`);
