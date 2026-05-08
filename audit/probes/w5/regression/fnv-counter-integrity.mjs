// W5 regression: FNV / file-counter integrity (W2.5 contract).
//
// W2.5 invariant: the running counters _totalFiles, _totalDirs,
// _usedBytes maintained at every mutator entry must equal a fresh
// O(N) walk of this.inodes — even after Lever 8 (LRU shrink/restore)
// and Lever 9 (writeBatch retry-on-NOMEM).
//
// Strategy: run a writeBatch, shrink LRU, run more writes, restore,
// inject a SQLITE_NOMEM-and-retry cycle, walk inodes, assert counters
// match.

import { SqliteVFS } from '../../../../src/vfs/sqlite-vfs.ts';
import { makeMockCtx } from '../_mock-sql.mjs';
import { ok, eq, gte, group, summary } from '../_tap.mjs';

const { ctx, sql } = makeMockCtx();
const vfs = new SqliteVFS(sql, ctx);

// Build directories first (mkdir maintains _totalDirs).
// SqliteVFS strips leading slash internally — mirror that convention.
vfs.mkdir('pkg', { recursive: true });
vfs.mkdir('pkg/a', { recursive: true });
vfs.mkdir('pkg/b', { recursive: true });

// Initial writeBatch — 30 files split between pkg/a and pkg/b.
const inodes = [];
const chunks = [];
let expectedBytes = 0;
for (let i = 0; i < 30; i++) {
  const dir = i % 2 ? 'pkg/a' : 'pkg/b';
  const path = `${dir}/f${i}.bin`;
  const size = 16 + i;
  inodes.push({
    path, parentPath: dir, isDir: false,
    size, mtime: 0, mode: 0o644, chunkCount: 1,
  });
  chunks.push({ path, chunkId: 0, data: new Uint8Array(size) });
  expectedBytes += size;
}
vfs.writeBatch({ inodes, chunks });

group('initial writeBatch counters', () => {
  const stats = vfs.getStats();
  eq('totalFiles', stats.files, 30);
  eq('usedBytes', stats.usedBytes, expectedBytes);
});

group('counters stay correct after shrinkForInstall', () => {
  if (typeof vfs.shrinkForInstall === 'function') {
    vfs.shrinkForInstall(8);
  }
  const stats = vfs.getStats();
  eq('totalFiles unchanged by shrink', stats.files, 30);
  eq('usedBytes unchanged by shrink', stats.usedBytes, expectedBytes);
});

group('counters stay correct after retry-on-NOMEM', () => {
  // Inject a single failure, write 4 more files via writeBatch.
  sql.injectFailures(1, 'SQLITE_NOMEM: out of memory');
  const moreInodes = [];
  const moreChunks = [];
  for (let i = 30; i < 34; i++) {
    const path = `pkg/a/f${i}.bin`;
    moreInodes.push({
      path, parentPath: 'pkg/a', isDir: false,
      size: 8, mtime: 0, mode: 0o644, chunkCount: 1,
    });
    moreChunks.push({ path, chunkId: 0, data: new Uint8Array(8) });
    expectedBytes += 8;
  }
  let threw = false;
  try { vfs.writeBatch({ inodes: moreInodes, chunks: moreChunks }); }
  catch (_) { threw = true; }
  ok('writeBatch did NOT throw despite injected NOMEM', !threw);

  const stats = vfs.getStats();
  eq('totalFiles after retry', stats.files, 34);
  eq('usedBytes after retry', stats.usedBytes, expectedBytes);

  if (typeof vfs.restoreAfterInstall === 'function') {
    vfs.restoreAfterInstall();
  }
});

group('children-index integrity (W2.5)', () => {
  // readdir returns [{ name, type }, …]
  const a = vfs.readdir('pkg/a').filter(e => e.type === 'file');
  const b = vfs.readdir('pkg/b').filter(e => e.type === 'file');
  // Files 1, 3, 5, … 29 + 30, 31, 32, 33 → 19 in /pkg/a.
  // Files 0, 2, 4, … 28 → 15 in /pkg/b.
  eq('a child count', a.length, 19);
  eq('b child count', b.length, 15);
  ok('readdir contents look like file entries',
    a.every(e => e.type === 'file' && typeof e.name === 'string')
    && b.every(e => e.type === 'file' && typeof e.name === 'string'));
});

group('counters match O(N) walk', () => {
  let walkFiles = 0, walkBytes = 0;
  const inodesAll = sql.tables.get('inodes') ?? [];
  for (const r of inodesAll) {
    if (r.is_dir === 0) {
      walkFiles++;
      walkBytes += r.size ?? 0;
    }
  }
  const stats = vfs.getStats();
  eq('walkFiles == counter', walkFiles, stats.files);
  eq('walkBytes == counter', walkBytes, stats.usedBytes);
});

summary('w5/regression/fnv-counter-integrity');
