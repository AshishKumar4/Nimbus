#!/usr/bin/env bun
/**
 * process-fs-client — a process's mutations as numbered calls in W7 waves
 * (core _shared/process-fs-client.ts), against a session served in process
 * (SqliteVFS behind the supervisor op, a writer epoch from its deliveries).
 *
 * What it keeps: program order across files; a lone op is a wave of one and
 * the ops of one turn share a wave; a synchronous loop's ops go in as few
 * waves as W7's bounds allow; a wave whose answer is lost is sent again and
 * applied once; a refusal answers its op and the log goes on; an op the
 * program was told succeeded and the session refused is a failure settle()
 * names; a lost epoch fails its ops and the next go under a new one; the
 * synchronous cap refuses ENOMEM; a large file goes in pieces. Grants: a
 * subtree is taken after GRANT_AFTER mutations, with no wave of the
 * process's in flight; what is decided there (numbered from the grant) is
 * the session's; a foreign read recalls it and finds the log sent; an idle
 * grant is given back, and every one at settle; a refused subtree is not
 * asked for again.
 */

import assert from 'node:assert/strict';
import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { SupervisorDeliveries } from '../../packages/core/src/workspace/supervisor-delivery.ts';
import { createSupervisorOpHandler } from '../../packages/core/src/workspace/supervisor-op.ts';
import { DECIDED_BACKLOG_OPS, processFsClient } from '../../packages/core/src/_shared/process-fs-client.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { withRecall } from '../../packages/core/src/vfs/recall.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();
const PID = 41;
const RETRY = { backoffMs: [1, 1, 1], stallMs: 2_000, answerDeadlineMs: 2_000 };

/**
 * A session in process. `fault(attempt)` may stand in for the transport: it
 * answers what the session answered, or throws after (a lost answer) or
 * instead of (a refused epoch) delivering it.
 */
function session({ fenced = true } = {}) {
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = engine.as(CRED_KERNEL);
  kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
  kernel.chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  const files = new ProcessFiles(engine);
  files.bind({ pid: PID, cred: CRED_SESSION_USER });
  const deliveries = new SupervisorDeliveries();
  const op = createSupervisorOpHandler({ vfs: engine, filesystem: files, deliveries });
  const calls = { waves: 0, epochs: 0, ops: [] };
  const s = {
    kernel,
    files,
    op,
    calls,
    fault: null,
    text: (key) => { try { return dec.decode(kernel.readFile(key)); } catch { return null; } },
    port: {
      openWriter: async () => {
        calls.epochs++;
        return fenced ? deliveries.openWaveWriter(PID, 60_000) : null;
      },
      retireWriter: async (writer) => {
        calls.retired = [...(calls.retired ?? []), writer];
        await op({ op: 'retireWaveWriter', args: [writer], pid: PID });
      },
      writeBatchStream: async (stream, fence, owner) => {
        calls.waves++;
        const deliver = () => op({
          op: 'writeBatchStream', args: [], pid: PID, stream,
          ...(fence ? { waveFence: { ...fence, hostIncarnation: deliveries.incarnation } } : {}),
          ...(owner ? { mutationOwner: owner } : {}),
        });
        return s.fault ? s.fault(deliver, fence) : deliver();
      },
      grants: {
        acquire: (path, delegate) => op({ op: 'fsAcquireExclusiveMutation', args: [path, { delegate }], pid: PID }),
        release: (owner) => op({ op: 'fsReleaseExclusiveMutation', args: [owner], pid: PID }),
        awaitRecall: (owner, waitMs) => op({ op: 'fsAwaitRecall', args: [owner, waitMs], pid: PID }),
        recalled: (owner, kind) => op({ op: 'fsRecalled', args: [owner, kind], pid: PID }),
      },
    },
  };
  return s;
}

/** Resolves once `ready()` answers, polling. */
async function until(ready, what) {
  for (let i = 0; i < 400; i++) {
    const value = ready();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`never: ${what}`);
}

const client = (s, extra = {}) => processFsClient({ session: s.port, retry: RETRY, ...extra });
const writeFile = (path, text) => ({ type: 'call', call: { call: 'writeFile', path, mode: 0o644, data: typeof text === 'string' ? enc.encode(text) : text } });
const appendFile = (path, text) => ({ type: 'call', call: { call: 'appendFile', path, mode: 0o644, data: enc.encode(text) } });
const mkdir = (path) => ({ type: 'call', call: { call: 'mkdir', path, mode: 0o755 } });

