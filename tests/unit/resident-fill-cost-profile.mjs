#!/usr/bin/env bun
// What a blocking fill actually costs, measured rather than argued.
//
// The filler currently blocks boot until the whole filesystem is in the
// facet's SQLite. That is what makes the guarantee unconditional; the question
// is what it costs, and the answer decides whether the fill stays blocking,
// moves to the background (the guarantee becomes probabilistic during the
// window) or becomes bounded (which reintroduces admission — the exact thing
// this store exists to delete).
//
// This measures the two quantities that transfer to production:
//
//   ROUND TRIPS — how many supervisor calls a fill takes. This is a pure
//     function of the tree and the RPC bounds, so the number measured here is
//     the number production pays. It is the figure that matters, because in
//     production each one is a cross-isolate hop rather than a function call.
//
//   SQLITE WRITE TIME — how long the rows take to land, which is in the same
//     engine locally as in a facet.
//
// It deliberately does NOT claim a production wall-clock: the per-call latency
// of a real facet→supervisor hop is not reproducible in this process, and
// multiplying a local function call by a guessed hop cost would be a made-up
// number, not a measurement.
//
// Run directly; it prints a table rather than asserting a threshold, because a
// performance figure that fails a build is a flake generator.

import { SqliteVFS } from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { CRED_KERNEL } from '../../packages/worker/src/runtime/os-contracts.ts';
import { _rpcFsList, _rpcFsReadBatch } from '../../packages/worker/src/session/rpc.ts';
import { SessionProcessSupervisor } from '../../packages/worker/src/runtime/session-process-supervisor.ts';
import {
  FS_LIST_PAGE_LIMIT,
  FS_READ_BATCH_PATH_LIMIT,
  FS_READ_BATCH_REQUEST_BYTES,
} from '../../packages/worker/src/constants.ts';

/**
 * Tree shapes worth separating, because the two RPC bounds bind on different
 * ones and the fill cost is completely different as a result.
 */
const SHAPES = [
  { name: 'small app        ', files: 1_200, avgBytes: 4 * 1024 },
  { name: 'pi-shaped install', files: 16_357, avgBytes: 6 * 1024 },
  { name: 'few large assets ', files: 40, avgBytes: 2 * 1024 * 1024 },
];

console.log('resident fill cost profile');
console.log(
  `  bounds: ${FS_READ_BATCH_PATH_LIMIT} paths/call, `
  + `${(FS_READ_BATCH_REQUEST_BYTES / 1024 / 1024).toFixed(0)} MiB/call, `
  + `${FS_LIST_PAGE_LIMIT} entries/list page`,
);
console.log('');
console.log('  shape              files     bytes   list  read   total   binding   sql');
console.log('                                        rtt   rtt     rtt     bound    ms');

for (const shape of SHAPES) {
  const harness = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const kfs = vfs.as(CRED_KERNEL);
  kfs.mkdir('app', { recursive: true, mode: 0o755 });

  let totalBytes = 0;
  for (let i = 0; i < shape.files; i++) {
    const dir = `app/d${Math.floor(i / 100)}`;
    if (i % 100 === 0) kfs.mkdir(dir, { recursive: true, mode: 0o755 });
    const body = 'x'.repeat(shape.avgBytes);
    kfs.writeFile(`${dir}/f${i}.dat`, body, { mode: 0o644 });
    totalBytes += shape.avgBytes;
  }

  const host = { sqliteFs: vfs, processes: new SessionProcessSupervisor(), ensureSqliteFs() {} };

  // ── Enumerate, counting pages ────────────────────────────────────────────
  let listRtt = 0;
  let after = null;
  const entries = [];
  for (;;) {
    listRtt++;
    const page = await _rpcFsList(host, after, FS_LIST_PAGE_LIMIT);
    for (const e of page.entries) if (e.kind === 'file') entries.push(e);
    if (page.next === null) break;
    after = page.next;
  }

  // ── Pack exactly as the filler does, and count the calls ─────────────────
  const CHUNK = 1_048_576;
  const ranges = [];
  for (const e of entries) {
    const parts = Math.max(1, Math.ceil(e.size / CHUNK));
    for (let p = 0; p < parts; p++) {
      ranges.push({
        path: e.path,
        offset: p * CHUNK,
        length: Math.min(CHUNK, Math.max(0, e.size - p * CHUNK)),
      });
    }
  }

  let readRtt = 0;
  let pathBound = 0;
  let byteBound = 0;
  const t0 = performance.now();
  for (let at = 0; at < ranges.length;) {
    const batch = [];
    let bytes = 0;
    while (
      at < ranges.length
      && batch.length < FS_READ_BATCH_PATH_LIMIT
      && (batch.length === 0 || bytes + ranges[at].length <= FS_READ_BATCH_REQUEST_BYTES)
    ) {
      bytes += ranges[at].length;
      batch.push(ranges[at]);
      at++;
    }
    if (batch.length === FS_READ_BATCH_PATH_LIMIT) pathBound++; else byteBound++;
    readRtt++;
    await _rpcFsReadBatch(host, batch);
  }
  const sqlMs = performance.now() - t0;

  const binding = pathBound > byteBound ? 'paths' : 'bytes';
  console.log(
    `  ${shape.name}  ${String(shape.files).padStart(6)}`
    + `  ${(totalBytes / 1024 / 1024).toFixed(0).padStart(6)}M`
    + `  ${String(listRtt).padStart(5)}`
    + `  ${String(readRtt).padStart(4)}`
    + `  ${String(listRtt + readRtt).padStart(6)}`
    + `  ${binding.padStart(8)}`
    + `  ${sqlMs.toFixed(0).padStart(5)}`,
  );
}

console.log('');
console.log('  rtt = supervisor round trips. In production each is a cross-isolate');
console.log('  hop; here each is a function call, so only the COUNT transfers.');
