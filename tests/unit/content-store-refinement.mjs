#!/usr/bin/env bun
/**
 * content-store-refinement — the refinement bridge from FormalModelsLane's
 * Lean model of the content store (Nimbus.ContentStore.Step) to SqliteVFS.
 *
 * Each case in lean/fixtures/content-store.json is an operation sequence the
 * model generated with the observable state it proves: what every path, every
 * snapshot and every open descriptor reads, and after GC exactly which chunks
 * the store holds (no leak, no loss). This replays each sequence through the
 * deployed TypeScript and asserts the same observations.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { cutContent, chunkHash, hex } from '../../packages/core/src/vfs/content-chunking.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const FIXTURE = 'lean/fixtures/content-store.json';
const fixture = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', FIXTURE), 'utf8'));
assert.equal(fixture.fixture, 'content-store');
const PIECE = fixture.piece.bytes;

const pieceCache = new Map();
/** The model's piece h: PIECE bytes of xorshift32 seeded (h * 2654435761 + 1) mod 2^32, never 0. */
function piece(h) {
  let bytes = pieceCache.get(h);
  if (bytes) return bytes;
  bytes = new Uint8Array(PIECE);
  let s = (Math.imul(h, 2654435761) + 1) >>> 0;
  if (s === 0) s = 1;
  for (let i = 0; i < PIECE; i++) {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    bytes[i] = s & 255;
  }
  pieceCache.set(h, bytes);
  return bytes;
}

function bytesOf(pieces) {
  const out = new Uint8Array(pieces.length * PIECE);
  pieces.forEach((h, i) => out.set(piece(h), i * PIECE));
  return out;
}

const hashesOf = (pieces) => {
  const data = bytesOf(pieces);
  const out = [];
  let start = 0;
  for (const end of cutContent(data)) { out.push(hex(chunkHash(data.subarray(start, end)))); start = end; }
  return out;
};

const same = (actual, pieces, label) => {
  assert.equal(actual.length, pieces.length * PIECE, `${label}: size`);
  assert.ok(Buffer.from(actual).equals(Buffer.from(bytesOf(pieces))), `${label}: bytes`);
};

const snapshotsSupported = typeof SqliteVFS.prototype.snapshot === 'function';
let ran = 0;
let skipped = 0;
for (const [index, testCase] of fixture.cases.entries()) {
  if (!snapshotsSupported && testCase.ops.some((op) => ['snapshot', 'drop', 'restore'].includes(op.op))) {
    skipped++;
    continue;
  }
  const harness = createSqliteVfsTestHarness();
  let raw = new SqliteVFS(harness.sql, harness.ctx);
  let vfs = raw.as(CRED_KERNEL);
  let fds = [];
  const where = (step, op) => `case ${index} op ${step} ${JSON.stringify(op)}`;
  for (const [step, op] of testCase.ops.entries()) {
    const label = where(step, op);
    switch (op.op) {
      case 'write':
        vfs.writeFile(op.path, bytesOf(op.pieces));
        break;
      case 'edit':
        vfs.writeRange(op.path, op.at * PIECE, piece(op.piece));
        break;
      case 'delete':
        vfs.unlink(op.path);
        break;
      case 'copy':
        vfs.copyFile(op.from, op.to);
        break;
      case 'rename':
        vfs.rename(op.from, op.to);
        break;
      case 'snapshot':
        raw.snapshot(op.name);
        break;
      case 'drop':
        raw.dropSnapshot(op.name);
        break;
      case 'restore':
        raw.restore(op.name);
        break;
      case 'open-unlink': {
        assert.equal(op.fd, fds.length, `${label}: fd ids are stack-ordered`);
        fds.push(raw.openDescription(op.path, CRED_KERNEL, { read: true, write: false }));
        vfs.unlink(op.path);
        break;
      }
      case 'close':
        assert.equal(op.fd, fds.length - 1, `${label}: close is always the most recent open`);
        fds.pop().close();
        break;
      case 'reset':
        raw = new SqliteVFS(createSqliteVfsTestHarness(harness.db).sql, harness.ctx);
        vfs = raw.as(CRED_KERNEL);
        fds = [];
        break;
      case 'gc':
        // To a fixpoint: what an open descriptor pins stays queued (R3).
        for (let pass = 0; raw.runContentMaintenance(64).transactions > 0; pass++) {
          assert.ok(pass < 1000, `${label}: GC did not reach a fixpoint`);
        }
        break;
      case 'check': {
        for (const [path, pieces] of Object.entries(op.files)) {
          if (pieces === null) assert.equal(vfs.exists(path), false, `${label}: ${path} absent`);
          else same(vfs.readFile(path), pieces, `${label}: ${path}`);
        }
        for (const [name, files] of Object.entries(op.snapshots ?? {})) {
          const view = raw.at(name);
          for (const [path, pieces] of Object.entries(files)) {
            if (pieces === null) assert.equal(view.exists(path), false, `${label}: ${name}:${path} absent`);
            else same(view.readFile(path), pieces, `${label}: ${name}:${path}`);
          }
        }
        assert.equal(fds.length, (op.fds ?? []).length, `${label}: open descriptors`);
        (op.fds ?? []).forEach((pieces, fd) => {
          same(fds[fd].read(0, pieces.length * PIECE + 1), pieces, `${label}: fd ${fd}`);
        });
        break;
      }
      case 'checkStore': {
        const expected = new Set(op.reachable.flatMap(hashesOf));
        const stored = new Set(harness.sql.exec('SELECT hash FROM vfs_chunks').map((row) => hex(new Uint8Array(row.hash))));
        const lost = [...expected].filter((h) => !stored.has(h));
        const leaked = [...stored].filter((h) => !expected.has(h));
        assert.deepEqual(lost, [], `${label}: chunks lost`);
        assert.deepEqual(leaked, [], `${label}: chunks leaked`);
        assert.deepEqual(harness.sql.exec('SELECT id FROM vfs_contents WHERE state = 2'), [], `${label}: dying content left`);
        // Only what an open descriptor pins may still be queued (R3); the
        // leak check above already holds every stored chunk to reachability.
        if (fds.length === 0) {
          assert.equal(harness.sql.exec('SELECT COUNT(*) AS n FROM vfs_gc_queue')[0].n, 0, `${label}: queue not empty`);
        }
        break;
      }
      default:
        throw new Error(`${label}: unknown op`);
    }
  }
  ran++;
}

assert.ok(ran > 0);
console.log(`content-store-refinement: ${ran} cases of ${FIXTURE} passed${skipped ? `, ${skipped} need snapshots` : ''}`);
