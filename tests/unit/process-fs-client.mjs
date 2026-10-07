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
import { processFsClient } from '../../packages/core/src/_shared/process-fs-client.ts';
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

console.log('process-fs-client: ok');
