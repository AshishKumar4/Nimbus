// W9 functional: ProcessLogStore survives a hibernation cycle.
//
// Hibernation in workerd discards the JS heap and reconstructs the DO
// instance on next dispatch. We simulate that here by:
//   1. Building a ProcessLogStore + PersistAdapter wired to a mock SQL
//   2. Appending chunks + marking exit + calling flush() (alarm path)
//   3. Discarding the in-memory ProcessLogStore (== hibernation)
//   4. Building a FRESH one wired to the SAME mock SQL
//   5. Asserting that tail/all/getExit return identical data after the
//      lazy hydrate
//
// Asserts (the contract the build phase must satisfy):
//   - ProcessLogStore exposes setPersist(adapter) and flush()
//   - After flush + cold reconstruction + first read, chunks are
//     bit-identical to what was appended
//   - Exit row survives identically (code, at, reason)
//   - dropOlderThan also evicts SQL rows for purged pids
//   - Per-pid 64 KB SQL retention cap holds (overshoots prune in flush)
//   - maxPids cap cascades a SQL DELETE for the evicted pid

import { ok, eq, gte, lte, group, summary } from '../_tap.mjs';
import { makeMockCtx } from '../_mock-sql.mjs';

let mod;
try {
  mod = await import('../../../../src/runtime/process-logs.ts');
} catch (e) {
  ok('process-logs module imports', false, e.message);
  summary('w9/functional/hib-persist-roundtrip');
}

const { ProcessLogStore } = mod;

// Build a small adapter that the source side will know how to consume.
// The adapter exposes the surface ProcessLogStore needs:
//   - load(pid): returns { chunks, exit } or null
//   - persistChunks(pid, startSeq, chunks): inserts rows
//   - persistExit(pid, info): upserts exit row
//   - dropPid(pid): removes pid rows from both tables
//   - pruneBeforeSeq(pid, seq): DELETE chunks below seq
function makeAdapter(sql) {
  const ddl = (s) => sql.exec(s);
  ddl(
    'CREATE TABLE IF NOT EXISTS w9_proc_logs (' +
      'pid INTEGER NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL, ' +
      'stream TEXT NOT NULL, data TEXT NOT NULL, binary INTEGER NOT NULL, ' +
      'PRIMARY KEY (pid, seq))',
  );
  ddl(
    'CREATE TABLE IF NOT EXISTS w9_proc_exits (' +
      'pid INTEGER PRIMARY KEY, code INTEGER NOT NULL, at INTEGER NOT NULL, reason TEXT)',
  );

  return {
    load(pid) {
      const chunkRows = [...sql.exec(
        'SELECT pid, seq, ts, stream, data, binary FROM w9_proc_logs WHERE pid = ? ORDER BY seq ASC',
        pid,
      )];
      const exitRows = [...sql.exec(
        'SELECT code, at, reason FROM w9_proc_exits WHERE pid = ?',
        pid,
      )];
      const chunks = chunkRows.map(r => ({
        ts: r.ts,
        stream: r.stream,
        data: r.data,
        binary: !!r.binary,
        seq: r.seq,
      }));
      const exit = exitRows.length > 0
        ? { code: exitRows[0].code, at: exitRows[0].at, reason: exitRows[0].reason ?? undefined }
        : null;
      return { chunks, exit };
    },
    persistChunks(pid, rows) {
      if (rows.length === 0) return;
      // Each row is { seq, chunk: { ts, stream, data, binary? } } per
      // PersistAdapter contract. Insert one at a time — mock supports
      // it; real impl should batch multi-row INSERT.
      for (const r of rows) {
        const c = r.chunk;
        sql.exec(
          'INSERT OR REPLACE INTO w9_proc_logs (pid, seq, ts, stream, data, binary) VALUES (?, ?, ?, ?, ?, ?)',
          pid, r.seq, c.ts, c.stream, c.data, c.binary ? 1 : 0,
        );
      }
    },
    persistExit(pid, info) {
      sql.exec(
        'INSERT OR REPLACE INTO w9_proc_exits (pid, code, at, reason) VALUES (?, ?, ?, ?)',
        pid, info.code, info.at, info.reason ?? null,
      );
    },
    dropPid(pid) {
      sql.exec('DELETE FROM w9_proc_logs WHERE pid = ?', pid);
      sql.exec('DELETE FROM w9_proc_exits WHERE pid = ?', pid);
    },
    pruneBeforeSeq(pid, seq) {
      sql.exec('DELETE FROM w9_proc_logs WHERE pid = ? AND seq < ?', pid, seq);
    },
  };
}

group('public surface', () => {
  const store = new ProcessLogStore();
  ok('setPersist exists', typeof store.setPersist === 'function');
  ok('flush exists', typeof store.flush === 'function');
});

group('append → flush → cold-reconstruct → tail', () => {
  const { sql } = makeMockCtx();
  const adapter = makeAdapter(sql);

  // Phase 1: pre-hibernate
  const s1 = new ProcessLogStore();
  s1.setPersist(adapter);
  s1.append(7, 'stdout', 'hello\n');
  s1.append(7, 'stderr', 'oops\n');
  s1.append(7, 'stdout', 'world\n');
  // Synchronously drive the flush (production has the alarm; tests force it).
  s1.flush();

  eq('SQL rows after flush', sql.countRows('w9_proc_logs'), 3);

  // Phase 2: simulate hibernation — discard s1, build s2 against same SQL
  const s2 = new ProcessLogStore();
  s2.setPersist(adapter);
  // Post-W9 contract: has(pid) MUST return true if SQL has rows for the
  // pid, even before any explicit read — this is the whole hibernation-
  // survival point. Pre-W9, has() was Map.has() only and would return
  // false here.
  ok('s2 fresh: has(7) returns true (hydrate from SQL)', s2.has(7));
  const all = s2.all(7);
  eq('chunks recovered after cold-reconstruct', all.length, 3);
  eq('chunk 0 stream', all[0].stream, 'stdout');
  eq('chunk 0 data', all[0].data, 'hello\n');
  eq('chunk 1 stream', all[1].stream, 'stderr');
  eq('chunk 1 data', all[1].data, 'oops\n');
  eq('chunk 2 data', all[2].data, 'world\n');
});

