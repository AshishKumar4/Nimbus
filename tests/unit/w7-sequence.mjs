#!/usr/bin/env bun
/**
 * w7-sequence — a sequenced writer's waves (WaveSequence): a process's
 * filesystem client numbers its ops, and the session keeps the writer's
 * cursor in the transaction that commits each one, so a wave sent again
 * (its answer lost) is answered and never applied twice. A refusal is the
 * op's answer, kept until the writer has had it: nothing after it applies.
 *
 * Red before: a re-sent appendFile appended twice, a re-sent mkdir was
 * refused EEXIST by its own first attempt, and a wave cut short could only
 * be re-sent whole, applying its first ops again.
 */

import assert from 'node:assert/strict';
import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { SupervisorDeliveries } from '../../packages/core/src/workspace/supervisor-delivery.ts';
import { createSupervisorOpHandler } from '../../packages/core/src/workspace/supervisor-op.ts';
import { encodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();

function session() {
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = engine.as(CRED_KERNEL);
  kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
  kernel.chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  kernel.mkdir('shared', { mode: 0o755 });
  const files = new ProcessFiles(engine);
  const shared = new MemoryVFS();
  files.vfs.mount('/shared', shared);
  const user = engine.as(CRED_SESSION_USER);
  /** A wave of `ops` under `writer`, numbered from `first`, straight to the engine. */
  const send = (writer, first, ops, { ack = 0, stream } = {}) => user.writeStream(
    stream ?? encodeWriteBatchStream({ inodes: [], chunks: [], ops }),
    { sequence: { writer, first, ack } },
  );
  const text = (key) => { try { return dec.decode(kernel.readFile(key)); } catch { return null; } };
  return { engine, kernel, user, files, shared, send, text };
}

const call = (c) => ({ type: 'call', call: c });
const write = (path, text) => call({ call: 'writeFile', path, mode: 0o644, data: enc.encode(text) });
const append = (path, text) => call({ call: 'appendFile', path, mode: 0o644, data: enc.encode(text) });
const mkdir = (path) => call({ call: 'mkdir', path, mode: 0o755 });

/** `ops` encoded, the stream cut (errored) once `keep` of its bytes were read. */
async function cut(ops, keep) {
  const bytes = new Uint8Array(await new Response(encodeWriteBatchStream({ inodes: [], chunks: [], ops })).arrayBuffer());
  let sent = false;
  return new ReadableStream({
    type: 'bytes',
    pull(controller) {
      if (sent) { controller.error(new Error('transport lost')); return; }
      sent = true;
      controller.enqueue(bytes.slice(0, keep));
    },
  });
}

// ── A wave sent again is answered, not applied twice ────────────────────
{
  const s = session();
  const ops = [mkdir('home/user/d'), append('home/user/log', 'one\n'), write('home/user/d/f', 'f')];
  const first = await s.send('w1', 1, ops);
  assert.equal(first.ok, true, JSON.stringify(first.error));
  assert.deepEqual(first.sequence, { cursor: 3 });
  const again = await s.send('w1', 1, ops);
  assert.equal(again.ok, true, `a re-sent wave was refused by its own first attempt: ${JSON.stringify(again.error)}`);
  assert.deepEqual(again.sequence, { cursor: 3 });
  assert.equal(again.committedOps, 0, 'a re-sent wave applied its ops again');
  assert.equal(s.text('home/user/log'), 'one\n', 'a re-sent appendFile appended twice');
  // The next ops go on from the cursor.
  const next = await s.send('w1', 4, [append('home/user/log', 'two\n')], { ack: 3 });
  assert.equal(next.ok, true, JSON.stringify(next.error));
  assert.deepEqual(next.sequence, { cursor: 4 });
  assert.equal(s.text('home/user/log'), 'one\ntwo\n');
  // Another writer has a cursor of its own.
  const other = await s.send('w2', 1, [append('home/user/log', 'other\n')]);
  assert.deepEqual(other.sequence, { cursor: 1 });
  assert.equal(s.text('home/user/log'), 'one\ntwo\nother\n');
}

// ── A wave cut short: what committed is answered, the rest applies on the re-send ──
{
  const s = session();
  const ops = [append('home/user/a', 'a'), append('home/user/b', 'b'), append('home/user/c', 'c'), append('home/user/d', 'd')];
  const whole = new Uint8Array(await new Response(encodeWriteBatchStream({ inodes: [], chunks: [], ops })).arrayBuffer());
  const partial = await s.send('w', 1, ops, { stream: await cut(ops, Math.floor(whole.byteLength * 0.6)) });
  assert.equal(partial.ok, false);
  const reached = partial.sequence.cursor;
  assert.ok(reached >= 1 && reached < 4, `the cut wave committed ${reached} ops`);
  assert.equal(partial.sequence.refused, undefined, 'a lost transport is not a refusal');
  const resent = await s.send('w', 1, ops);
  assert.equal(resent.ok, true, JSON.stringify(resent.error));
  assert.deepEqual(resent.sequence, { cursor: 4 });
  assert.equal(resent.committedOps, 4 - reached);
  for (const name of ['a', 'b', 'c', 'd']) assert.equal(s.text(`home/user/${name}`), name, `${name} applied ${s.text(`home/user/${name}`)?.length} times`);
}

// ── A refusal is the op's answer, kept for a re-send; nothing after it applies ──
{
  const s = session();
  const ops = [mkdir('home/user/r'), write('home/user/r/x', 'x'), mkdir('home/user/r'), write('home/user/r/y', 'y')];
  const refused = await s.send('w', 1, ops);
  assert.equal(refused.ok, false);
  assert.equal(refused.error.errno, 'EEXIST');
  assert.equal(refused.sequence.cursor, 3);
  assert.equal(refused.sequence.refused.seq, 3);
  assert.equal(refused.sequence.refused.errno, 'EEXIST');
  assert.equal(s.text('home/user/r/y'), null, 'an op after the refused one applied');
  // Its answer lost, the wave comes again: the same answer, nothing applied.
  const again = await s.send('w', 1, ops);
  assert.equal(again.ok, false);
  assert.deepEqual(again.sequence, refused.sequence);
  assert.equal(s.text('home/user/r/y'), null);
  // The writer drops the refused op and goes on from the one after it.
  const rest = await s.send('w', 4, [ops[3]], { ack: 3 });
  assert.equal(rest.ok, true, JSON.stringify(rest.error));
  assert.deepEqual(rest.sequence, { cursor: 4 });
  assert.equal(s.text('home/user/r/y'), 'y');
}

// ── A wave past the cursor names ops the session never had; upserts are not numbered ──
{
  const s = session();
  await s.send('w', 1, [write('home/user/one', '1')]);
  const gap = await s.send('w', 3, [write('home/user/three', '3')]);
  assert.equal(gap.ok, false);
  assert.equal(gap.error.errno, 'ESTALE');
  assert.equal(s.text('home/user/three'), null);
  const upsert = await s.send('w', 2, [{ type: 'directory', inode: { path: 'home/user/up', parentPath: 'home/user', kind: 'directory', isDir: true, size: 0, mtime: 1, mode: 0o755, chunkCount: 0 } }]);
  assert.equal(upsert.ok, false);
  assert.equal(upsert.error.errno, 'EINVAL');
  assert.equal(upsert.sequence.refused, undefined, 'a wave the session cannot number refused no op of it');
}

// ── An open description's writes: at an offset, at the end, a truncate; by its inode ──
{
  const s = session();
  s.user.writeFile('home/user/desc', 'abcdef');
  const ino = s.user.stat('home/user/desc').ino;
  const ops = [
    call({ call: 'write', path: 'home/user/desc', ino, offset: 2, data: enc.encode('XY') }),
    call({ call: 'append', path: 'home/user/desc', ino, data: enc.encode('!') }),
    call({ call: 'write', path: 'home/user/desc', ino, offset: 10, data: enc.encode('z') }),
  ];
  const wrote = await s.send('w', 1, ops);
  assert.equal(wrote.ok, true, JSON.stringify(wrote.error));
  assert.equal(s.text('home/user/desc'), 'abXYef!\0\0\0z');
  // Renamed by another process under the description: the write follows the file.
  s.user.rename('home/user/desc', 'home/user/moved');
  const moved = await s.send('w', 4, [
    call({ call: 'ftruncate', path: 'home/user/desc', ino, size: 4 }),
    call({ call: 'append', path: 'home/user/desc', ino, data: enc.encode('+') }),
  ], { ack: 3 });
  assert.equal(moved.ok, true, JSON.stringify(moved.error));
  assert.equal(s.text('home/user/moved'), 'abXY+');
  assert.equal(s.text('home/user/desc'), null, 'a description\'s write made a file at its old name');
  // No name has it any more: its bytes go with it, and nothing is made.
  s.user.unlink('home/user/moved');
  const orphan = await s.send('w', 6, [call({ call: 'write', path: 'home/user/moved', ino, offset: 0, data: enc.encode('lost') })], { ack: 5 });
  assert.equal(orphan.ok, true, JSON.stringify(orphan.error));
  assert.equal(s.text('home/user/moved'), null);
}

// ── mkdir -p: a directory there answers success; anything else there is EEXIST ──
{
  const s = session();
  s.user.mkdir('home/user/made', { mode: 0o755 });
  s.user.writeFile('home/user/plain', 'p');
  const existing = (path) => call({ call: 'mkdir', path, mode: 0o755, existing: 'ok' });
  const made = await s.send('w', 1, [existing('home/user/made'), existing('home/user/fresh')]);
  assert.equal(made.ok, true, JSON.stringify(made.error));
  assert.equal(s.user.stat('home/user/fresh').type, 'directory');
  const file = await s.send('w', 3, [existing('home/user/plain')], { ack: 2 });
  assert.equal(file.ok, false);
  assert.equal(file.error.errno, 'EEXIST');
}

// ── Consecutive calls commit together; a refusal among them commits the ones before it ──
{
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = engine.as(CRED_KERNEL);
  kernel.mkdir('home/user/g', { recursive: true });
  kernel.chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  kernel.chown('home/user/g', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  // Outermost commits only: a nested transactionSync is a savepoint of its parent.
  const storage = harness.ctx.storage;
  const nested = storage.transactionSync.bind(storage);
  let depth = 0;
  let commits = 0;
  storage.transactionSync = (callback) => {
    if (depth === 0) commits++;
    depth++;
    try { return nested(callback); } finally { depth--; }
  };
  const user = engine.as(CRED_SESSION_USER);
  const ops = Array.from({ length: 200 }, (_, i) => write(`home/user/g/f${i}`, `${i}`));
  const before = commits;
  const grouped = await user.writeStream(encodeWriteBatchStream({ inodes: [], chunks: [], ops }), { sequence: { writer: 'g', first: 1, ack: 0 } });
  assert.equal(grouped.ok, true, JSON.stringify(grouped.error));
  assert.deepEqual(grouped.sequence, { cursor: 200 });
  assert.ok(commits - before <= 4, `200 writeFile calls took ${commits - before} commits`);
  assert.equal(new TextDecoder().decode(kernel.readFile('home/user/g/f199')), '199');
  // A refusal in the middle of a group: those before it land, it and those after it do not.
  kernel.mkdir('home/user/g/taken');
  const mixed = [write('home/user/g/m0', 'a'), write('home/user/g/m1', 'b'), mkdir('home/user/g/taken'), write('home/user/g/m2', 'c')];
  const refused = await user.writeStream(encodeWriteBatchStream({ inodes: [], chunks: [], ops: mixed }), { sequence: { writer: 'g', first: 201, ack: 200 } });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.errno, 'EEXIST');
  assert.equal(refused.sequence.refused.seq, 203);
  assert.equal(refused.committedOps, 2);
  assert.equal(kernel.exists('home/user/g/m1'), true);
  assert.equal(kernel.exists('home/user/g/m2'), false, 'a call after the refused one landed');
}

// ── Through the supervisor op: the writer is the process's epoch; on a mount too ──
{
  const s = session();
  const deliveries = new SupervisorDeliveries();
  const op = createSupervisorOpHandler({ vfs: s.engine, filesystem: s.files, deliveries });
  const epoch = deliveries.openWaveWriter(9, 60_000);
  const ops = [append('home/user/via', 'v'), append('shared/mounted', 'm')];
  const fence = (attempt, seq, ack) => ({ writer: epoch, wave: 1, attempt, hostIncarnation: deliveries.incarnation, seq, ack });
  const once = await op({ op: 'writeBatchStream', args: [], pid: 9, stream: encodeWriteBatchStream({ inodes: [], chunks: [], ops }), waveFence: fence(1, 1, 0) });
  assert.equal(once.ok, true, JSON.stringify(once.error));
  assert.deepEqual(once.sequence, { cursor: 2 });
  const twice = await op({ op: 'writeBatchStream', args: [], pid: 9, stream: encodeWriteBatchStream({ inodes: [], chunks: [], ops }), waveFence: fence(2, 1, 0) });
  assert.equal(twice.ok, true, JSON.stringify(twice.error));
  assert.equal(s.text('home/user/via'), 'v');
  assert.equal(dec.decode(s.shared.readFile('/mounted')), 'm', 'a re-sent append on a mount appended twice');
}

console.log('w7-sequence: ok');
