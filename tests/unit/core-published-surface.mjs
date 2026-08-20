#!/usr/bin/env bun
// The platform split must not remove names core already published.
// @nimbus-sh/core@0.5.0 ships them, and a real consumer imports them today
// (Proteus merge-back.ts: CHUNK_SIZE and the MAX_TX_* set from
// '@nimbus-sh/core/constants.js'). Platform owns the single definition; core
// forwards. Checked against dist — the bytes a publish would ship.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CORE_DIST = new URL('../../packages/core/dist/', import.meta.url);

// The value set @nimbus-sh/core@0.5.0 exports from constants.js and the
// platform split moved to @nimbus-sh/platform/limits.js.
const MOVED_CONSTANTS = [
  'CHUNK_SIZE',
  'MAX_GLOBAL_WRITE_STREAM_CREDIT_BYTES',
  'MAX_RPC_SAFE_PAYLOAD_BYTES',
  'MAX_TX_BLOB_BYTES',
  'MAX_TX_LOGICAL_ROWS',
  'MAX_TX_SQL_EXECS',
  'PRE_BUNDLE_CONCURRENCY',
  'PRE_BUNDLE_SLICE_CAP_BYTES',
  'SUPERVISOR_HEAP_CEILING_BYTES',
  'SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES',
  'SUPERVISOR_READ_RESERVE_BYTES',
];

{
  const constants = await import(new URL('constants.js', CORE_DIST).href);
  const limits = await import('../../packages/platform/dist/limits.js');
  for (const name of MOVED_CONSTANTS) {
    assert.ok(name in constants, `core/constants.js still exports ${name}`);
    assert.equal(constants[name], limits[name],
      `${name} forwards platform's definition, one source of truth`);
  }
}

// The type set @nimbus-sh/core@0.5.0 exports from vfs/sqlite-vfs.d.ts and
// the split moved to @nimbus-sh/platform/w7-frame.js. Types are erased at
// runtime, so the declaration file is the checkable artifact.
{
  const dts = readFileSync(new URL('vfs/sqlite-vfs.d.ts', CORE_DIST), 'utf8');
  for (const name of ['VfsInodeKind', 'BatchInodeEntry', 'BatchChunkEntry', 'BatchWritePayload']) {
    assert.match(dts, new RegExp(`export.*\\b${name}\\b`),
      `core/vfs/sqlite-vfs.d.ts still exports ${name}`);
  }
}

console.log('ok - core-published-surface (0.5.0 exports stay reachable, forwarded from platform)');