// ── A synchronous loop: program order across files, in as few waves as W7 allows ──
{
  const s = session();
  const c = client(s);
  c.submit(mkdir('home/user/src'), { acknowledged: true });
  for (let i = 0; i < 2_000; i++) {
    if (i % 100 === 0) c.submit(mkdir(`home/user/src/d${i / 100}`), { acknowledged: true });
    c.submit(writeFile(`home/user/src/d${Math.floor(i / 100)}/f${i}`, `file ${i}`), { acknowledged: true });
    c.submit(appendFile('home/user/log', `${i}\n`), { acknowledged: true });
  }
  await c.settle();
  assert.equal(s.text('home/user/src/d7/f777'), 'file 777');
  assert.equal(s.text('home/user/log').split('\n').length, 2_001, 'appends were lost or doubled');
  assert.equal(s.text('home/user/log').split('\n')[1_234], '1234', 'appends lost their order');
  // 4,021 ops over 2,022 names: a wave holds at most W7's 1,016 names.
  const stats = c.stats();
  assert.equal(stats.ops, 4_021);
  assert.ok(s.calls.waves <= 4, `${s.calls.waves} waves for one synchronous loop`);
  assert.equal(s.calls.epochs, 1);
}

// ── A lone op is a wave of one; the ops of one turn share a wave ─────────
{
  const s = session();
  const c = client(s);
  await c.submit(writeFile('home/user/one', '1'));
  assert.equal(s.calls.waves, 1);
  await Promise.all([c.submit(mkdir('home/user/a')), c.submit(mkdir('home/user/b'))]);
  assert.equal(s.calls.waves, 2, 'two ops made in one turn went in two waves');
  const answered = await c.submit(writeFile('home/user/a/f', 'f'));
  assert.equal(answered.receipt.size, 1, 'a writeFile is answered with its receipt');
  assert.equal(answered.receipt.ino, s.kernel.stat('home/user/a/f').ino);
}

// ── A lost answer: the wave goes again, and is applied once ──────────────
{
  const s = session();
  const c = client(s);
  let lost = 1;
  s.fault = async (deliver) => {
    const answer = await deliver();
    if (lost-- > 0) throw Object.assign(new Error('Network connection lost.'), { retryable: true });
    return answer;
  };
  await Promise.all([c.submit(appendFile('home/user/once', 'a')), c.submit(mkdir('home/user/made'))]);
  assert.equal(s.text('home/user/once'), 'a', 'a re-sent append applied twice');
  assert.equal(c.stats().resends, 1);
}

// ── A refusal answers its op; the log goes on; an acknowledged one is reported ──
{
  const s = session();
  const c = client(s);
  s.kernel.mkdir('home/user/exists');
  const refused = c.submit(mkdir('home/user/exists'));
  const after = c.submit(writeFile('home/user/after', 'ok'));
  await assert.rejects(refused, (error) => error.code === 'EEXIST');
  await after;
  assert.equal(s.text('home/user/after'), 'ok', 'the op after a refused one was dropped');
  c.submit(writeFile('home/user/missing/x', 'x'), { acknowledged: true });
  c.submit(writeFile('home/user/later', 'l'), { acknowledged: true });
  await assert.rejects(c.settle(), (error) => error.code === 'EIO' && /writeFile home\/user\/missing\/x: ENOENT/.test(error.message));
  assert.equal(s.text('home/user/later'), 'l');
  assert.deepEqual(c.takeFailures(), [], 'settle took the failures it named');
}

// ── An epoch the session no longer holds: its ops fail, the next go under a new one ──
{
  const s = session();
  const c = client(s);
  await c.submit(writeFile('home/user/first', '1'));
  s.fault = async () => { throw Object.assign(new Error('ESTALE: write wave 2 attempt 1 names a writer epoch this session does not hold open'), { code: 'ESTALE' }); };
  await assert.rejects(c.submit(writeFile('home/user/gone', 'g')), (error) => error.code === 'EIO');
  s.fault = null;
  await c.submit(writeFile('home/user/next', 'n'));
  assert.equal(s.text('home/user/next'), 'n');
  assert.equal(s.calls.epochs, 2, 'the ops after a lost epoch were not sent under a new one');
}