group('exit info survives', () => {
  const { sql } = makeMockCtx();
  const adapter = makeAdapter(sql);

  const s1 = new ProcessLogStore();
  s1.setPersist(adapter);
  s1.append(11, 'stderr', 'boom\n');
  s1.markExit(11, 137, 'oom');
  s1.flush();

  const s2 = new ProcessLogStore();
  s2.setPersist(adapter);
  const exit = s2.getExit(11);
  ok('exit recovered', exit !== null);
  eq('exit code', exit?.code, 137);
  eq('exit reason', exit?.reason, 'oom');
});

group('append after hydrate continues seq monotonically', () => {
  const { sql } = makeMockCtx();
  const adapter = makeAdapter(sql);

  const s1 = new ProcessLogStore();
  s1.setPersist(adapter);
  s1.append(20, 'stdout', 'A\n');
  s1.append(20, 'stdout', 'B\n');
  s1.flush();

  const s2 = new ProcessLogStore();
  s2.setPersist(adapter);
  // Force hydrate first via has check / tail
  s2.tail(20);
  s2.append(20, 'stdout', 'C\n');
  s2.flush();

  const allRows = sql.rowsFor('w9_proc_logs', 20);
  eq('total rows after second append + flush', allRows.length, 3);
  // Datas must be A, B, C in seq order — no overwrite of earlier rows
  const sorted = allRows.slice().sort((a, b) => a.seq - b.seq);
  eq('row 0 data', sorted[0].data, 'A\n');
  eq('row 1 data', sorted[1].data, 'B\n');
  eq('row 2 data', sorted[2].data, 'C\n');
});

group('dropOlderThan evicts SQL rows', async () => {
  const { sql } = makeMockCtx();
  const adapter = makeAdapter(sql);

  const s = new ProcessLogStore({ retainAfterExitMs: 10 });
  s.setPersist(adapter);
  s.append(99, 'stdout', 'x\n');
  s.markExit(99, 0);
  s.flush();
  gte('rows present', sql.countRows('w9_proc_logs'), 1);
});

// async block — group() is sync; await sleep needs an async IIFE.
console.log('# dropOlderThan evicts SQL rows (after retainAfterExitMs)');
{
  const { sql } = makeMockCtx();
  const adapter = makeAdapter(sql);

  const s = new ProcessLogStore({ retainAfterExitMs: 5 });
  s.setPersist(adapter);
  s.append(99, 'stdout', 'x\n');
  s.markExit(99, 0);
  s.flush();
  gte('rows present', sql.countRows('w9_proc_logs'), 1);

  // Sleep past the retention window so cutoff > exit.at.
  await new Promise((r) => setTimeout(r, 10));
  const dropped = s.dropOlderThan();
  s.flush(); // flush queued dropPid calls
  eq('one pid dropped', dropped, 1);
  eq('w9_proc_logs cleaned', sql.countRows('w9_proc_logs'), 0);
  eq('w9_proc_exits cleaned', sql.countRows('w9_proc_exits'), 0);
}

group('per-pid byte cap is honoured in SQL after flush', () => {
  const { sql } = makeMockCtx();
  const adapter = makeAdapter(sql);

  const s = new ProcessLogStore({ perPidBytes: 128, maxChunkBytes: 32 });
  s.setPersist(adapter);
  // Write 256 bytes (8 chunks of 32 bytes each) — half should evict
  for (let i = 0; i < 8; i++) {
    s.append(33, 'stdout', 'A'.repeat(32));
  }
  s.flush();

  // SQL retention is bounded by perPidBytes (per plan §3.1, with some
  // overshoot tolerance). Assert that we do NOT keep all 256 bytes.
  const rows = sql.rowsFor('w9_proc_logs', 33);
  const totalBytes = rows.reduce((acc, r) => acc + r.data.length, 0);
  lte('SQL bytes <= 1.5x perPidBytes', totalBytes, 192);
});

group('maxPids cap cascades a SQL DELETE', () => {
  const { sql } = makeMockCtx();
  const adapter = makeAdapter(sql);

  const s = new ProcessLogStore({ maxPids: 3 });
  s.setPersist(adapter);

  // Insert 4 pids, each exited (so eviction picks them).
  for (let pid = 100; pid < 104; pid++) {
    s.append(pid, 'stdout', `pid ${pid}\n`);
    s.markExit(pid, 0);
  }
  s.flush();

  // The first-inserted pid should have been evicted to make room for pid 103.
  // Eviction policy: tier-1 oldest exited+no-subscribers.
  const distinctPids = new Set(
    sql.rowsFor('w9_proc_logs').map(r => r.pid),
  );
  eq('exactly 3 pids in SQL', distinctPids.size, 3);
  ok('pid 100 evicted from SQL', !distinctPids.has(100));
});

summary('w9/functional/hib-persist-roundtrip');
