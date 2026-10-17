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
import { createSupervisorOpHandler, journalDrainSession } from '../../packages/core/src/workspace/supervisor-op.ts';
import { drainProcessFsJournal, journalSource, memoryJournal, processFsClient, sqlJournal } from '../../packages/core/src/_shared/process-fs-client.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { sqlJournal as mainJournal } from './fixtures/process-fs-journal-main.ts';

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
    engine,
    files,
    op,
    harness,
    sql: harness.sql,
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

// A native invocation quota ends transport, not the durable process log.
{
  const s = session();
  const sql = facetSql();
  const journal = sqlJournal(sql);
  s.fault = () => { throw new Error('Too many subrequests by single Worker invocation'); };
  const c = processFsClient({ session: s.port, journal, retry: RETRY });
  for (let i = 0; i < 10000; i++) c.submit(writeFile(`home/user/out/quota${i}`, `${i}\n`), { acknowledged: true });
  assert.equal(journal.entries().length, 10000, 'every returned synchronous write was durable before transport ran');
  await assert.rejects(c.settle(), /Too many subrequests/);
  await assert.rejects(async () => { await c.rawSocket(); }, /Too many subrequests/, 'a failed invocation cannot bypass the filesystem gate to open a new transport');
  const reopened = sqlJournal(sql);
  assert.equal(reopened.entries().length, 10000, 'quota exhaustion must leave acknowledged writes for a fresh-invocation drain');
  s.fault = null;
  const drained = await drainProcessFsJournal({ journal: journalSource(reopened), session: s.port, retry: RETRY });
  assert.deepEqual(drained.failures, []);
  for (let i = 0; i < 10000; i++) assert.equal(s.text(`home/user/out/quota${i}`), `${i}\n`);
  assert.equal(reopened.entries().length, 0);
}

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
  const drained = await drainProcessFsJournal({ journal: journalSource(reopened), session: s.port, retry: RETRY });
  assert.equal(drained.landed, 300);
  assert.deepEqual(drained.failures, []);
  for (const k of [0, 1, 2]) {
    const want = Array.from({ length: 100 }, (_, n) => `${n * 3 + k}\n`).join('');
    assert.equal(s.text(`home/user/out/log${k}`), want, `log${k}: an append was lost, doubled or reordered`);
  }
  assert.equal(reopened.entries().length, 0);
}

// ── Rollback to main still drains the complete unsent folded row ──
{
  const s = session();
  const sql = facetSql();
  const journal = sqlJournal(sql);
  const c = processFsClient({ session: mortalPort(s, 0), journal, retry: RETRY });
  const want = Uint8Array.from({ length: 20_000 }, (_, i) => (i * 29 + Math.floor(i / 10)) % 256);
  c.submit(writeFile('home/user/out/rollback', ''), { acknowledged: true });
  for (let at = 0; at < want.byteLength; at += 10) c.submit({ type: 'call', call: { call: 'appendFile', path: 'home/user/out/rollback', mode: 0o644, data: want.subarray(at, at + 10) } }, { acknowledged: true });
  c.seal();
  assert.equal(c.stats().folded, want.byteLength / 10);
  assert.equal([...sql.exec('SELECT COUNT(*) AS n FROM nimbus_fs_journal_parts')][0].n, 0, 'the stage-one writer emitted parts');
  const old = mainJournal(sql);
  assert.deepEqual(old.entries()[0].op.call.data, want, 'main recovered only a prefix of the folded row');
  const drained = await drainProcessFsJournal({ journal: journalSource(old), session: s.port, retry: RETRY });
  assert.deepEqual(drained.failures, []);
  assert.deepEqual(s.kernel.readFile('home/user/out/rollback'), want);
  assert.deepEqual(old.entries(), []);
}

