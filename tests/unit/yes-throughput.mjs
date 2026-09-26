#!/usr/bin/env bun
// `yes` writes as GNU yes does: its line repeated into a buffer, written whole,
// not one short line per event-loop turn. The shell's `yes abcdef | head -c
// 300000` took 45 s (one setTimeout(0) per 7-byte line); GNU's takes
// milliseconds.
//
// Two checks. On the command itself: the output is exact (the line, repeated,
// with no partial line inside a write), and the writes needed for N bytes are
// N / buffer, not N / line. Through the shell: the real workspace, within 10x
// of bash on this host (with a floor for process start-up), for the pipeline
// that measured 45 s.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

import yes from '../../packages/core/src/substrate/lifo/commands/io/yes.ts';
import { NimbusWorkspace, localFacetHost } from '../../packages/core/src/index.ts';

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
  assert.ok(writes.length <= Math.ceil(WANT / 8192) + 1, `${writes.length} writes for ${WANT} bytes: one per line, not per buffer`);
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
  const workspace = await NimbusWorkspace.create({ sql, transactions, generation: 1, cwd: '/home/user', facets: localFacetHost(), runtimes: [] });
  const CMD = 'yes abcdef | head -c 300000 | wc -c';
  const t0 = performance.now();
  const bashOut = execFileSync('bash', ['-c', CMD], { encoding: 'utf8' });
  const bashMs = performance.now() - t0;
  const t1 = performance.now();
  const r = await workspace.exec(CMD);
  const shellMs = performance.now() - t1;
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(r.stdout.trim(), bashOut.trim(), 'the same bytes as bash');
  const allowed = Math.max(10 * bashMs, 500);
  assert.ok(shellMs <= allowed, `${CMD}: ${shellMs.toFixed(0)} ms in the shell, bash ${bashMs.toFixed(0)} ms (allowed ${allowed.toFixed(0)} ms)`);
  console.log(`yes-throughput: ${CMD} in ${shellMs.toFixed(0)} ms (bash ${bashMs.toFixed(0)} ms)`);
}
