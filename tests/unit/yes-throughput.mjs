#!/usr/bin/env bun
// `yes` writes as GNU yes does: its line repeated into a buffer, written whole,
// not one short line per event-loop turn. The shell's `yes abcdef | head -c
// 300000` took 45 s (one setTimeout(0) per 7-byte line); GNU's takes
// milliseconds.
//
// Two checks. On the command itself: the output is exact (the line, repeated,
// with no partial line inside a write), and the writes needed for N bytes are
// N / buffer, not N / line. Through the shell: the real workspace, for the
// pipeline that measured 45 s, gives bash's bytes and arms about one timer
// per buffer (counted, not timed).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

import yes from '../../packages/core/src/substrate/lifo/commands/io/yes.ts';
import { ISOLATE_NETWORK, NimbusWorkspace, localFacetHost } from '../../packages/core/src/index.ts';

// ── The command: exact output, buffer-sized writes ──────────────────────────
{
  const WANT = 300_000;
  const controller = new AbortController();
  const writes = [];
  let bytes = 0;
  const ctx = {
    args: ['abcdef'], env: {}, cwd: '/home/user', signal: controller.signal,
    stdout: { write: async (s) => { writes.push(s); bytes += s.length; if (bytes >= WANT) controller.abort(); } },
    stderr: { write: async () => {} },
  };
  assert.equal(await yes(ctx), 0);
  const out = writes.join('');
  assert.ok(out.length >= WANT, 'yes wrote until it was stopped');
  assert.ok(/^(abcdef\n)+$/.test(out), 'every byte is the line, repeated');
  for (const w of writes) assert.equal(w.length % 7, 0, 'no write ends mid-line');
  assert.ok(writes.length <= Math.ceil(WANT / 8192) + 1, `${writes.length} writes for ${WANT} bytes: one per buffer, not per line`);
}
// And with no argument, `y`.
{
  const controller = new AbortController();
  const writes = [];
  await yes({
    args: [], env: {}, cwd: '/', signal: controller.signal,
    stdout: { write: async (s) => { writes.push(s); controller.abort(); } },
    stderr: { write: async () => {} },
  });
  assert.ok(/^(y\n)+$/.test(writes[0]));
}

// ── Through the shell, against bash on this host ────────────────────────────
{
  const db = new DatabaseSync(':memory:');
  const sql = { exec: (query, ...bindings) => db.prepare(query).all(...bindings) };
  const transactions = { storage: { transactionSync(cb) { db.exec('BEGIN'); try { const r = cb(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } } };
  const workspace = await NimbusWorkspace.create({ sql, transactions, generation: 1, cwd: '/home/user', facets: localFacetHost(ISOLATE_NETWORK), runtimes: [] });
  const CMD = 'yes abcdef | head -c 300000 | wc -c';
  const bashOut = execFileSync('bash', ['-c', CMD], { encoding: 'utf8' });
  // Counted, not timed: the 45 s was one timer turn per 7-byte line (42,858
  // for this pipeline). Every timer the whole pipeline arms is counted.
  const realSetTimeout = globalThis.setTimeout;
  let timers = 0;
  globalThis.setTimeout = (...args) => { timers++; return realSetTimeout(...args); };
  let r;
  try { r = await workspace.exec(CMD); } finally { globalThis.setTimeout = realSetTimeout; }
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(r.stdout.trim(), bashOut.trim(), 'the same bytes as bash');
  const allowed = 2 * Math.ceil(300_000 / 8192) + 16;
  assert.ok(timers <= allowed, `${CMD}: ${timers} timer turns (allowed ${allowed}: about one per buffer, not per line)`);
  console.log(`yes-throughput: ${CMD} in ${timers} timer turns`);
}