// ── The stage-one reader drains the parts a later writer will leave ──
{
  const s = session();
  const sql = facetSql();
  const writer = sqlJournal(sql);
  const path = 'home/user/out/future-parts';
  const want = Uint8Array.from({ length: 20_000 }, (_, i) => (i * 31 + Math.floor(i / 10)) % 256);
  const jid = writer.append({ type: 'call', call: { call: 'writeFile', path, mode: 0o600, data: want.subarray(0, 10) } });
  for (let at = 10; at < want.byteLength; at += 10) sql.exec('INSERT INTO nimbus_fs_journal_parts (jid, data) VALUES (?, ?)', jid, want.subarray(at, at + 10));
  const reopened = sqlJournal(sql);
  assert.equal(reopened.bytes, want.byteLength);
  assert.deepEqual(reopened.read(jid).call.data, want);
  assert.deepEqual(reopened.readAfter(0, 1)[0].op.call.data, want);
  const drained = await drainProcessFsJournal({ journal: journalSource(reopened), session: s.port, retry: RETRY });
  assert.deepEqual(drained.failures, []);
  assert.deepEqual(s.kernel.readFile(path), want);
  assert.equal(s.kernel.stat(path).mode & 0o777, 0o600);
  assert.equal([...sql.exec('SELECT COUNT(*) AS n FROM nimbus_fs_journal_parts')][0].n, 0, 'acknowledgement left future parts behind');
  assert.equal(sqlJournal(sql).bytes, 0);
}

// ── A full replacement atomically discards future-writer parts ──
{
  const sql = facetSql();
  const writer = sqlJournal(sql);
  const jid = writer.append(writeFile('home/user/out/replaced-parts', 'old'));
  sql.exec('INSERT INTO nimbus_fs_journal_parts (jid, data) VALUES (?, ?)', jid, enc.encode('-parts'));
  const reopened = sqlJournal(sql);
  assert.equal(dec.decode(reopened.read(jid).call.data), 'old-parts');
  reopened.replace(jid, writeFile('home/user/out/replaced-parts', 'whole'));
  assert.equal(dec.decode(reopened.read(jid).call.data), 'whole');
  assert.equal(dec.decode(mainJournal(sql).read(jid).call.data), 'whole');
  assert.equal(sqlJournal(sql).bytes, 5);
}

// ── A folded tail survives a restart, including a rewrite of appended bytes ──
{
  const s = session();
  const sql = facetSql();
  const journal = sqlJournal(sql);
  const c = processFsClient({ session: mortalPort(s, 0), journal, retry: RETRY });
  const count = 20_000;
  const want = Uint8Array.from({ length: count * 10 }, (_, i) => (i * 19 + Math.floor(i / 10)) % 256);
  c.submit(writeFile('home/user/out/folded', ''), { acknowledged: true });
  for (let i = 0; i < count; i++) c.submit({ type: 'call', call: { call: 'appendFile', path: 'home/user/out/folded', mode: 0o644, data: want.subarray(i * 10, i * 10 + 10) } }, { acknowledged: true });
  for (let i = 0; i < 500; i++) c.submit(append('home/user/out/replaced', 'discarded'), { acknowledged: true });
  c.submit(writeFile('home/user/out/replaced', 'kept'), { acknowledged: true });
  for (let i = 0; i < 500; i++) c.submit(append('home/user/out/replaced', `${i},`), { acknowledged: true });
  const replaced = 'kept' + Array.from({ length: 500 }, (_, i) => `${i},`).join('');
  c.seal();
  // Only the facet's SQL survives; no buffer from the client participates.
  const reopened = sqlJournal(sql);
  assert.equal(reopened.bytes, want.byteLength + enc.encode(replaced).byteLength);
  assert.equal(reopened.entries().length, 2, 'the folded tail changed its place in the journal');
  assert.deepEqual(reopened.read(reopened.entries()[0].jid).call.data, want);
  const first = reopened.readAfter(0, want.byteLength);
  assert.equal(first.length, 1, 'the read bound omitted appended bytes');
  assert.deepEqual(first[0].op.call.data, want);
  assert.equal(dec.decode(reopened.readAfter(first[0].jid, 1)[0].op.call.data), replaced, 'a rewrite replayed its discarded pieces');
  const drained = await drainProcessFsJournal({ journal: journalSource(reopened), session: s.port, retry: RETRY });
  assert.deepEqual(drained.failures, []);
  assert.equal(drained.landed, 2);
  assert.deepEqual(s.kernel.readFile('home/user/out/folded'), want, 'the restarted drain lost or reordered folded bytes');
  assert.equal(s.text('home/user/out/replaced'), replaced);
  const empty = sqlJournal(sql);
  assert.equal(empty.bytes, 0, 'answered pieces stayed in the durable log');
  const next = empty.append(writeFile('home/user/out/new', 'new'));
  assert.equal(dec.decode(empty.read(next).call.data), 'new', 'an old piece was attached to a new entry');
}

