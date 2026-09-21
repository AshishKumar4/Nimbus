#!/usr/bin/env bun
// Every partial mutation the bridge offers — writeRange, truncate, utimes,
// chmod, chown — bumps the path's revision exactly as writeFile does, and a
// facet holding the path needs to tell that bump apart from a peer's. The
// bridge answers each with a VfsMutationReceipt: the path's revision
// immediately before the mutation and the clock immediately after, both
// read in the mutation's own synchronous turn. This test pins the shape,
// the ordering, and the one property the facet's stamp rule rests on: a
// peer write between two own mutations shows up as a `before` past the
// previous `after`.

import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { SqliteRuntimeFsBridge } from '../../packages/core/src/runtime/sqlite-runtime-fs-bridge.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { SqliteVFSProvider } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { VFS } from '../../packages/core/src/substrate/lifo/kernel/vfs/index.ts';
import { NativeFsProvider } from '../../packages/core/src/substrate/lifo/kernel/vfs/providers/NativeFsProvider.ts';
import * as nodeFs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const vfs = rawVfs.as(CRED_KERNEL);
const bridge = new SqliteRuntimeFsBridge(vfs, rawVfs);
const enc = new TextEncoder();
const dec = new TextDecoder();

const P = '/home/user/receipts.txt';
const OTHER = '/home/user/other.txt';

function assertReceipt(label, receipt, priorPathRevision) {
  assert.equal(typeof receipt, 'object', `${label}: answers with an object`);
  assert.deepEqual(Object.keys(receipt).sort(), ['after', 'before'], `${label}: exactly before and after`);
  assert.equal(receipt.before, priorPathRevision, `${label}: before is the path's prior revision`);
  assert.equal(receipt.after, rawVfs.revision(), `${label}: after is the global clock`);
  assert.equal(receipt.after, rawVfs.revision(P), `${label}: after is also the path's new revision`);
  assert.ok(receipt.after > receipt.before, `${label}: the mutation moved the clock (${receipt.before} -> ${receipt.after})`);
}

const mutations = [
  ['writeRange', () => bridge.writeRange(P, 0, enc.encode('RANGE'))],
  ['truncate', () => bridge.truncate(P, 3)],
  ['utimes', () => bridge.utimes(P, 1_600_000_000_000, 1_600_000_000_000)],
  ['chmod', () => bridge.chmod(P, 0o755)],
  ['chown', () => bridge.chown(P, 1000, 1000)],
];

// ── Shape and ordering, each mutation chained on the previous ──
{
  const created = await bridge.writeFile(P, 'hello world');
  assert.equal(typeof created, 'number', 'writeFile keeps answering with the bare revision');
  let previous = created;
  for (const [label, mutate] of mutations) {
    const prior = rawVfs.revision(P);
    assert.equal(prior, previous, `${label}: nothing touched the path since the previous mutation`);
    const receipt = await mutate();
    assertReceipt(label, receipt, prior);
    assert.equal(receipt.before, previous, `${label}: before equals the previous after when nobody intervened`);
    previous = receipt.after;
  }
  assert.equal(dec.decode(await bridge.readFile(P)), 'RAN', 'the range then the truncate landed');
}

// ── A peer write to another path moves the clock, not the path ──
{
  const last = rawVfs.revision(P);
  vfs.writeFile(OTHER, enc.encode('elsewhere'));
  assert.ok(rawVfs.revision() > last, 'the clock moved');
  assert.equal(rawVfs.revision(P), last, 'the path did not');
  const receipt = await bridge.utimes(P, 1_600_000_000_001, 1_600_000_000_001);
  assert.equal(receipt.before, last, 'before is still the previous own after: a write elsewhere is not an intervention');
  assert.ok(receipt.after > rawVfs.revision(OTHER), 'after is past the peer clock');
}

// ── A peer write to THIS path shows up as a before past the previous after ──
for (const [label, mutate] of mutations) {
  const own = await bridge.chmod(P, 0o644);
  vfs.writeFile(P, enc.encode('PEER BYTES HERE'));
  const peerRevision = rawVfs.revision(P);
  assert.ok(peerRevision > own.after, 'the peer write bumped the path');
  const receipt = await mutate();
  assertReceipt(`${label} after a peer write`, receipt, peerRevision);
  assert.ok(receipt.before > own.after, `${label}: before is past the previous own after, so a stamp at ${own.after} must not advance`);
}

// ── Errors are still errors: no receipt for a mutation that did not happen ──
await assert.rejects(async () => bridge.truncate('/home/user/missing.txt', 0), { code: 'ENOENT' });
await assert.rejects(async () => bridge.utimes('/home/user/missing.txt', 0, 0), { code: 'ENOENT' });
await assert.rejects(async () => bridge.chmod('/home/user/missing.txt', 0o644), { code: 'ENOENT' });
await assert.rejects(async () => bridge.chown('/home/user/missing.txt', 1, 1), { code: 'ENOENT' });

// ── Mount branch: the raw clock never moves for a mount ──
// A kernel mount outside SQLite answers a receipt whose two sides are equal:
// ACQUIRE never lists mount paths, so nothing is stamped from it.
{
  const kernel = new VFS();
  kernel.mount('/home', new SqliteVFSProvider(rawVfs, 'home'));
  const root = mkdtempSync(join(tmpdir(), 'nimbus-receipts-'));
  kernel.mount('/mnt', new NativeFsProvider(root, nodeFs));
  const mounted = new SqliteRuntimeFsBridge(vfs, rawVfs, undefined, () => kernel);
  const clock = rawVfs.revision();
  const created = await mounted.writeRange('/mnt/f.txt', 0, enc.encode('mount'));
  assert.deepEqual(created, { before: clock, after: clock }, 'writeRange on a mount reports a clock that did not move');
  assert.deepEqual(await mounted.truncate('/mnt/f.txt', 2), { before: clock, after: clock });
  // (The native provider supports no timestamps, modes or owners, so the
  // metadata forms answer ENOTSUP before any receipt is minted.)
  assert.equal(rawVfs.revision(), clock, 'the raw clock never moved');
  assert.equal(nodeFs.readFileSync(join(root, 'f.txt'), 'utf8'), 'mo', 'and the mount took the mutations');
  rmSync(root, { recursive: true, force: true });
}

console.log('runtime-fs-bridge-receipts: all assertions passed');
