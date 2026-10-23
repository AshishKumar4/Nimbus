#!/usr/bin/env bun
// A synchronous write parks bytes in the facet and nothing else. Until the
// debounced write-back the ONLY thing that carried them to the authority was
// the drain at process exit — so a resident server that wrote synchronously
// never wrote back at all, and a peer reading the same path saw the pre-write
// bytes for the entire life of the process. Measured, not theorised.
//
// This drives the REAL shim against the REAL session and asserts three
// things the fix has to hold together:
//   1. writeFileSync / appendFileSync reach the authority while the process
//      is still running.
//   2. The batching survives: a burst of sync writes to one path costs one
//      round trip, not one per write.
//   3. The process's log is drained, so the exit drain has nothing left.

import assert from 'node:assert/strict';
import { createAuthority } from './lib/resident-body.mjs';
import { shimsOnSession } from './lib/shims-on-session.mjs';

const authority = createAuthority();
const dir = '/home/user/t';
authority.kfs.mkdir(dir, { recursive: true });
const { fs, handle } = shimsOnSession({ authority });
const waves = () => handle.log.calls.writeBatchStream ?? 0;

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const onAuthority = (p) => (authority.kfs.exists(p) ? authority.kfs.readFileString(p) : null);

// Warm the coherence cursor first. A facet's very first ACQUIRE reports a
// poison — it holds no epoch yet — which evicts the whole resident set and
// refetches it, and a refetch of a path that has a held write flushes that
// write on the way past. Incidental, and not the write-back under test, so
// spend it before measuring anything.
await fs.promises.readFile(`${dir}/.warm`, 'utf8').catch(() => {});

// ── 1. a plain sync write reaches the authority while the process runs ──
fs.writeFileSync(`${dir}/w.txt`, 'SYNC_WRITTEN');
assert.equal(onAuthority(`${dir}/w.txt`), null, 'not written through synchronously');
await settle(60);
assert.equal(
  onAuthority(`${dir}/w.txt`),
  'SYNC_WRITTEN',
  'writeFileSync reached the authority without waiting for process exit',
);
assert.equal(globalThis.__nimbusProcessFs.client.pendingBytes, 0, 'the log drained what it wrote');

// ── 2. appendFileSync too ──
fs.appendFileSync(`${dir}/a.txt`, 'A1');
fs.appendFileSync(`${dir}/a.txt`, 'A2');
await settle(60);
assert.equal(
  onAuthority(`${dir}/a.txt`),
  'A1A2',
  'appendFileSync reached the authority without waiting for process exit',
);

// ── 3. the batching survives: a burst is one round trip, not N ──
const before = waves();
for (let i = 0; i < 500; i++) fs.writeFileSync(`${dir}/burst.txt`, `v${i}`);
await settle(80);
assert.equal(onAuthority(`${dir}/burst.txt`), 'v499', 'the last value won');
const spent = waves() - before;
assert.ok(
  spent > 0 && spent <= 3,
  `500 sync writes to one path cost ${spent} write RPCs — the batch must not become one RPC per write`,
);
assert.equal(globalThis.__nimbusProcessFs.client.pendingBytes, 0, 'nothing left in the log after the burst');

console.log(`node-shims-sync-write-back: all assertions passed (burst cost ${spent} write RPC(s))`);
