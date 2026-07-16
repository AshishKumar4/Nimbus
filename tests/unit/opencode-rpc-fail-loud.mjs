#!/usr/bin/env bun
// Regression test for the birpc pending-call leak (bundle-patches.ts
// nimbusPatchRpcFailLoud). opencode's TUI runs a birpc client + server in ONE
// facet isolate and fans out an RPC per keystroke. Upstream `listen` dispatches
// `await rpc[method](input)` with NO try/catch and the client only settles a
// pending call on a `rpc.result` frame — so a REJECTING server method (common on
// Nimbus's VFS/DO substrate) posts nothing back, the client's pending entry is
// never deleted, and its Promise never settles. Each leaked entry pins the
// resolver + the caller's continuation → activity-scaled JS heap growth → the
// 128 MiB facet OOMs in ~10-15 s.
//
// This test extracts the REAL `listen` (v) and `client` (S) functions from the
// STAGED, PATCHED chunk (the shipped bytes) and drives them over a synthetic
// in-isolate message channel — the same client+server-in-one-isolate topology
// the facet uses. It proves:
//   - happy path unchanged: a resolving method still resolves the caller with
//     the identical result, and frees its pending entry;
//   - error path fixed: a REJECTING method rejects the caller with the server's
//     error message, and frees its pending entry;
//   - after a burst of rejections settle, the client's private pending map is
//     EMPTY (size 0) — the leak is closed.
// On the pre-patch chunk the reject path never settles and pending.size stays
// pinned at the burst size (RED).

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OPENCODE_ARTIFACT_VERSION,
  OPENCODE_CHUNKS_PACK,
} from '../../packages/worker/src/opencode-artifact.generated.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const assetDir = path.resolve(
  here,
  '../../packages/worker/public/_assets/opencode',
  OPENCODE_ARTIFACT_VERSION,
);

if (!OPENCODE_CHUNKS_PACK || !existsSync(path.join(assetDir, OPENCODE_CHUNKS_PACK))) {
  console.log(
    'opencode-rpc-fail-loud SKIP: staged opencode chunk pack absent (no build dist) — ' +
      'rebuild via scripts/opencode/build-node.ts + bundle-opencode.mjs',
  );
  process.exit(0);
}

const pack = JSON.parse(readFileSync(path.join(assetDir, OPENCODE_CHUNKS_PACK), 'utf8'));
const rpcEntries = Object.entries(pack).filter(
  ([, src]) => src.includes('"rpc.result"') && src.includes('"rpc.event"'),
);
assert.equal(rpcEntries.length, 1, `exactly one shared Rpc chunk (got ${rpcEntries.length})`);
const [rpcName, rpcSrc] = rpcEntries[0];

// The patched transport MUST carry the fail-loud contract in the shipped bytes.
assert.ok(rpcSrc.includes('"rpc.error"'), `${rpcName}: server emits an rpc.error frame on rejection`);
assert.ok(/\.reject\(/.test(rpcSrc), `${rpcName}: client rejects the pending promise on rpc.error`);
assert.ok(/\{\s*resolve\s*:/.test(rpcSrc) || rpcSrc.includes('{resolve:'), `${rpcName}: pending map stores a reject handle`);
console.log(`  [1] shared Rpc chunk (${rpcName}) carries the fail-loud contract in the staged bytes`);

// Extract a top-level `function <name>(...) { ... }` by balanced-brace scan.
function extractFn(src, name) {
  const sig = `function ${name}(`;
  const start = src.indexOf(sig);
  assert.ok(start >= 0, `chunk contains ${sig}`);
  const bodyOpen = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyOpen; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

// `v` = listen(rpc, scope), `S` = client(target). Both are import-free (they use
// only globalThis / Map / Promise / JSON / Error), so they evaluate standalone.
const listenSrc = extractFn(rpcSrc, 'v');
const clientSrc = extractFn(rpcSrc, 'S');

// Capture the client's private pending Map without touching the artifact: wrap
// the global Map so the two Maps `client()` constructs are recorded in order
// (pending first: `let n=new Map,s=new Map` — n is the pending-call map).
const RealMap = Map;
let capturedMaps = [];
class TrackedMap extends RealMap {
  constructor(...args) {
    super(...args);
    capturedMaps.push(this);
  }
}

const factory = new Function(
  'Map',
  `${listenSrc}\n${clientSrc}\nreturn { listen: v, client: S };`,
);
const { listen, client } = factory(TrackedMap);

// Synthetic in-isolate channel: postMessage on one side delivers asynchronously
// to the other side's onmessage — exactly how the facet's in-isolate Worker
// polyfill bridges the client and the API-server worker.
const serverScope = { onmessage: null, postMessage: (data) => queueMicrotask(() => clientTarget.onmessage({ data })) };
const clientTarget = { onmessage: null, postMessage: (data) => queueMicrotask(() => serverScope.onmessage({ data })) };

const rpc = {
  ok: async (input) => ({ echoed: input, ok: true }),
  boom: async () => { throw new Error('server method blew up'); },
};

listen(rpc, serverScope);
capturedMaps = [];
const c = client(clientTarget);
const pending = capturedMaps[0];
assert.ok(pending instanceof RealMap, 'captured the client pending map');

// Happy path: resolves with the identical result, pending entry freed.
const okResult = await c.call('ok', { k: 42 });
assert.deepEqual(okResult, { echoed: { k: 42 }, ok: true }, 'resolving method resolves with identical result');
assert.equal(pending.size, 0, 'happy-path call freed its pending entry');
console.log('  [2] happy path: resolving method resolves identically and frees its pending entry');

// Error path: rejects with the server error message, pending entry freed.
let rejected = null;
try {
  await c.call('boom', {});
  assert.fail('rejecting method must reject the caller, not hang');
} catch (err) {
  rejected = err;
}
assert.ok(rejected instanceof Error, 'rejecting method rejects the caller');
assert.equal(rejected.message, 'server method blew up', 'reject carries the server error message');
assert.equal(pending.size, 0, 'rejected call freed its pending entry');
console.log('  [3] error path: rejecting method rejects the caller with the server message and frees its entry');

// The leak: a burst of rejecting calls must ALL settle and leave the pending
// map empty. On the pre-patch transport these never settle and pending.size
// stays pinned at BURST (RED); here it must drain to 0 (GREEN).
const BURST = 200;
const settled = await Promise.allSettled(
  Array.from({ length: BURST }, () => c.call('boom', {})),
);
assert.ok(settled.every((s) => s.status === 'rejected'), 'every burst call rejected (none hung)');
assert.equal(pending.size, 0, `pending map is empty after ${BURST} rejections (leak closed)`);
console.log(`  [4] ${BURST} concurrent rejections all settle and the pending map drains to 0 — no leak`);

console.log(
  'opencode-rpc-fail-loud OK: the staged birpc transport fails loud on rejection ' +
    '— rejected calls reject the caller and release their pending entry',
);