// ── A failed fold leaves the accepted prefix intact, in memory and after restart ──
{
  const s = session();
  const harness = createSqliteVfsTestHarness();
  const journal = sqlJournal(harness.sql);
  const c = processFsClient({ session: s.port, journal, retry: RETRY });
  c.submit(writeFile('home/user/out/fault', 'first'), { acknowledged: true });
  c.submit(append('home/user/out/fault', '-second'), { acknowledged: true });
  harness.failOnStatement(1, new Error('append refused'));
  assert.throws(() => c.submit(append('home/user/out/fault', '-lost'), { acknowledged: true }), /append refused/);
  assert.equal(journal.bytes, enc.encode('first-second').byteLength);
  assert.equal(dec.decode(sqlJournal(harness.sql).entries()[0].op.call.data), 'first-second');
  harness.failOnStatement(2, new Error('replacement refused'));
  assert.throws(() => c.submit(writeFile('home/user/out/fault', 'lost'), { acknowledged: true }), /replacement refused/);
  assert.equal(journal.bytes, enc.encode('first-second').byteLength);
  assert.equal(dec.decode(sqlJournal(harness.sql).entries()[0].op.call.data), 'first-second');
  c.submit(append('home/user/out/fault', '-third'), { acknowledged: true });
  await c.settle();
  assert.equal(s.text('home/user/out/fault'), 'first-second-third', 'a failed fold changed the queued bytes');
  assert.equal(sqlJournal(harness.sql).bytes, 0);
}

// ── Reusing an older journal op must not overwrite a newer prefix sharing its buffer ──
{
  const s = session();
  const journal = memoryJournal();
  const c = processFsClient({ session: s.port, journal, retry: RETRY });
  const path = 'home/user/out/shared';
  const prefix = 'a'.repeat(10) + 'b'.repeat(10) + 'c'.repeat(10);
  c.submit(writeFile(path, 'a'.repeat(10)), { acknowledged: true });
  c.submit(append(path, 'b'.repeat(10)), { acknowledged: true });
  c.submit(append(path, 'c'.repeat(10)), { acknowledged: true });
  const remembered = journal.entries()[0].op;
  c.submit(append(path, 'd'.repeat(5)), { acknowledged: true });
  c.submit({ type: 'call', call: { call: 'copyFile', from: path, path: 'home/user/out/snapshot' } }, { acknowledged: true });
  c.submit(remembered, { acknowledged: true });
  c.submit(append(path, 'e'.repeat(5)), { acknowledged: true });
  await c.settle();
  assert.equal(s.text('home/user/out/snapshot'), prefix + 'd'.repeat(5));
  assert.equal(s.text(path), prefix + 'e'.repeat(5));
}

// ── An input view overlapping the tail's spare bytes is logged before that view changes ──
{
  const s = session();
  const sql = facetSql();
  const inner = sqlJournal(sql);
  let latest;
  const journal = new Proxy(inner, { get(target, key) {
    if (key === 'replace') return (jid, op, ...rest) => { latest = op; return target.replace(jid, op, ...rest); };
    return Reflect.get(target, key);
  } });
  const c = processFsClient({ session: s.port, journal, retry: RETRY });
  const path = 'home/user/out/overlap';
  c.submit(writeFile(path, 'a'.repeat(10)), { acknowledged: true });
  c.submit(append(path, 'b'.repeat(10)), { acknowledged: true });
  c.submit(append(path, 'c'.repeat(10)), { acknowledged: true });
  const data = latest.call.data;
  const end = data.byteOffset + data.byteLength;
  const spare = data.buffer.byteLength - end;
  const prefix = spare > 1 ? Math.min(5, spare - 1) : 5;
  const suffix = spare > 1 ? Math.min(prefix, spare - prefix) : 0;
  const fill = new Uint8Array(data.buffer, end, Math.min(10, spare));
  fill.set(enc.encode('0123456789').subarray(0, fill.byteLength));
  const piece = new Uint8Array(data.buffer, end - prefix, prefix + suffix);
  const want = new Uint8Array(data.byteLength + piece.byteLength);
  want.set(data);
  want.set(piece, data.byteLength);
  c.submit({ type: 'call', call: { call: 'appendFile', path, mode: 0o644, data: piece } }, { acknowledged: true });
  c.seal();
  const reopened = sqlJournal(sql);
  assert.deepEqual(reopened.entries()[0].op.call.data, want, 'the durable delta came from the input after an overlapping copy changed it');
  const drained = await drainProcessFsJournal({ journal: journalSource(reopened), session: s.port, retry: RETRY });
  assert.deepEqual(drained.failures, []);
  assert.deepEqual(s.kernel.readFile(path), want);
}