// ── The synchronous cap refuses ENOMEM, logging nothing ──────────────────
{
  const s = session();
  const c = client(s, { syncCapBytes: 10 });
  c.submit(writeFile('home/user/small', '12345'), { acknowledged: true });
  assert.throws(() => c.submit(writeFile('home/user/big', '1234567890'), { acknowledged: true }), (error) => error.code === 'ENOMEM' && /10-byte cap/.test(error.message));
  await c.settle();
  assert.equal(s.text('home/user/big'), null);
  assert.equal(s.text('home/user/small'), '12345');
}

// ── A file larger than a wave goes in pieces, whole at the end ───────────
{
  const s = session();
  const c = client(s);
  const big = new Uint8Array(9 * 1024 * 1024 + 7).map((_, i) => i % 251);
  await c.submit(writeFile('home/user/big', big));
  assert.deepEqual(s.kernel.readFile('home/user/big'), big);
  assert.ok(c.stats().ops >= 3);
}

// ── A session that fences nothing: committedOps answers how far it went ──
{
  const s = session({ fenced: false });
  const c = client(s);
  s.kernel.mkdir('home/user/there');
  const refused = c.submit(mkdir('home/user/there'));
  const after = c.submit(writeFile('home/user/after', 'a'));
  await assert.rejects(refused, (error) => error.code === 'EEXIST');
  await after;
  assert.equal(s.text('home/user/after'), 'a');
}

