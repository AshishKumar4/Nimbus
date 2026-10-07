#!/usr/bin/env bun
/**
 * process-fs-journal — a process's write log outlives the process
 * (process-fs-journal.ts, drainProcessFsJournal).
 *
 * Every change is in the journal (the facet's SQLite here: its own harness)
 * when the program is told it succeeded; the session's answer forgets it.
 * A process that dies holding changes leaves them there, and a drain sends
 * them under the numbers they were given: the session's cursor answers what
 * already landed and applies the rest, once. Red before: the log was the
 * client's heap, and a process that died with acknowledged changes unsent
 * lost them (live: 1,384 of 5,000 after an OOM).
 */

import assert from 'node:assert/strict';
import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { SupervisorDeliveries } from '../../packages/core/src/workspace/supervisor-delivery.ts';
import { createSupervisorOpHandler } from '../../packages/core/src/workspace/supervisor-op.ts';
import { drainProcessFsJournal, processFsClient, sqlJournal } from '../../packages/core/src/_shared/process-fs-client.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();
const PID = 61;
const RETRY = { backoffMs: [1, 1, 1], stallMs: 2_000, answerDeadlineMs: 2_000 };

function session() {
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = engine.as(CRED_KERNEL);
  kernel.mkdir('home/user/out', { recursive: true });
  kernel.chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  kernel.chown('home/user/out', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  const files = new ProcessFiles(engine);
  files.bind({ pid: PID, cred: CRED_SESSION_USER });
  const deliveries = new SupervisorDeliveries();
  const op = createSupervisorOpHandler({ vfs: engine, filesystem: files, deliveries });
  const s = {
    kernel,
    fault: null,
    applied: 0,
    port: {
      openWriter: async () => deliveries.openWaveWriter(PID, 60_000),
      writeBatchStream: async (stream, fence) => {
        const deliver = async () => {
          const answer = await op({ op: 'writeBatchStream', args: [], pid: PID, stream, ...(fence ? { waveFence: { ...fence, hostIncarnation: deliveries.incarnation } } : {}) });
          s.applied += answer.committedOps ?? 0;
          return answer;
        };
        return s.fault ? s.fault(deliver) : deliver();
      },
    },
    text: (key) => { try { return dec.decode(kernel.readFile(key)); } catch { return null; } },
  };
  return s;
}

const append = (path, text) => ({ type: 'call', call: { call: 'appendFile', path, mode: 0o644, data: enc.encode(text) } });
const writeFile = (path, text) => ({ type: 'call', call: { call: 'writeFile', path, mode: 0o644, data: enc.encode(text) } });
const facetSql = () => createSqliteVfsTestHarness().sql;

/**
 * The port a process that dies talks through: `live` waves reach the session,
 * and from its death on nothing does (its calls never answer), as nothing of
 * a dead isolate runs.
 */
function mortalPort(s, live = Infinity) {
  let waves = 0;
  const never = new Promise(() => {});
  return {
    openWriter: (first) => (waves >= live ? never : s.port.openWriter(first)),
    writeBatchStream: async (stream, fence) => {
      if (waves++ >= live) return never;
      // The last one lands, and the process dies before it hears so.
      if (waves === live) { await s.port.writeBatchStream(stream, fence); return never; }
      return s.port.writeBatchStream(stream, fence);
    },
  };
}

// ── Logged before it is answered; forgotten once the session answers ──
{
  const s = session();
  const sql = facetSql();
  const journal = sqlJournal(sql);
  const c = processFsClient({ session: s.port, journal, retry: RETRY });
  for (let i = 0; i < 50; i++) c.submit(writeFile(`home/user/out/f${i}`, `${i}`), { acknowledged: true });
  assert.equal(journal.entries().length, 50, 'acknowledged changes were not in the journal when the program was told');
  await c.settle();
  assert.equal(journal.entries().length, 0, 'answered changes stayed in the journal');
  assert.equal(s.text('home/user/out/f49'), '49');
}

// ── Dies before any wave: the drain sends everything, under a fresh writer ──
{
  const s = session();
  const sql = facetSql();
  const c = processFsClient({ session: mortalPort(s, 0), journal: sqlJournal(sql), retry: RETRY });
  // Three files in turn: nothing folds.
  for (let i = 0; i < 300; i++) c.submit(append(`home/user/out/log${i % 3}`, `${i}\n`), { acknowledged: true });
  // The process is gone: its client with it. The facet's SQLite is what is left.
  await new Promise((resolve) => setTimeout(resolve, 10));
  const reopened = sqlJournal(sql);
  assert.equal(reopened.entries().length, 300);
  const drained = await drainProcessFsJournal({ journal: reopened, session: s.port, retry: RETRY });
  assert.equal(drained.landed, 300);
  assert.deepEqual(drained.failures, []);
  for (const k of [0, 1, 2]) {
    const want = Array.from({ length: 100 }, (_, n) => `${n * 3 + k}\n`).join('');
    assert.equal(s.text(`home/user/out/log${k}`), want, `log${k}: an append was lost, doubled or reordered`);
  }
  assert.equal(reopened.entries().length, 0);
}

// ── Dies with a wave landed but its answer lost: the drain lands the rest, once ──
{
  const s = session();
  const sql = facetSql();
  // Its second wave lands, and it dies before it hears so.
  const c = processFsClient({ session: mortalPort(s, 2), journal: sqlJournal(sql), retry: RETRY });
  // Each to its own file: waves of W7's 1,016 names.
  for (let i = 0; i < 2_500; i++) c.submit(append(`home/user/out/a${i}`, `${i}\n`), { acknowledged: true });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const landedBefore = s.applied;
  assert.ok(landedBefore > 0 && landedBefore < 2_500, `${landedBefore} landed before the process died`);
  const drained = await drainProcessFsJournal({ journal: sqlJournal(sql), session: s.port, retry: RETRY });
  for (let i = 0; i < 2_500; i++) assert.equal(s.text(`home/user/out/a${i}`), `${i}\n`, `a${i} after the drain: lost or doubled`);
  assert.ok(drained.landed >= 2_500 - landedBefore);
}

// ── A refusal is the change's answer: reported, and the drain goes on ──
{
  const s = session();
  const sql = facetSql();
  const c = processFsClient({ session: mortalPort(s, 0), journal: sqlJournal(sql), retry: RETRY });
  c.submit(writeFile('home/user/out/ok1', 'a'), { acknowledged: true });
  c.submit(writeFile('home/user/missing/x', 'x'), { acknowledged: true });
  c.submit(writeFile('home/user/out/ok2', 'b'), { acknowledged: true });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const drained = await drainProcessFsJournal({ journal: sqlJournal(sql), session: s.port, retry: RETRY });
  assert.equal(drained.landed, 2);
  assert.equal(drained.failures.length, 1);
  assert.equal(drained.failures[0].errno, 'ENOENT');
  assert.equal(drained.failures[0].path, 'home/user/missing/x');
  assert.equal(s.text('home/user/out/ok2'), 'b');
}

// ── A large file goes in pieces, each journaled; the heap holds a window ──
{
  const s = session();
  const sql = facetSql();
  const gate = Promise.withResolvers();
  s.fault = async (deliver) => { await gate.promise; return deliver(); };
  const journal = sqlJournal(sql);
  const c = processFsClient({ session: s.port, journal, retry: RETRY });
  const big = new Uint8Array(40 * 1024 * 1024).map((_, i) => i % 239);
  c.submit({ type: 'call', call: { call: 'writeFile', path: 'home/user/out/big', mode: 0o644, data: big } }, { acknowledged: true });
  assert.equal(journal.bytes, big.byteLength);
  s.fault = null;
  gate.resolve();
  await c.settle();
  assert.deepEqual(s.kernel.readFile('home/user/out/big'), big);
  assert.equal(journal.bytes, 0);
}

console.log('process-fs-journal: ok');
// The dead processes' clients (their ports never answer) would keep their timers.
process.exit(0);