// ── A new entry refused by the journal does not disturb its preceding folded tail ──
{
  const s = session();
  const harness = createSqliteVfsTestHarness();
  const c = processFsClient({ session: s.port, journal: sqlJournal(harness.sql), retry: RETRY });
  c.submit(writeFile('home/user/out/prefix', 'a'), { acknowledged: true });
  c.submit(append('home/user/out/prefix', '-b'), { acknowledged: true });
  harness.failOnStatement(1, new Error('new entry refused'));
  const refused = c.submit(writeFile('home/user/out/refused', 'lost'), { acknowledged: true });
  c.submit(append('home/user/out/prefix', '-c'), { acknowledged: true });
  await assert.rejects(refused, /new entry refused/);
  await c.settle();
  assert.equal(s.text('home/user/out/prefix'), 'a-b-c');
  assert.equal(s.text('home/user/out/refused'), null);
  assert.equal(c.stats().folded, 2);
}

// ── Plain entries need only their row; the pieces cache follows writes and reopening ──
{
  const harness = createSqliteVfsTestHarness();
  const journal = sqlJournal(harness.sql);
  const a = journal.append(writeFile('home/user/out/a', 'a'));
  const b = journal.append(writeFile('home/user/out/b', 'b'));
  const oneQuery = (read) => {
    const before = harness.statementCount;
    const answer = read();
    assert.equal(harness.statementCount - before, 1, 'an entry without pieces queried the pieces table');
    return answer;
  };
  assert.equal(dec.decode(oneQuery(() => journal.read(a)).call.data), 'a');
  assert.equal(oneQuery(() => journal.entries()).length, 2);
  assert.equal(oneQuery(() => journal.readAfter(0, 1)).length, 1);
  harness.failOnStatement(1, new Error('first piece refused'));
  assert.throws(() => journal.replace(a, writeFile('home/user/out/a', 'a+'), enc.encode('+')), /first piece refused/);
  assert.equal(dec.decode(oneQuery(() => journal.read(a)).call.data), 'a');
  journal.replace(a, writeFile('home/user/out/a', 'a+'), enc.encode('+'));
  assert.equal(dec.decode(journal.read(a).call.data), 'a+');
  journal.replace(a, writeFile('home/user/out/a', 'new'));
  assert.equal(dec.decode(oneQuery(() => journal.read(a)).call.data), 'new');
  harness.sql.exec('INSERT INTO nimbus_fs_journal_parts (jid, data) VALUES (?, ?)', b, enc.encode('+'));
  const reopened = sqlJournal(harness.sql);
  assert.equal(dec.decode(reopened.read(b).call.data), 'b+');
  assert.equal(dec.decode(oneQuery(() => reopened.read(a)).call.data), 'new');
  reopened.dropThrough(a);
  assert.equal(dec.decode(reopened.read(b).call.data), 'b+', 'dropping a prefix cleared a later entry\'s pieces');
  const c = reopened.append(writeFile('home/user/out/c', 'c'));
  assert.equal(dec.decode(oneQuery(() => reopened.read(c)).call.data), 'c');
  reopened.replace(c, writeFile('home/user/out/c', 'c+'), enc.encode('+'));
  reopened.dropThrough(b);
  assert.equal(dec.decode(reopened.read(c).call.data), 'c+');
  reopened.dropThrough(c);
  assert.equal(reopened.bytes, 0);
  assert.deepEqual(oneQuery(() => reopened.entries()), []);
}