// ── Grants: taken after GRANT_AFTER mutations; decided there, numbered, recalled ──
{
  const s = session();
  s.kernel.mkdir('home/user/g', { mode: 0o755 });
  s.kernel.chown('home/user/g', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  const released = [];
  const c = client(s, { grantAfter: 3, grantIdleMs: 60_000, recallPollMs: 100, released: (root) => released.push(root) });
  // Two mutations: the session decides them.
  for (const name of ['a', 'b']) {
    assert.equal(c.holder(`home/user/g/${name}`), undefined);
    await c.submit(writeFile(`home/user/g/${name}`, name));
  }
  // The third asks for the subtree.
  assert.equal(c.holder('home/user/g/c'), undefined);
  const grant = await until(() => c.holder('home/user/g/c'), 'the grant');
  assert.equal(grant.root, 'home/user/g');
  assert.equal(c.stats().grants, 1);
  // Decided here: answered at once, numbered from the grant, logged acknowledged.
  const ino = c.number(grant);
  assert.ok(Number.isInteger(ino));
  c.submit({ type: 'call', call: { call: 'writeFile', path: 'home/user/g/c', mode: 0o644, ino, data: enc.encode('decided') } }, { acknowledged: true });
  c.submit({ type: 'call', call: { call: 'mkdir', path: 'home/user/g/sub', mode: 0o755, ino: c.number(grant) } }, { acknowledged: true });
  // A foreign read recalls the subtree and finds the log sent.
  const read = await withRecall(() => s.kernel.readFileString('home/user/g/c'));
  assert.equal(read, 'decided');
  assert.equal(s.kernel.stat('home/user/g/c').ino, ino, 'a name the holder made lost the number it showed');
  assert.equal(c.stats().recalls, 1);
  assert.deepEqual(released, ['home/user/g'], 'a shared subtree is still decided here');
  assert.equal(c.holder('home/user/g/d'), undefined, 'a shared subtree is the session\'s to decide');
  await c.settle();
  assert.equal(s.files.delegations.size, 0, 'settle left a grant held');
}

// ── An idle grant is given back; a refused subtree is not asked for again ──
{
  const s = session();
  s.kernel.mkdir('home/user/idle', { mode: 0o755 });
  s.kernel.chown('home/user/idle', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  const c = client(s, { grantAfter: 1, grantIdleMs: 30, recallPollMs: 100 });
  c.holder('home/user/idle/x');
  await until(() => c.holder('home/user/idle/x'), 'the grant');
  await until(() => s.files.delegations.size === 0 && c.stats().released === 1, 'the idle release');
  // Another process's lease over a subtree: the session refuses it, and it is not asked for again.
  s.kernel.mkdir('home/user/theirs', { mode: 0o777 });
  s.files.bind({ pid: PID + 1, cred: CRED_SESSION_USER });
  await s.op({ op: 'fsAcquireExclusiveMutation', args: ['/home/user/theirs', {}], pid: PID + 1 });
  const other = client(s, { grantAfter: 1, grantIdleMs: 60_000, recallPollMs: 100 });
  other.holder('home/user/theirs/x');
  await until(() => other.stats().grantsRefused === 1, 'the refusal');
  other.holder('home/user/theirs/y');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(other.stats().grantsRefused, 1, 'a refused subtree was asked for again');
  assert.equal(other.stats().grants, 0);
  await other.settle();
  await c.settle();
}

// ── Two held subtrees: writes interleaved between them share one wave (no grant per record) ──
{
  const s = session();
  for (const dir of ['home/user/one', 'home/user/two']) {
    s.kernel.mkdir(dir, { mode: 0o755 });
    s.kernel.chown(dir, CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  }
  const c = client(s, { grantAfter: 1, grantIdleMs: 60_000, recallPollMs: 100 });
  c.holder('home/user/one/x');
  const one = await until(() => c.holder('home/user/one/x'), 'the first grant');
  c.holder('home/user/two/x');
  const two = await until(() => c.holder('home/user/two/x'), 'the second grant');
  const before = s.calls.waves;
  for (const name of ['a', 'b', 'c']) {
    for (const [dir, grant] of [['one', one], ['two', two]]) {
      c.submit({ type: 'call', call: { call: 'writeFile', path: `home/user/${dir}/${name}`, mode: 0o644, ino: c.number(grant), data: enc.encode(`${dir}${name}`) } }, { acknowledged: true });
    }
  }
  await c.flush();
  assert.equal(s.calls.waves - before, 1, 'writes interleaved between two held subtrees were cut into waves per subtree');
  assert.deepEqual(c.takeFailures(), []);
  await c.settle();
  assert.equal(s.text('home/user/one/c'), 'onec');
  assert.equal(s.text('home/user/two/b'), 'twob');
}

// ── rm, lchown and lutimes are calls in the log, applied as the session's own ──
{
  const s = session();
  const c = client(s);
  s.kernel.mkdir('home/user/tree/deep', { recursive: true });
  s.kernel.writeFile('home/user/tree/deep/f', 'f');
  s.kernel.chown('home/user/tree', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  s.kernel.chown('home/user/tree/deep', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  s.kernel.chown('home/user/tree/deep/f', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  s.kernel.writeFile('home/user/target', 't');
  s.kernel.chown('home/user/target', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  await c.submit({ type: 'call', call: { call: 'symlink', path: 'home/user/link', target: 'target' } });
  await assert.rejects(c.submit({ type: 'call', call: { call: 'rm', path: 'home/user/tree' } }), (error) => error.code === 'EISDIR' || error.code === 'EPERM');
  await c.submit({ type: 'call', call: { call: 'rm', path: 'home/user/tree', recursive: true } });
  assert.equal(s.kernel.exists('home/user/tree'), false);
  await assert.rejects(c.submit({ type: 'call', call: { call: 'rm', path: 'home/user/gone' } }), (error) => error.code === 'ENOENT');
  await c.submit({ type: 'call', call: { call: 'rm', path: 'home/user/gone', force: true } });
  await c.submit({ type: 'call', call: { call: 'lutimes', path: 'home/user/link', atime: 1_000, mtime: 2_000 } });
  assert.equal(s.kernel.lstat('home/user/link').mtime, 2_000, 'lutimes did not change the link itself');
  assert.notEqual(s.kernel.stat('home/user/target').mtime, 2_000, 'lutimes changed what the link names');
  await c.settle();
}

// ── A loop across many directories of one tree takes the tree, and its waves carry the rest ──
{
  const s = session();
  s.kernel.mkdir('home/user/tree', { mode: 0o755 });
  s.kernel.chown('home/user/tree', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  for (let d = 0; d < 16; d++) {
    s.kernel.mkdir(`home/user/tree/d${d}`, { mode: 0o755 });
    s.kernel.chown(`home/user/tree/d${d}`, CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  }
  const c = client(s, { grantAfter: 8, grantIdleMs: 60_000, recallPollMs: 100 });
  // Each directory has one write before the tree has eight.
  for (let i = 0; i < 8; i++) c.holder(`home/user/tree/d${i}/f`);
  const grant = await until(() => c.holder('home/user/tree/d9/f'), 'the tree');
  assert.equal(grant.root, 'home/user/tree', 'a loop across directories took a directory, not their tree');
  await c.settle();
}

// ── The same file's next bytes fold into its unsent change: 500 rewrites, one write ──
{
  const s = session();
  const c = client(s);
  const gate = Promise.withResolvers();
  s.fault = async (deliver) => { await gate.promise; return deliver(); };
  // The first goes out alone (nothing in flight); the rest wait behind it, and fold.
  for (let i = 0; i < 500; i++) c.submit(writeFile('home/user/rewritten', `version ${i}`), { acknowledged: true });
  for (let i = 0; i < 200; i++) c.submit(appendFile('home/user/appended', `${i},`), { acknowledged: true });
  c.submit(mkdir('home/user/between'), { acknowledged: true });
  c.submit(appendFile('home/user/appended', 'after'), { acknowledged: true });
  s.fault = null;
  gate.resolve();
  await c.settle();
  assert.equal(s.text('home/user/rewritten'), 'version 499');
  assert.equal(s.text('home/user/appended'), Array.from({ length: 200 }, (_, i) => `${i},`).join('') + 'after');
  assert.ok(c.stats().folded >= 697, `only ${c.stats().folded} folded`);
  assert.ok(s.calls.waves <= 3, `${s.calls.waves} waves`);
}

// ── What a held subtree decides ahead of the session is bounded ──
{
  const s = session();
  s.kernel.mkdir('home/user/b', { mode: 0o755 });
  s.kernel.chown('home/user/b', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  const c = client(s, { grantAfter: 1, grantIdleMs: 60_000, recallPollMs: 100 });
  c.holder('home/user/b/x');
  const grant = await until(() => c.holder('home/user/b/x'), 'the grant');
  // The session stops answering: what is decided here piles up, to the bound.
  const gate = Promise.withResolvers();
  s.fault = async (deliver) => { await gate.promise; return deliver(); };
  let decided = 0;
  while (c.holder(`home/user/b/f${decided}`) !== undefined && decided < DECIDED_BACKLOG_OPS + 10) {
    c.submit({ type: 'call', call: { call: 'writeFile', path: `home/user/b/f${decided}`, mode: 0o644, ino: c.number(grant), data: enc.encode('x') } }, { acknowledged: true });
    decided++;
  }
  assert.equal(decided, DECIDED_BACKLOG_OPS, `${decided} changes decided ahead of the session`);
  s.fault = null;
  gate.resolve();
  await c.flush();
  assert.equal(c.stats().recalls, 0, 'the process\'s own waves recalled its subtree');
  assert.notEqual(c.holder('home/user/b/next'), undefined, 'answered, the subtree is decided here again');
  await c.settle();
  assert.equal(s.text(`home/user/b/f${DECIDED_BACKLOG_OPS - 1}`), 'x');
}

// ── A grant whose range runs low is renewed, and nothing numbered from it is sent after it ends ──
{
  const s = session();
  s.kernel.mkdir('home/user/r', { mode: 0o755 });
  s.kernel.chown('home/user/r', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  const c = client(s, { grantAfter: 1, grantIdleMs: 60_000, recallPollMs: 100, grantInos: 8 });
  c.holder('home/user/r/x');
  await until(() => c.holder('home/user/r/x'), 'the grant');
  for (let i = 0; i < 60; i++) {
    const key = `home/user/r/f${i}`;
    const grant = c.holder(key);
    // A holder numbers a name, then logs it, in the same turn.
    const ino = grant === undefined ? undefined : c.number(grant);
    c.submit({ type: 'call', call: { call: 'writeFile', path: key, mode: 0o644, ...(ino === undefined ? {} : { ino }), data: enc.encode(`${i}`) } }, { acknowledged: true });
    if (i % 7 === 6) await new Promise((resolve) => setTimeout(resolve, 1));
  }
  await c.settle();
  assert.ok(c.stats().renewed >= 1, `never renewed: ${JSON.stringify(c.stats())}`);
  assert.equal(s.text('home/user/r/f59'), '59');
}

// ── Review 1: a recall freezes the grant before it sends, so its prefix is everything decided before it ──
// Red before: the flush took its watermark while the grant still decided
// locally; a write decided during the flush landed after the reader was let in.
{
  const s = session();
  s.kernel.mkdir('home/user/q', { mode: 0o755 });
  s.kernel.chown('home/user/q', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  const c = client(s, { grantAfter: 1, grantIdleMs: 60_000, recallPollMs: 50 });
  assert.equal(c.holder('home/user/q/a'), undefined);
  const grant = await until(() => c.holder('home/user/q/a'), 'the grant');
  c.submit({ type: 'call', call: { call: 'writeFile', path: 'home/user/q/a', mode: 0o644, ino: c.number(grant), data: enc.encode('a') } }, { acknowledged: true });
  // The recall's flush is held in the session: while it is, the process asks to decide another.
  let open;
  const held = new Promise((resolve) => { open = resolve; });
  s.fault = async (deliver) => { await held; return deliver(); };
  const reading = withRecall(() => s.kernel.readFileString('home/user/q/a'));
  await until(() => c.stats().recalls === 1, 'the recall');
  assert.equal(c.holder('home/user/q/b'), undefined, 'the grant still decided writes while its recall was being answered');
  s.fault = null;
  open();
  assert.equal(await reading, 'a');
  await c.settle();
}

// ── Review 3: an epoch given up is retired before the next one sends ──
// Red before: the timed-out wave's epoch stayed open, and its late attempt
// landed after (and over) what the new epoch wrote.
{
  const s = session();
  const late = [];
  // The first wave's attempt reaches the session only later; the writer gives it up.
  s.fault = (deliver, fence) => {
    if (fence?.wave === 1 && late.length === 0) {
      late.push(deliver);
      return new Promise(() => {});
    }
    return deliver();
  };
  const c = processFsClient({ session: s.port, retry: { backoffMs: [], stallMs: 30, answerDeadlineMs: 30 } });
  await assert.rejects(c.submit(writeFile('home/user/race', 'old')), (error) => error.code === 'EIO');
  await c.submit(writeFile('home/user/race', 'new'));
  assert.equal(s.text('home/user/race'), 'new');
  assert.equal(s.calls.retired?.length, 1, 'the given-up epoch was never retired');
  // The old attempt arrives now: refused, and the newer write stands.
  const answer = await late[0]().catch((error) => ({ ok: false, error }));
  assert.equal(answer.ok, false, 'a late attempt of a retired epoch was applied');
  assert.equal(s.text('home/user/race'), 'new');
}

// ── Review 11: what cannot be sent is refused, never left waiting ──
// Red before: a link target past what a wave carries made the encoder throw
// inside send, outside its catch, and the op's promise never settled; so did
// a journal that failed while the wave was numbered.
{
  const s = session();
  const c = client(s);
  const outcome = (promise) => Promise.race([promise.then(() => 'ok', (error) => error.code), new Promise((resolve) => setTimeout(() => resolve('pending'), 2_000))]);
  let refused;
  try { refused = c.submit({ type: 'call', call: { call: 'symlink', path: 'home/user/l', target: 'x'.repeat(70_000) } }); }
  catch (error) { refused = Promise.reject(error); }
  assert.equal(await outcome(refused), 'ENAMETOOLONG');
  await c.submit(writeFile('home/user/after', 'a'));
  assert.equal(s.text('home/user/after'), 'a');
}
{
  const s = session();
  const { memoryJournal } = await import('../../packages/core/src/_shared/process-fs-journal.ts');
  const inner = memoryJournal();
  let failNumbering = true;
  const journal = new Proxy(inner, {
    get(target, name, receiver) {
      if (name === 'number') return (numbering) => { if (failNumbering) { failNumbering = false; throw new Error('the journal could not be written'); } return target.number(numbering); };
      const value = Reflect.get(target, name, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const c = processFsClient({ session: s.port, retry: RETRY, journal });
  const outcome = (promise) => Promise.race([promise.then(() => 'ok', (error) => error.code), new Promise((resolve) => setTimeout(() => resolve('pending'), 2_000))]);
  assert.equal(await outcome(c.submit(writeFile('home/user/j1', '1'))), 'EIO', 'an op whose numbering failed was left waiting');
  await c.submit(writeFile('home/user/j2', '2'));
  assert.equal(s.text('home/user/j2'), '2');
}

// ── Review 9: a create carries the umask the process had when it made it ──
// Red before: the session applied its own record of the process's umask
// (0o022 here, set when the process started; a change reaches it by an RPC
// not ordered with the waves), so files and directories made after
// process.umask(0o077) came out 0o644 and 0o755.
{
  const s = session();
  let mask = 0o022;
  const c = client(s, { umask: () => mask });
  await c.submit({ type: 'call', call: { call: 'writeFile', path: 'home/user/before', mode: 0o666, data: enc.encode('b') } });
  mask = 0o077;
  await c.submit({ type: 'call', call: { call: 'writeFile', path: 'home/user/private', mode: 0o666, data: enc.encode('p') } });
  await c.submit({ type: 'call', call: { call: 'appendFile', path: 'home/user/log', mode: 0o666, data: enc.encode('l') } });
  await c.submit({ type: 'call', call: { call: 'mkdir', path: 'home/user/secret', mode: 0o777 } });
  // A call that names its umask keeps it (a holder's decided create).
  await c.submit({ type: 'call', call: { call: 'mkdir', path: 'home/user/open', mode: 0o777, umask: 0o002 } });
  const perm = (path) => s.kernel.stat(path).mode & 0o777;
  assert.equal(perm('home/user/before'), 0o644);
  assert.equal(perm('home/user/private'), 0o600, 'a file made after umask(0o077) was not masked by it');
  assert.equal(perm('home/user/log'), 0o600);
  assert.equal(perm('home/user/secret'), 0o700, 'a directory made after umask(0o077) was not masked by it');
  assert.equal(perm('home/user/open'), 0o775);
}

// ── Review 11 (recheck): an op that cannot be sent after a wave that landed leaves no gap ──
// Red before: the failed op's numbers were dropped with it, the epoch kept
// numbering by log position, and the next valid op was refused for the gap (EIO).
{
  const s = session();
  const c = client(s);
  await c.submit(writeFile('home/user/g1', '1'));
  const long = 'home/user/' + 'x'.repeat(33 * 1024);
  const refused = await c.submit({ type: 'rename', from: long, to: long + 'y' }).then(() => 'ok', (error) => error.code);
  assert.notEqual(refused, 'ok', 'a rename no wave can carry was answered as done');
  await c.submit(writeFile('home/user/g2', '2'));
  assert.equal(s.text('home/user/g2'), '2', 'the op after an unsendable one was refused');
}

// ── Review 3 (recheck): retiring an epoch waits for a mount's call of it already made ──
// Red before: the retirement answered at once; a slow mounted write of the
// given-up wave landed after (and over) what the next epoch wrote.
{
  const s = session();
  const { MemoryVFS } = await import('../../packages/core/src/vfs/memory.ts');
  const slow = new MemoryVFS();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const backend = new Proxy(slow, {
    get(target, name) {
      if (name === 'writeFile') {
        return async (path, data, options) => {
          // The first write waits in the backend, past the writer's patience.
          if (calls++ === 0) await held;
          return target.writeFile(path, data, options);
        };
      }
      const value = Reflect.get(target, name);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  s.files.vfs.mount('/slow', backend);
  const c = processFsClient({ session: s.port, retry: { backoffMs: [], stallMs: 30, answerDeadlineMs: 30 } });
  await assert.rejects(c.submit({ type: 'call', call: { call: 'writeFile', path: 'slow/race', mode: 0o644, data: enc.encode('old') } }), (error) => error.code === 'EIO');
  // The next write waits for the retirement, which waits for the old call.
  const next = c.submit({ type: 'call', call: { call: 'writeFile', path: 'slow/race', mode: 0o644, data: enc.encode('new') } });
  setTimeout(release, 100);
  await next;
  assert.equal(dec.decode(slow.readFile('/race')), 'new', 'the given-up wave\'s mounted write landed over the next epoch\'s');
}

console.log('process-fs-client: ok');
