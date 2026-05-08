// W5 functional: SqliteVFS LRU shrink/restore (Lever 8).
//
// Asserts:
//   1. SqliteVFS exposes shrinkForInstall(targetEntries) — public method.
//   2. SqliteVFS exposes restoreAfterInstall() — public method.
//   3. After shrink(128), getStats().cache.maxEntries === 128.
//   4. After shrink + cache fills above 128, the cache size never exceeds 128.
//   5. Dirty pages evicted by shrink are persisted via deferWrite (data
//      survives the eviction; readFile returns the same bytes).
//   6. restoreAfterInstall() re-raises maxEntries to the constants default (512).
//   7. Refcount: nested acquire/release pairs are idempotent — only the
//      OUTERMOST restore actually restores. (i.e. shrink(); shrink();
//      restore() → still shrunk; restore() → restored)

import { SqliteVFS } from '../../../../src/vfs/sqlite-vfs.ts';
import { LRU_MAX_ENTRIES } from '../../../../src/constants.ts';
import { makeMockCtx } from '../_mock-sql.mjs';
import { ok, eq, gte, lte, group, summary } from '../_tap.mjs';

const { ctx, sql } = makeMockCtx();
const vfs = new SqliteVFS(sql, ctx);

group('shrinkForInstall + restoreAfterInstall surface', () => {
  ok('shrinkForInstall is a function', typeof vfs.shrinkForInstall === 'function');
  ok('restoreAfterInstall is a function', typeof vfs.restoreAfterInstall === 'function');
});

group('default cap reflects LRU_MAX_ENTRIES (back-compat)', () => {
  const s = vfs.getStats();
  eq('cache.maxEntries default', s.cache.maxEntries, LRU_MAX_ENTRIES);
});

group('shrink reduces cap and evicts excess', () => {
  // Fill the cache with 200 distinct chunks first (write 200 small files).
  for (let i = 0; i < 200; i++) {
    vfs.writeFile(`/f${i}.txt`, 'x'.repeat(10));
    // Read it back to ensure the chunk is in cache (writeFile does cacheSet
    // internally for the chunks it produces).
    vfs.readFile(`/f${i}.txt`);
  }
  const before = vfs.getStats();
  gte('cache filled to >=128 entries before shrink', before.cache.entries, 128);

  vfs.shrinkForInstall(128);
  const after = vfs.getStats();
  eq('cache.maxEntries after shrink', after.cache.maxEntries, 128);
  lte('cache.entries after shrink ≤ 128', after.cache.entries, 128);
});

group('data survives eviction by shrink', () => {
  // Pick a file that was likely evicted (the oldest one).
  const data = vfs.readFile('/f0.txt');
  eq('data round-trips through SQL after eviction',
    new TextDecoder().decode(data), 'x'.repeat(10));
});

group('restoreAfterInstall raises cap back to default', () => {
  vfs.restoreAfterInstall();
  const s = vfs.getStats();
  eq('cache.maxEntries restored', s.cache.maxEntries, LRU_MAX_ENTRIES);
});

group('refcount: nested shrink only restores on outermost release', () => {
  vfs.shrinkForInstall(64);
  vfs.shrinkForInstall(64);  // nested
  let s = vfs.getStats();
  eq('cap is the smaller of nested shrinks', s.cache.maxEntries, 64);
  vfs.restoreAfterInstall();   // inner
  s = vfs.getStats();
  ok('still shrunk after inner restore (refcount 1 remaining)',
    s.cache.maxEntries < LRU_MAX_ENTRIES,
    `actual: ${s.cache.maxEntries}`);
  vfs.restoreAfterInstall();   // outer
  s = vfs.getStats();
  eq('restored after outer restore', s.cache.maxEntries, LRU_MAX_ENTRIES);
});

summary('w5/functional/lru-shrink-restore');