// ── Journals written before data pieces existed still recover ──
{
  const s = session();
  const sql = facetSql();
  sql.exec('CREATE TABLE nimbus_fs_journal (jid INTEGER PRIMARY KEY, op TEXT NOT NULL, data BLOB)');
  sql.exec('CREATE TABLE nimbus_fs_numbering (jid INTEGER PRIMARY KEY, writer TEXT, seq INTEGER NOT NULL)');
  sql.exec('INSERT INTO nimbus_fs_journal (jid, op, data) VALUES (?, ?, ?)', 7, JSON.stringify({ type: 'call', call: { call: 'writeFile', path: 'home/user/out/legacy', mode: 0o644 } }), enc.encode('before'));
  const journal = sqlJournal(sql);
  assert.equal(journal.bytes, 6);
  const drained = await drainProcessFsJournal({ journal: journalSource(journal), session: s.port, retry: RETRY });
  assert.deepEqual(drained.failures, []);
  assert.equal(s.text('home/user/out/legacy'), 'before');
  assert.equal(sqlJournal(sql).bytes, 0);
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
  const drained = await drainProcessFsJournal({ journal: journalSource(sqlJournal(sql)), session: s.port, retry: RETRY });
  for (let i = 0; i < 2_500; i++) assert.equal(s.text(`home/user/out/a${i}`), `${i}\n`, `a${i} after the drain: lost or doubled`);
  assert.ok(drained.landed >= 2_500 - landedBefore);
}

