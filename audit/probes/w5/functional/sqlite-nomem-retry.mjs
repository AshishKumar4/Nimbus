// W5 functional: SQLITE_NOMEM caught at writeBatch + halve-retry path
// (Lever 9), and a DiagFailure entry is recorded with cause='sqlite_nomem'.
//
// Strategy:
//   - Build a writeBatch payload with N inodes + N chunks.
//   - Inject ONE failure on the first transactionSync (simulates a 500-row
//     batch hitting SQLITE_NOMEM); subsequent calls succeed.
//   - Assert: writeBatch DOES NOT throw the original SQLITE_NOMEM up; it
//     halves and retries; both halves complete; all rows present in SQL.
//   - Assert: the OOM ring buffer has an entry with cause='sqlite_nomem'.

import { SqliteVFS } from '../../../../src/vfs/sqlite-vfs.ts';
import { makeMockCtx } from '../_mock-sql.mjs';
import { ok, eq, gte, group, summary, throws } from '../_tap.mjs';

let getFailures, recordFailure, classifyError;
try {
  ({ getFailures, recordFailure } = await import('../../../../src/observability/oom-discriminator.ts'));
  ({ classifyError } = await import('../../../../src/observability/oom-classify.ts'));
} catch (e) {
  ok('oom-discriminator + oom-classify modules exist', false, e.message);
  summary('w5/functional/sqlite-nomem-retry');
}

group('classifier', () => {
  eq('SQLITE_NOMEM string → sqlite_nomem',
    classifyError(new Error('SQLITE_NOMEM: out of memory')), 'sqlite_nomem');
  eq('out of memory → sqlite_nomem',
    classifyError(new Error('out of memory')), 'sqlite_nomem');
  eq('plain string accepted',
    classifyError('SQLITE_NOMEM occurred during commit'), 'sqlite_nomem');
  eq('unknown error → unknown',
    classifyError(new Error('something weird')), 'unknown');
  eq('clone-refused → clone_refused',
    classifyError(new Error('Cannot deserialize cloned data')), 'clone_refused');
  eq('rpc timeout → rpc_timeout',
    classifyError(new Error('TimeoutError: 60000 ms')), 'rpc_timeout');
});

group('writeBatch retries on SQLITE_NOMEM (halve)', () => {
  const { ctx, sql } = makeMockCtx();
  const vfs = new SqliteVFS(sql, ctx);
  vfs.mkdir('/nm', { recursive: true });

  // Build a 12-row payload so halving (12→6→3) is observable and bounded.
  const inodes = [];
  const chunks = [];
  for (let i = 0; i < 12; i++) {
    const path = `/nm/file${i}.bin`;
    inodes.push({
      path, parentPath: '/nm', isDir: false,
      size: 4, mtime: 0, mode: 0o644, chunkCount: 1,
    });
    chunks.push({ path, chunkId: 0, data: new Uint8Array([i, i, i, i]) });
  }

  // Inject ONE failure — first transactionSync call throws SQLITE_NOMEM.
  // Halving means the first half (6 rows) gets re-tried with a fresh
  // transaction; we want THAT to succeed (so total inserts: 1 failed
  // 12-row attempt + 1 successful 6-row + 1 successful 6-row).
  sql.injectFailures(1, 'SQLITE_NOMEM: out of memory');

  let threw = false;
  try { vfs.writeBatch({ inodes, chunks }); } catch (e) { threw = true; }
  ok('writeBatch did NOT propagate SQLITE_NOMEM up',
    !threw, threw ? 'unexpectedly threw' : '');

  // Verify all 12 rows landed.
  const allInodes = sql.tables.get('inodes') ?? [];
  const fileInodes = allInodes.filter(r => /^\/nm\/file\d+\.bin$/.test(r.path));
  eq('all 12 inodes present after retry', fileInodes.length, 12);

  const allChunks = sql.tables.get('file_chunks') ?? [];
  const fileChunks = allChunks.filter(r => /^\/nm\/file\d+\.bin$/.test(r.path));
  eq('all 12 chunks present after retry', fileChunks.length, 12);

  // Ring buffer: at least one entry with cause='sqlite_nomem'.
  const failures = getFailures();
  const nomemEntries = failures.filter(f => f.cause === 'sqlite_nomem');
  gte('at least one sqlite_nomem ring entry', nomemEntries.length, 1);
  ok('ring entry has phase string', typeof nomemEntries[0]?.phase === 'string');
  ok('ring entry has at timestamp',
    typeof nomemEntries[0]?.at === 'number' && nomemEntries[0].at > 0);
});

group('writeBatch fail-loud after retry depth exhausted', () => {
  const { ctx, sql } = makeMockCtx();
  const vfs = new SqliteVFS(sql, ctx);
  vfs.mkdir('/nm', { recursive: true });

  // Build payload, inject 999 failures so every retry attempt fails.
  const inodes = [];
  const chunks = [];
  for (let i = 0; i < 8; i++) {
    const path = `/nm/p${i}.bin`;
    inodes.push({
      path, parentPath: '/nm', isDir: false, size: 1,
      mtime: 0, mode: 0o644, chunkCount: 1,
    });
    chunks.push({ path, chunkId: 0, data: new Uint8Array([1]) });
  }
  sql.injectFailures(999, 'SQLITE_NOMEM: out of memory');

  throws('writeBatch eventually throws when retry depth exhausted',
    () => vfs.writeBatch({ inodes, chunks }),
    'SQLITE_NOMEM');
});

summary('w5/functional/sqlite-nomem-retry');
