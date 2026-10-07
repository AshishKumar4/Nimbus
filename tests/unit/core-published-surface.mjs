#!/usr/bin/env bun
// The platform split must not remove names core already published.
// @nimbus-sh/core@0.5.0 ships them, and a real consumer imports them today
// (Proteus merge-back.ts: CHUNK_SIZE and the MAX_TX_* set from
// '@nimbus-sh/core/constants.js'). Platform owns the single definition; core
// forwards. Checked against dist — the bytes a publish would ship.

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

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
// runtime, so a consumer's view is the compiler's: a module importing and
// using each name from the published declarations type-checks.
{
  const ts = (await import('typescript')).default;
  const consumer = fileURLToPath(new URL('consumer.ts', CORE_DIST));
  const source = [
    "import type { VfsInodeKind, BatchInodeEntry, BatchChunkEntry, BatchWritePayload } from './vfs/sqlite-vfs.js';",
    'export type Uses = [VfsInodeKind, BatchInodeEntry, BatchChunkEntry, BatchWritePayload];',
  ].join('\n');
  const options = { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true, strict: true, skipLibCheck: true };
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  host.readFile = (file) => (file === consumer ? source : readFile(file));
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (file) => file === consumer || fileExists(file);
  const program = ts.createProgram([consumer], options, host);
  const errors = ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  assert.deepEqual(errors, [], 'a consumer of core/vfs/sqlite-vfs.js still finds VfsInodeKind, BatchInodeEntry, BatchChunkEntry, BatchWritePayload');
}

console.log('ok - core-published-surface (0.5.0 exports stay reachable, forwarded from platform)');