// ── Dies while what it answered in a subtree it held lingers (unsent,
//    LINGER_MS): the journal holds it as it holds any logged change, and the
//    session's drain lands it ──
{
  const s = session();
  const sql = facetSql();
  const never = new Promise(() => {});
  let dead = false;
  const port = {
    ...s.port,
    writeBatchStream: (stream, fence, owner) => (dead ? never : s.port.writeBatchStream(stream, fence, owner)),
    grants: {
      acquire: (path, delegate) => s.op({ op: 'fsAcquireExclusiveMutation', args: [path, { delegate }], pid: PID }),
      release: (owner) => s.op({ op: 'fsReleaseExclusiveMutation', args: [owner], pid: PID }),
      awaitRecall: () => never,
      recalled: async () => {},
    },
  };
  const c = processFsClient({ session: port, journal: sqlJournal(sql), retry: RETRY, grantAfter: 1, grantIdleMs: 60_000, lingerMs: 60_000 });
  c.holder('home/user/out/x');
  let grant;
  for (let i = 0; i < 400 && (grant = c.holder('home/user/out/x')) === undefined; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.notEqual(grant, undefined, 'the subtree was not taken');
  const applied = s.applied;
  // A node process's own write (it numbers nothing from the grant) and a mode decided there.
  c.submit({ type: 'call', call: { call: 'writeFile', path: 'home/user/out/lingered', mode: 0o644, data: enc.encode('lingered') } }, { acknowledged: true });
  c.submit({ type: 'setattr', path: 'home/user/out/lingered', attrs: { mode: 0o600 } }, { decided: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(s.applied, applied, 'what lingers was sent');
  // The process dies with them lingering: the session lets go of what it held, and drains its journal.
  dead = true;
  await s.files.releaseProcess(PID);
  const reopened = sqlJournal(sql);
  assert.equal(reopened.entries().length, 2, 'what lingered was not in the journal');
  const lease = s.files.openHost(CRED_SESSION_USER);
  const drained = await drainProcessFsJournal({ journal: journalSource(reopened), session: journalDrainSession(lease.fs, PID), retry: RETRY });
  await lease.dispose();
  assert.deepEqual(drained.failures, []);
  assert.equal(drained.landed, 2);
  assert.equal(s.text('home/user/out/lingered'), 'lingered');
  assert.equal(s.kernel.stat('home/user/out/lingered').mode & 0o777, 0o600);
}

// ── Drained in the session itself (the manager's drain), long after it died ──
// Its landed wave is answered from the cursor its own fenced waves moved
// (`${pid}:${writer}`), however long the drain comes after: the cursor lives
// until the drain forgets it, not for an epoch's TTL. Red before: the drain
// numbered under another key, or the cursor had expired, and the landed
// appends were applied twice.
{
  const s = session();
  const sql = facetSql();
  const c = processFsClient({ session: mortalPort(s, 2), journal: sqlJournal(sql), retry: RETRY });
  for (let i = 0; i < 2_500; i++) c.submit(append(`home/user/out/b${i % 1_200}`, `${i}\n`), { acknowledged: true });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(s.applied > 0 && s.applied < 2_500, `${s.applied} landed before the process died`);
  // A day on, another writer's wave opens its own sequence.
  const realNow = Date.now;
  Date.now = () => realNow() + 24 * 3_600_000;
  try {
    const other = processFsClient({ session: s.port, retry: RETRY });
    other.submit(writeFile('home/user/out/other', 'x'), { acknowledged: true });
    await other.settle();
    const lease = s.files.openHost(CRED_SESSION_USER);
    const drained = await drainProcessFsJournal({ journal: journalSource(sqlJournal(sql)), session: journalDrainSession(lease.fs, PID), retry: RETRY });
    await lease.dispose();
    assert.deepEqual(drained.failures, []);
  } finally {
    Date.now = realNow;
  }
  for (let k = 0; k < 1_200; k++) {
    const want = [k, k + 1_200, k + 2_400].filter((i) => i < 2_500).map((i) => `${i}\n`).join('');
    assert.equal(s.text(`home/user/out/b${k}`), want, `b${k} after the drain: an append was lost or doubled`);
  }
  const cursors = (pid) => [...s.sql.exec("SELECT writer FROM vfs_wave_cursors WHERE writer >= ? AND writer < ?", `${pid}:`, `${pid};`)].length;
  assert.ok(cursors(PID) > 0);
  s.engine.forgetSequences(PID + 550);
  assert.ok(cursors(PID) > 0, "another pid's forget took this one's cursors");
  s.engine.forgetSequences(PID);
  assert.equal(cursors(PID), 0, 'its cursors outlived its drain');
}

// ── Review D (41b-1): a description's write logged after its open was answered lands in the drain ──
// Its open was answered and forgotten from the log; the write after it was
// logged and never sent. The drain (in the session, under a fresh scope,
// and after a restart of the session) writes it through the description
// the session kept: its file, with the access its open decided, whatever
// was renamed or chmodded since. Red before: the description lived only in
// the process's scope, the drain's had none (EBADF), and the write was
// reported refused and dropped.
for (const restarted of [false, true]) {
  const s = session();
  s.kernel.writeFile('home/user/out/d.txt', enc.encode('old!'));
  s.kernel.chown('home/user/out/d.txt', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  const sql = facetSql();
  let dead = false;
  const never = new Promise(() => {});
  const port = {
    openWriter: (first) => (dead ? never : s.port.openWriter(first)),
    writeBatchStream: (stream, fence) => (dead ? never : s.port.writeBatchStream(stream, fence)),
  };
  const c = processFsClient({ session: port, journal: sqlJournal(sql), retry: RETRY });
  await c.submit({ type: 'call', call: { call: 'open', path: 'home/user/out/d.txt', mode: 0o644, access: 'write', description: 'w1' } }, { acknowledged: true });
  assert.equal(sqlJournal(sql).entries().length, 0, 'the answered open stayed in the log');
  dead = true;
  c.submit({ type: 'call', call: { call: 'write', path: 'home/user/out/d.txt', description: 'w1', offset: 0, data: enc.encode('new!') } }, { acknowledged: true });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sqlJournal(sql).entries().length, 1);
  // Since its open: renamed, and its mode no longer lets the process write.
  s.kernel.rename('home/user/out/d.txt', 'home/user/out/moved.txt');
  s.kernel.chmod('home/user/out/moved.txt', 0o444);
  let files = s.files;
  let engine = s.engine;
  if (restarted) {
    engine = new SqliteVFS(s.sql, s.harness.ctx);
    files = new ProcessFiles(engine);
  }
  const lease = files.openHost(CRED_SESSION_USER);
  const drained = await drainProcessFsJournal({ journal: journalSource(sqlJournal(sql)), session: journalDrainSession(lease.fs, PID), retry: RETRY });
  await lease.dispose();
  assert.deepEqual(drained.failures, [], `${restarted ? 'after a restart, ' : ''}the drain refused a write its description allows`);
  assert.equal(drained.landed, 1);
  assert.equal(dec.decode(engine.as(CRED_KERNEL).readFile('home/user/out/moved.txt')), 'new!', 'the drained write did not land on its description\'s file');
  const kept = () => [...s.sql.exec('SELECT id FROM vfs_wave_descriptions WHERE pid = ?', PID)].length;
  assert.equal(kept(), 1);
  engine.forgetSequences(PID);
  assert.equal(kept(), 0, 'what the session kept of its descriptions outlived the process');
}

// ── A log the version before a W7 open's access wrote, drained by this one ──
// Its rows hold opens as that version's session took them: O_RDWR as
// `read: true`, O_WRONLY as no access field. A deploy between a process's
// death and its drain hands them to this version, whose frame takes an open's
// access only as `access`; each lands with the access it had, its writes
// with it. Red before: the drain sent them as they were, and the frame
// refused the open, so it and every write after it were lost.
{
  const s = session();
  for (const name of ['rw.txt', 'w.txt']) {
    s.kernel.writeFile(`home/user/out/${name}`, enc.encode('old!'));
    s.kernel.chown(`home/user/out/${name}`, CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  }
  const sql = facetSql();
  sqlJournal(sql);
  const rows = [
    [{ type: 'call', call: { call: 'open', path: 'home/user/out/rw.txt', mode: 0o644, read: true, description: 'd-rw' } }, null],
    [{ type: 'call', call: { call: 'write', path: 'home/user/out/rw.txt', description: 'd-rw', offset: 0 } }, enc.encode('RW!!')],
    [{ type: 'call', call: { call: 'close', path: 'home/user/out/rw.txt', description: 'd-rw' } }, null],
    [{ type: 'call', call: { call: 'open', path: 'home/user/out/w.txt', mode: 0o644, truncate: true, description: 'd-w' } }, null],
    [{ type: 'call', call: { call: 'write', path: 'home/user/out/w.txt', description: 'd-w', offset: 0 } }, enc.encode('W')],
    [{ type: 'call', call: { call: 'close', path: 'home/user/out/w.txt', description: 'd-w' } }, null],
    [{ type: 'call', call: { call: 'open', path: 'home/user/out/made.txt', mode: 0o640, create: true, exclusive: true, umask: 0o022 } }, null],
  ];
  rows.forEach(([op, data], i) => sql.exec('INSERT INTO nimbus_fs_journal (jid, op, data) VALUES (?, ?, ?)', i + 1, JSON.stringify(op), data));
  const lease = s.files.openHost(CRED_SESSION_USER);
  const drained = await drainProcessFsJournal({ journal: journalSource(sqlJournal(sql)), session: journalDrainSession(lease.fs, PID), retry: RETRY });
  await lease.dispose();
  assert.deepEqual(drained.failures, [], 'the drain refused an open the version before wrote');
  assert.equal(drained.landed, rows.length);
  assert.deepEqual(
    { rw: s.text('home/user/out/rw.txt'), w: s.text('home/user/out/w.txt'), made: s.text('home/user/out/made.txt'), mode: s.kernel.stat('home/user/out/made.txt').mode & 0o777 },
    { rw: 'RW!!', w: 'W', made: '', mode: 0o640 },
  );
  assert.equal(sqlJournal(sql).entries().length, 0);
  s.engine.forgetSequences(PID);
}

// ── The effect gate: an effect waits for every change ahead of it to be answered, durable log or not ──
// (ProcessFsClient.effect.) Red before: there was no gate, and a one-shot's
// output left ahead of changes it could still lose; then (review 2) a
// resident's durable log released its effects at once, so what read its
// output (the next command) could miss changes made before it.
{
  const s = session();
  const gate = Promise.withResolvers();
  s.fault = async (deliver) => { await gate.promise; return deliver(); };
  const durable = processFsClient({ session: s.port, journal: sqlJournal(facetSql()), retry: RETRY });
  durable.submit(writeFile('home/user/out/g0', 'a'), { acknowledged: true });
  const residentEffect = durable.effect();
  assert.ok(residentEffect instanceof Promise, 'a resident released an effect ahead of a change the session had not made visible');
  let residentDone = false;
  residentEffect.then(() => { residentDone = true; });
  const heap = processFsClient({ session: s.port, retry: RETRY });
  assert.equal(heap.effect(), null, 'nothing logged: nothing to wait for');
  heap.submit(writeFile('home/user/out/g1', 'b'), { acknowledged: true });
  const released = heap.effect();
  assert.ok(released instanceof Promise);
  let done = false;
  released.then(() => { done = true; });
  // Logged after the effect: not waited for.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(done, false, 'the effect was released before the change ahead of it was answered');
  assert.equal(residentDone, false, 'a resident\'s effect was released before the change ahead of it was answered');
  gate.resolve();
  s.fault = null;
  await released;
  await residentEffect;
  assert.equal(s.text('home/user/out/g1'), 'b');
  assert.equal(s.text('home/user/out/g0'), 'a');
  await durable.settle();
  await heap.settle();
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
  const drained = await drainProcessFsJournal({ journal: journalSource(sqlJournal(sql)), session: s.port, retry: RETRY });
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
