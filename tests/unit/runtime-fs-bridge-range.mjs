#!/usr/bin/env bun
// Unit tests for SqliteRuntimeFsBridge range ops (readRange/writeRange/
// truncate), per-path revision semantics (stat().revision, revision(path),
// expectedRevision, handle ESTALE isolation), and symlink resolution
// through durable SqliteVFS symlink inodes.

import assert from 'node:assert/strict';
import {
  SqliteVFS,
  VFS_APPEND_RECEIPT_LIMIT,
} from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { SqliteRuntimeFsBridge } from '../../packages/worker/src/runtime/sqlite-runtime-fs-bridge.ts';
import { CRED_KERNEL } from '../../packages/worker/src/runtime/os-contracts.ts';
import {
  CHUNK_SIZE,
  MAX_TX_BLOB_BYTES,
  MAX_TX_LOGICAL_ROWS,
} from '../../packages/worker/src/constants.ts';
import { getSymlinkRegistry } from '../../packages/worker/src/vfs/symlink-registry.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const APPEND_MODULE = '77777777-7777-4777-8777-777777777777';

function makeBridge() {
  const harness = createSqliteVfsTestHarness();
  const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
  return {
    harness,
    rawVfs,
    vfs: rawVfs.as(CRED_KERNEL),
    bridge: new SqliteRuntimeFsBridge(rawVfs.as(CRED_KERNEL), rawVfs),
  };
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const CRED_OTHER = Object.freeze({
  uid: 2001,
  gid: 2001,
  groups: Object.freeze([2001]),
  umask: 0o022,
});

// ── readRange / writeRange / truncate basics ──
{
  const { bridge } = makeBridge();
  await bridge.writeFile('/home/user/data.txt', 'hello world');

  assert.equal(dec.decode(await bridge.readRange('/home/user/data.txt', 6, 5)), 'world');
  assert.equal((await bridge.readRange('/home/user/data.txt', 100, 5)).length, 0, 'past EOF clamps to empty');
  assert.equal(await bridge.readRange('/home/user/missing.txt', 0, 5), null, 'missing file reads as null');

  const written = await bridge.writeRange('/home/user/data.txt', 6, enc.encode('WORLD'));
  assert.equal(written, 5);
  assert.equal(dec.decode(await bridge.readFile('/home/user/data.txt')), 'hello WORLD');

  // writeRange creates missing files and parents (like writeFile).
  await bridge.writeRange('/home/user/new/dir/file.bin', 2, enc.encode('xy'));
  const created = await bridge.readFile('/home/user/new/dir/file.bin');
  assert.deepEqual(Array.from(created), [0, 0, 120, 121]);
  assert.equal((await bridge.stat('/home/user/new/dir')).type, 'directory');

  await bridge.truncate('/home/user/data.txt', 5);
  assert.equal(dec.decode(await bridge.readFile('/home/user/data.txt')), 'hello');
  await assert.rejects(bridge.truncate('/home/user/missing.txt', 0), /ENOENT/);
  await bridge.mkdir('/home/user/adir');
  await assert.rejects(bridge.truncate('/home/user/adir', 0), /EISDIR/);
  await assert.rejects(bridge.writeRange('/home/user/adir', 0, enc.encode('x')), /EISDIR/);
}

// ── read misses are null; permission and type errors stay errors ──
{
  const { rawVfs, vfs } = makeBridge();
  vfs.mkdir('/private', { mode: 0o700 });
  vfs.writeFile('/private/hidden.txt', 'hidden');
  vfs.mkdir('/visible', { mode: 0o711 });
  vfs.writeFile('/visible/denied.txt', 'denied', { mode: 0o000 });
  vfs.mkdir('/visible/directory', { mode: 0o755 });

  const denied = new SqliteRuntimeFsBridge(rawVfs.as(CRED_OTHER), rawVfs);
  await assert.rejects(
    denied.stat('/private/hidden.txt'),
    (error) => error.code === 'EACCES',
  );
  await assert.rejects(
    denied.readFile('/visible/denied.txt'),
    (error) => error.code === 'EACCES',
  );
  await assert.rejects(
    denied.readRange('/visible/denied.txt', 0, 1),
    (error) => error.code === 'EACCES',
  );
  await assert.rejects(
    denied.readRange('/visible/directory', 0, 1),
    (error) => error.code === 'EISDIR',
  );
  assert.equal(await denied.stat('/visible/missing.txt'), null);
  assert.equal(await denied.readFile('/visible/missing.txt'), null);
  assert.equal(await denied.readRange('/visible/missing.txt', 0, 1), null);
}

// ── per-path revisions: stat().revision + revision(path) isolation ──
{
  const { bridge } = makeBridge();
  await bridge.writeFile('/a/one.txt', '1');
  await bridge.writeFile('/b/two.txt', '2');

  const aRev = (await bridge.stat('/a/one.txt')).revision;
  assert.equal(aRev, await bridge.revision('/a/one.txt'));

  await bridge.writeFile('/b/two.txt', '22');
  assert.equal((await bridge.stat('/a/one.txt')).revision, aRev,
    'mutating /b must not move /a revisions');
  assert.ok((await bridge.stat('/b/two.txt')).revision > aRev);
  assert.ok((await bridge.revision()) >= (await bridge.revision('/b')), 'global watermark covers all subtrees');

  // expectedRevision: per-path compare-and-set.
  const cur = await bridge.revision('/a/one.txt');
  await bridge.writeFile('/a/one.txt', 'fresh', { expectedRevision: cur });
  await assert.rejects(
    bridge.writeFile('/a/one.txt', 'stale', { expectedRevision: cur }),
    /ESTALE/,
  );
  await assert.rejects(
    bridge.writeRange('/a/one.txt', 0, enc.encode('s'), { expectedRevision: cur }),
    /ESTALE/,
  );
  // Mutations elsewhere do NOT invalidate a per-path expectedRevision.
  const aNow = await bridge.revision('/a/one.txt');
  await bridge.writeFile('/b/two.txt', 'unrelated');
  await bridge.writeRange('/a/one.txt', 0, enc.encode('F'), { expectedRevision: aNow });
  assert.equal(dec.decode(await bridge.readFile('/a/one.txt')), 'Fresh');
}

// ── handles: positional range IO without whole-file rewrites ──
{
  const { harness, bridge } = makeBridge();
  const big = new Uint8Array(CHUNK_SIZE * 2);
  big.fill(9);
  await bridge.writeFile('/wk/big.bin', big);
  const handle = await bridge.open('/wk/big.bin', { read: true, write: true });
  // Positional read.
  assert.deepEqual(Array.from(await bridge.read(handle.id, 5, 3)), [9, 9, 9]);
  // Sequential read advances the cursor.
  await bridge.read(handle.id, null, 4);
  assert.equal((await bridge.read(handle.id, null, 0)).length, 0);

  // Positional write inside chunk 1 must commit exactly one chunk.
  const statementStart = harness.statementCount;
  await bridge.write(handle.id, CHUNK_SIZE + 10, enc.encode('zz'));
  const chunkWrites = harness.statements.slice(statementStart)
    .filter((statement) => /INSERT OR REPLACE INTO file_chunks/i.test(statement.sql))
    .reduce((count, statement) => count + (statement.params.length / 3), 0);
  assert.equal(chunkWrites, 1, 'a small positional write must rewrite only the touched chunk');
  const verify = await bridge.readRange('/wk/big.bin', CHUNK_SIZE + 9, 4);
  assert.deepEqual(Array.from(verify), [9, 122, 122, 9]);
  assert.equal((await bridge.stat('/wk/big.bin')).size, big.length, 'positional write must not grow the file');
  await bridge.close(handle.id);

  // Append-flag handle writes land at EOF.
  const app = await bridge.open('/wk/big.bin', { write: true, append: true });
  await bridge.write(app.id, null, enc.encode('tail'));
  assert.equal((await bridge.stat('/wk/big.bin')).size, big.length + 4);
  assert.equal(dec.decode(await bridge.readRange('/wk/big.bin', big.length, 4)), 'tail');
  await bridge.close(app.id);
}

// ── handles: ESTALE is per-path, not global ──
{
  const { bridge } = makeBridge();
  await bridge.writeFile('/x/file.txt', 'x');
  await bridge.writeFile('/y/file.txt', 'y');

  const handle = await bridge.open('/x/file.txt', { read: true, write: true });
  // Unrelated mutations must not stale this handle (the old global
  // revision check failed exactly this case).
  await bridge.writeFile('/y/file.txt', 'changed');
  await bridge.unlink('/y/file.txt');
  await bridge.write(handle.id, 0, enc.encode('X'));
  assert.equal(dec.decode(await bridge.readFile('/x/file.txt')), 'X');

  // A same-path external mutation between writes DOES stale the handle.
  await bridge.writeFile('/x/file.txt', 'external');
  await assert.rejects(bridge.write(handle.id, 0, enc.encode('!')), /ESTALE/);
  await bridge.close(handle.id);

  // open with truncate resets content via the boundary-chunk path.
  const tr = await bridge.open('/x/file.txt', { write: true, truncate: true });
  assert.equal((await bridge.stat('/x/file.txt')).size, 0);
  await bridge.close(tr.id);
}

// ── append receipts: atomic publication, rehydration, ACK, and hard cap ──
{
  const { harness, rawVfs, vfs } = makeBridge();
  const pid = 1_000_001;
  const writer = '11111111-1111-4111-8111-111111111111';
  rawVfs.activateAppendWriter(pid, writer);
  vfs.mkdir('/append', { recursive: true });
  vfs.writeFile('/append/log.txt', enc.encode('base'));
  harness.setFaultInjector((statement) => (
    /INSERT INTO vfs_append_receipts/i.test(statement.sql)
      ? new Error('injected receipt insert failure')
      : null
  ));
  assert.throws(
    () => vfs.appendOnce(
      '/append/log.txt',
      pid,
      writer,
      APPEND_MODULE,
      1,
      'digest-A',
      enc.encode('A'),
    ),
    /injected receipt insert failure/,
  );
  harness.clearFault();
  assert.equal(dec.decode(vfs.readFile('/append/log.txt')), 'base');
  assert.equal(
    [...harness.sql.exec('SELECT COUNT(*) AS count FROM vfs_append_receipts')][0].count,
    0,
    'the file mutation rolls back when its receipt cannot commit',
  );
  const missingPid = 1_000_002;
  const missingWriter = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  rawVfs.activateAppendWriter(missingPid, missingWriter);
  assert.throws(
    () => vfs.appendOnce(
      '/missing/child.txt',
      missingPid,
      missingWriter,
      APPEND_MODULE,
      1,
      'digest-missing',
      enc.encode('x'),
    ),
    /ENOENT/,
  );
  assert.equal(vfs.exists('/missing'), false, 'append never creates parents outside its receipt transaction');

  harness.failAfterTransaction({
    transaction: harness.transactionCount + 1,
    error: new Error('injected reset after append commit'),
  });
  assert.throws(
    () => vfs.appendOnce(
      '/append/log.txt',
      pid,
      writer,
      APPEND_MODULE,
      1,
      'digest-B',
      enc.encode('B'),
    ),
    /injected reset after append commit/,
  );

  const reloadedRaw = new SqliteVFS(harness.sql, harness.ctx);
  const reloaded = reloadedRaw.as(CRED_KERNEL);
  assert.equal(dec.decode(reloaded.readFile('/append/log.txt')), 'baseB');
  assert.equal(
    reloaded.appendOnce(
      '/append/log.txt',
      pid,
      writer,
      APPEND_MODULE,
      1,
      'digest-B',
      enc.encode('B'),
    ),
    1,
    'the receipt survives VFS reconstruction and deduplicates the lost response',
  );
  assert.equal(dec.decode(reloaded.readFile('/append/log.txt')), 'baseB');

  reloaded.writeFile('/append/log.txt', enc.encode('externally-replaced-with-B'));
  reloaded.appendOnce(
    '/append/log.txt',
    pid,
    writer,
    APPEND_MODULE,
    1,
    'digest-B',
    enc.encode('B'),
  );
  assert.equal(
    dec.decode(reloaded.readFile('/append/log.txt')),
    'externally-replaced-with-B',
    'a completed receipt wins without byte-pattern inference after external drift',
  );
  assert.throws(
    () => reloaded.appendOnce(
      '/append/log.txt',
      pid,
      writer,
      APPEND_MODULE,
      1,
      'digest-C',
      enc.encode('C'),
    ),
    /append receipt collision/,
  );

  reloaded.acknowledgeAppend(
    pid,
    writer,
    APPEND_MODULE,
    1,
  );
  assert.equal(
    [...harness.sql.exec('SELECT COUNT(*) AS count FROM vfs_append_receipts')][0].count,
    0,
    'only explicit client acknowledgement removes a completed receipt',
  );

  reloaded.unlink('/append/log.txt');
  reloaded.rmdir('/append');
  reloaded.appendOnce('/append/log.txt', pid, writer, APPEND_MODULE, 1, 'digest-B', enc.encode('B'));
  assert.equal(reloaded.exists('/append'), false, 'ACK replay bypasses missing-parent resolution');

  reloaded.mkdir('/targets', { recursive: true });
  reloaded.writeFile('/targets/one', enc.encode('one'));
  reloaded.writeFile('/targets/two', enc.encode('two'));
  reloaded.symlink('/targets/one', '/link');
  reloaded.appendOnce('/link', pid, writer, APPEND_MODULE, 2, 'digest-link', enc.encode('!'));
  reloaded.unlink('/link');
  reloaded.symlink('/targets/two', '/link');
  const lock = rawVfs.acquireExclusiveMutation('/targets');
  reloaded.appendOnce('/link', pid, writer, APPEND_MODULE, 2, 'digest-link', enc.encode('!'));
  rawVfs.releaseExclusiveMutation(lock.owner);
  assert.equal(dec.decode(reloaded.readFile('/targets/one')), 'one!');
  assert.equal(dec.decode(reloaded.readFile('/targets/two')), 'two');
  reloaded.acknowledgeAppend(pid, writer, APPEND_MODULE, 2);

  const concurrentWriter = '55555555-5555-4555-8555-555555555555';
  assert.throws(
    () => reloadedRaw.activateAppendWriter(pid, concurrentWriter),
    /ESTALE/,
    'a concurrent host cannot replace the current writer before it retires',
  );
  rawVfs.revokeAppendWriter(pid, writer);
  reloadedRaw.activateAppendWriter(pid, concurrentWriter);
  reloaded.appendOnce('/targets/two', pid, concurrentWriter, APPEND_MODULE, 2, 'digest-gap-2', enc.encode('2'));
  reloaded.appendOnce('/targets/one', pid, concurrentWriter, APPEND_MODULE, 1, 'digest-gap-1', enc.encode('1'));
  reloaded.acknowledgeAppend(pid, concurrentWriter, APPEND_MODULE, 2);
  reloaded.appendOnce('/targets/two', pid, concurrentWriter, APPEND_MODULE, 2, 'digest-gap-2', enc.encode('2'));
  reloaded.acknowledgeAppend(pid, concurrentWriter, APPEND_MODULE, 1);
  assert.equal(
    [...harness.sql.exec(
      `SELECT acked_through FROM vfs_append_module_state
       WHERE pid = ? AND writer_id = ? AND module_id = ?`,
      pid,
      concurrentWriter,
      APPEND_MODULE,
    )][0].acked_through,
    2,
    'out-of-order ACK tombstones compact only after the contiguous gap closes',
  );
  assert.equal(
    [...harness.sql.exec(
      'SELECT COUNT(*) AS count FROM vfs_append_acked_gaps WHERE pid = ? AND writer_id = ?',
      pid,
      concurrentWriter,
    )][0].count,
    0,
  );

  const respawnWriter = '22222222-2222-4222-8222-222222222222';
  reloadedRaw.revokeAppendWriter(pid, concurrentWriter);
  reloadedRaw.activateAppendWriter(pid, respawnWriter);
  reloaded.appendOnce('/targets/two', pid, respawnWriter, APPEND_MODULE, 1, 'digest-new-host', enc.encode('?'));
  assert.equal(
    dec.decode(reloaded.readFile('/targets/two')),
    'two2?',
    'a fresh host incarnation may restart its local operation sequence at one',
  );
  assert.throws(
    () => reloaded.acknowledgeAppend(
      pid,
      '33333333-3333-4333-8333-333333333333',
      APPEND_MODULE,
      1,
    ),
    /ESTALE/,
    'a foreign host incarnation cannot acknowledge another writer receipt',
  );
  assert.throws(
    () => reloaded.appendOnce(
      '/targets/two',
      pid,
      writer,
      APPEND_MODULE,
      2,
      'digest-link',
      enc.encode('!'),
    ),
    /ESTALE/,
    'a retired old host cannot replay an uncertain operation',
  );
  reloaded.appendOnce(
    '/targets/two',
    pid,
    respawnWriter,
    APPEND_MODULE,
    1,
    'digest-new-host',
    enc.encode('?'),
  );
  rawVfs.revokeAppendWriters(pid);
  assert.throws(
    () => reloaded.appendOnce(
      '/targets/two',
      pid,
      respawnWriter,
      APPEND_MODULE,
      1,
      'digest-new-host',
      enc.encode('?'),
    ),
    /ESTALE/,
    'a confirmed-dead host is fail-closed even for delayed old-operation replay',
  );

}

// Writer state, completed receipts, and out-of-order ACK tombstones share one
// fail-closed metadata budget. An ACK frees capacity without weakening replay.
{
  const { harness, rawVfs, vfs } = makeBridge();
  const capPid = 2_000_001;
  const capWriter = '44444444-4444-4444-8444-444444444444';
  vfs.mkdir('/targets', { recursive: true });
  vfs.writeFile('/targets/two', enc.encode('two'));
  harness.sql.exec(
    `INSERT INTO vfs_append_writer_state
     (pid, writer_id, revoked, retired_at) VALUES (?, ?, 0, NULL)`,
    capPid,
    capWriter,
  );
  harness.sql.exec(
    `INSERT INTO vfs_append_module_state
     (pid, writer_id, module_id, acked_through) VALUES (?, ?, ?, 0)`,
    capPid,
    capWriter,
    APPEND_MODULE,
  );
  for (let i = 0; i < VFS_APPEND_RECEIPT_LIMIT - 2; i++) {
    harness.sql.exec(
      `INSERT INTO vfs_append_receipts
       (pid, writer_id, module_id, operation_id, path, byte_length, digest, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      capPid,
      capWriter,
      APPEND_MODULE,
      i + 1,
      '/targets/two',
      `digest-${i}`,
      i,
    );
  }
  const beforeCapFailure = dec.decode(vfs.readFile('/targets/two'));
  assert.throws(
    () => vfs.appendOnce(
      '/targets/two',
      capPid,
      capWriter,
      APPEND_MODULE,
      VFS_APPEND_RECEIPT_LIMIT - 1,
      'digest-cap',
      enc.encode('!'),
    ),
    /ENOSPC/,
  );
  assert.equal(
    dec.decode(vfs.readFile('/targets/two')),
    beforeCapFailure,
    'the full journal rejects before mutating the file',
  );
  const blockedWriter = '66666666-6666-4666-8666-666666666666';
  assert.throws(
    () => rawVfs.activateAppendWriter(capPid + 1, blockedWriter),
    /ENOSPC/,
  );
  assert.equal(
    [...harness.sql.exec(
      'SELECT COUNT(*) AS count FROM vfs_append_writer_state WHERE pid = ? AND writer_id = ?',
      capPid + 1,
      blockedWriter,
    )][0].count,
    0,
    'a new writer cannot consume the final slot needed for its first receipt',
  );
  vfs.acknowledgeAppend(capPid, capWriter, APPEND_MODULE, 1);
  vfs.appendOnce(
    '/targets/two',
    capPid,
    capWriter,
    APPEND_MODULE,
    VFS_APPEND_RECEIPT_LIMIT - 1,
    'digest-cap',
    enc.encode('!'),
  );
  assert.equal(dec.decode(vfs.readFile('/targets/two')), `${beforeCapFailure}!`);
}

// ACK watermark advancement and retirement cleanup split row work at the
// project transaction limit instead of issuing one unbounded DELETE.
{
  const { harness, rawVfs, vfs } = makeBridge();
  const pid = 2_100_001;
  const writer = '88888888-8888-4888-8888-888888888888';
  vfs.mkdir('/append', { recursive: true });
  vfs.writeFile('/append/bounded.txt', 'base');
  harness.sql.exec(
    `INSERT INTO vfs_append_writer_state
     (pid, writer_id, revoked, retired_at) VALUES (?, ?, 0, NULL)`,
    pid,
    writer,
  );
  harness.sql.exec(
    `INSERT INTO vfs_append_module_state
     (pid, writer_id, module_id, acked_through) VALUES (?, ?, ?, 0)`,
    pid,
    writer,
    APPEND_MODULE,
  );
  harness.sql.exec(
    `INSERT INTO vfs_append_receipts
     (pid, writer_id, module_id, operation_id, path, byte_length, digest, created_at)
     VALUES (?, ?, ?, 1, '/append/bounded.txt', 0, 'digest-1', 1)`,
    pid,
    writer,
    APPEND_MODULE,
  );
  for (let operationId = 2; operationId <= MAX_TX_LOGICAL_ROWS + 2; operationId++) {
    harness.sql.exec(
      `INSERT INTO vfs_append_acked_gaps
       (pid, writer_id, module_id, operation_id, path, byte_length, digest)
       VALUES (?, ?, ?, ?, '/append/bounded.txt', 0, ?)`,
      pid,
      writer,
      APPEND_MODULE,
      operationId,
      `digest-${operationId}`,
    );
  }
  const statementStart = harness.statements.length;
  vfs.acknowledgeAppend(pid, writer, APPEND_MODULE, 1);
  const gapDeletes = harness.statements.slice(statementStart).filter(
    (statement) => /DELETE FROM vfs_append_acked_gaps WHERE rowid IN/i.test(statement.sql),
  );
  assert.deepEqual(
    gapDeletes.map((statement) => statement.params.length),
    [MAX_TX_LOGICAL_ROWS, 2],
    '257 pre-existing gaps plus the acknowledged receipt clean up as exact 256/2 row batches',
  );
  assert.equal(
    [...harness.sql.exec(
      `SELECT acked_through FROM vfs_append_module_state
       WHERE pid = ? AND writer_id = ? AND module_id = ?`,
      pid,
      writer,
      APPEND_MODULE,
    )][0].acked_through,
    MAX_TX_LOGICAL_ROWS + 2,
  );
  assert.equal(
    [...harness.sql.exec('SELECT COUNT(*) AS count FROM vfs_append_acked_gaps')][0].count,
    0,
  );

  const cleanupWriter = '99999999-9999-4999-8999-999999999999';
  harness.sql.exec(
    `INSERT INTO vfs_append_writer_state
     (pid, writer_id, revoked, retired_at) VALUES (?, ?, 0, NULL)`,
    pid,
    cleanupWriter,
  );
  harness.sql.exec(
    `INSERT INTO vfs_append_module_state
     (pid, writer_id, module_id, acked_through) VALUES (?, ?, ?, 0)`,
    pid,
    cleanupWriter,
    APPEND_MODULE,
  );
  for (let operationId = 1; operationId <= VFS_APPEND_RECEIPT_LIMIT; operationId++) {
    harness.sql.exec(
      `INSERT INTO vfs_append_receipts
       (pid, writer_id, module_id, operation_id, path, byte_length, digest, created_at)
       VALUES (?, ?, ?, ?, '/append/bounded.txt', 0, ?, ?)`,
      pid,
      cleanupWriter,
      APPEND_MODULE,
      operationId,
      `receipt-${operationId}`,
      operationId,
    );
    harness.sql.exec(
      `INSERT INTO vfs_append_acked_gaps
       (pid, writer_id, module_id, operation_id, path, byte_length, digest)
       VALUES (?, ?, ?, ?, '/append/bounded.txt', 0, ?)`,
      pid,
      cleanupWriter,
      APPEND_MODULE,
      operationId,
      `gap-${operationId}`,
    );
  }
  const cleanupStart = harness.statements.length;
  rawVfs.revokeAppendWriter(pid, cleanupWriter);
  const cleanupDeletes = harness.statements.slice(cleanupStart).filter(
    (statement) => /DELETE FROM vfs_append_(?:receipts|acked_gaps) WHERE rowid IN/i.test(statement.sql),
  );
  assert.equal(cleanupDeletes.length, 16);
  assert.ok(
    cleanupDeletes.every((statement) => statement.params.length === MAX_TX_LOGICAL_ROWS),
    '2048 receipts and gaps are retired only in exact limit-sized transactions',
  );
  assert.equal(
    [...harness.sql.exec(
      `SELECT COUNT(*) AS count FROM vfs_append_receipts
       WHERE pid = ? AND writer_id = ?`,
      pid,
      cleanupWriter,
    )][0].count,
    0,
  );
  assert.equal(
    [...harness.sql.exec(
      `SELECT COUNT(*) AS count FROM vfs_append_acked_gaps
       WHERE pid = ? AND writer_id = ?`,
      pid,
      cleanupWriter,
    )][0].count,
    0,
  );

  const bulkPid = 2_100_002;
  for (let index = 0; index <= MAX_TX_LOGICAL_ROWS; index++) {
    harness.sql.exec(
      `INSERT INTO vfs_append_writer_state
       (pid, writer_id, revoked, retired_at) VALUES (?, ?, 0, NULL)`,
      bulkPid,
      crypto.randomUUID(),
    );
  }
  const bulkStart = harness.statements.length;
  rawVfs.revokeAppendWriters(bulkPid);
  const bulkUpdates = harness.statements.slice(bulkStart).filter(
    (statement) => /UPDATE vfs_append_writer_state\s+SET revoked = 1/i.test(statement.sql),
  );
  assert.deepEqual(
    bulkUpdates.map((statement) => statement.params.length - 2),
    [MAX_TX_LOGICAL_ROWS, 1],
    '257 live writer rows are revoked in exact 256/1 row transactions',
  );
  assert.equal(
    [...harness.sql.exec(
      'SELECT COUNT(*) AS count FROM vfs_append_writer_state WHERE pid = ? AND revoked = 0',
      bulkPid,
    )][0].count,
    0,
  );
}

// Retired authority is represented by absence, not a bounded negative-history
// window: a writer must be explicitly activated before its first append.
{
  const { harness, rawVfs, vfs } = makeBridge();
  const pid = 2_200_001;
  vfs.mkdir('/append', { recursive: true });
  vfs.writeFile('/append/churn.txt', 'base');
  let latestWriter = '';
  let firstWriter = '';
  for (let index = 0; index <= VFS_APPEND_RECEIPT_LIMIT; index++) {
    latestWriter = crypto.randomUUID();
    if (index === 0) firstWriter = latestWriter;
    rawVfs.activateAppendWriter(pid, latestWriter);
    vfs.appendOnce(
      '/append/churn.txt',
      pid,
      latestWriter,
      APPEND_MODULE,
      1,
      `churn-${index}`,
      new Uint8Array(),
    );
    rawVfs.revokeAppendWriter(pid, latestWriter);
  }
  assert.equal(
    [...harness.sql.exec(
      'SELECT COUNT(*) AS count FROM vfs_append_writer_state',
    )][0].count,
    0,
    'disposed writers leave no retained authority or negative-history rows',
  );
  assert.equal(
    [...harness.sql.exec('SELECT COUNT(*) AS count FROM vfs_append_module_state')][0].count,
    0,
  );
  assert.equal(
    [...harness.sql.exec('SELECT COUNT(*) AS count FROM vfs_append_receipts')][0].count,
    0,
  );
  assert.throws(
    () => vfs.appendOnce(
      '/append/churn.txt',
      pid,
      latestWriter,
      APPEND_MODULE,
      1,
      'delayed-old-host',
      new Uint8Array(),
    ),
    /ESTALE/,
    'the most recently disposed writer remains fail-closed',
  );
  const beforeOldestReplay = vfs.stat('/append/churn.txt').size;
  assert.throws(
    () => vfs.appendOnce(
      '/append/churn.txt',
      pid,
      firstWriter,
      APPEND_MODULE,
      1,
      'churn-0',
      enc.encode('x'),
    ),
    /ESTALE/,
    'metadata reclamation never turns an unknown old writer into active authority',
  );
  assert.equal(vfs.stat('/append/churn.txt').size, beforeOldestReplay);
  const nextWriter = crypto.randomUUID();
  rawVfs.activateAppendWriter(pid, nextWriter);
  assert.equal(
    vfs.appendOnce(
      '/append/churn.txt',
      pid,
      nextWriter,
      APPEND_MODULE,
      1,
      'after-churn',
      new Uint8Array(),
    ),
    0,
    'normal churn beyond the cap never permanently blocks a fresh writer',
  );
}

// Final PID retirement remains non-resurrectable after arbitrary global churn:
// an old capability cannot self-activate after its positive authority is gone.
{
  const { rawVfs, vfs } = makeBridge();
  const retiredPid = 2_250_001;
  const retiredWriter = crypto.randomUUID();
  vfs.mkdir('/append', { recursive: true });
  vfs.writeFile('/append/pid-retired.txt', 'base');
  rawVfs.activateAppendWriter(retiredPid, retiredWriter);
  vfs.appendOnce(
    '/append/pid-retired.txt',
    retiredPid,
    retiredWriter,
    APPEND_MODULE,
    1,
    'pid-retired',
    new Uint8Array(),
  );
  rawVfs.revokeAppendWriters(retiredPid);
  for (let index = 0; index <= VFS_APPEND_RECEIPT_LIMIT; index++) {
    const churnPid = 2_260_000 + index;
    const churnWriter = crypto.randomUUID();
    rawVfs.activateAppendWriter(churnPid, churnWriter);
    vfs.appendOnce(
      '/append/pid-retired.txt',
      churnPid,
      churnWriter,
      APPEND_MODULE,
      1,
      `pid-churn-${index}`,
      new Uint8Array(),
    );
    rawVfs.revokeAppendWriter(churnPid, churnWriter);
  }
  const beforeReplay = vfs.stat('/append/pid-retired.txt').size;
  assert.throws(
    () => vfs.appendOnce(
      '/append/pid-retired.txt',
      retiredPid,
      retiredWriter,
      APPEND_MODULE,
      1,
      'pid-retired',
      enc.encode('x'),
    ),
    /ESTALE/,
    'a final PID retirement cannot be resurrected by an old capability',
  );
  assert.equal(vfs.stat('/append/pid-retired.txt').size, beforeReplay);
}

// Revocation intent and its fail-closed marker survive a reset between the
// bounded transactions; reconstruction resumes cleanup before admitting work.
{
  const { harness, rawVfs, vfs } = makeBridge();
  const pid = 2_300_001;
  const writer = 'abababab-abab-4bab-8bab-abababababab';
  vfs.mkdir('/append', { recursive: true });
  vfs.writeFile('/append/reset-cleanup.txt', 'base');
  rawVfs.activateAppendWriter(pid, writer);
  vfs.appendOnce(
    '/append/reset-cleanup.txt',
    pid,
    writer,
    APPEND_MODULE,
    1,
    'reset-cleanup',
    new Uint8Array(),
  );
  harness.setFaultInjector((statement) => (
    /SELECT rowid FROM vfs_append_receipts/i.test(statement.sql)
      ? new Error('injected reset during writer cleanup')
      : null
  ));
  assert.throws(
    () => rawVfs.revokeAppendWriter(pid, writer),
    /injected reset during writer cleanup/,
  );
  harness.clearFault();
  const reloadedRaw = new SqliteVFS(harness.sql, harness.ctx);
  const reloaded = reloadedRaw.as(CRED_KERNEL);
  assert.equal(
    [...harness.sql.exec(
      'SELECT COUNT(*) AS count FROM vfs_append_receipts WHERE pid = ? AND writer_id = ?',
      pid,
      writer,
    )][0].count,
    0,
  );
  assert.throws(
    () => reloaded.appendOnce(
      '/append/reset-cleanup.txt',
      pid,
      writer,
      APPEND_MODULE,
      1,
      'reset-cleanup',
      new Uint8Array(),
    ),
    /ESTALE/,
  );

  const bulkPid = 2_300_002;
  const bulkWriter = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
  harness.sql.exec(
    `INSERT INTO vfs_append_writer_state
     (pid, writer_id, revoked, retired_at) VALUES (?, ?, 0, NULL)`,
    bulkPid,
    bulkWriter,
  );
  harness.setFaultInjector((statement) => (
    /UPDATE vfs_append_writer_state\s+SET revoked = 1/i.test(statement.sql)
      ? new Error('injected reset after pid revocation intent')
      : null
  ));
  assert.throws(
    () => reloadedRaw.revokeAppendWriters(bulkPid),
    /injected reset after pid revocation intent/,
  );
  harness.clearFault();
  const resumedRaw = new SqliteVFS(harness.sql, harness.ctx);
  assert.equal(
    [...harness.sql.exec(
      `SELECT COUNT(*) AS count FROM vfs_append_writer_state
       WHERE pid = ? AND writer_id = ?`,
      bulkPid,
      bulkWriter,
    )][0].count,
    0,
    'reconstruction finishes cleanup and removes the retired positive authority',
  );
  assert.equal(
    [...harness.sql.exec(
      'SELECT COUNT(*) AS count FROM vfs_append_pid_revocations WHERE pid = ?',
      bulkPid,
    )][0].count,
    0,
  );
  assert.throws(
    () => resumedRaw.as(CRED_KERNEL).appendOnce(
      '/append/reset-cleanup.txt',
      bulkPid,
      bulkWriter,
      APPEND_MODULE,
      1,
      'bulk-reset',
      new Uint8Array(),
    ),
    /ESTALE/,
  );
}

// Restart maintenance pages durable PID-revocation intents instead of
// materializing an unbounded table before cleanup begins.
{
  const { harness } = makeBridge();
  for (let index = 0; index <= MAX_TX_LOGICAL_ROWS; index++) {
    harness.sql.exec(
      `INSERT INTO vfs_append_pid_revocations (pid, retired_at)
       VALUES (?, ?)`,
      2_400_000 + index,
      index,
    );
  }
  const restartStart = harness.statements.length;
  new SqliteVFS(harness.sql, harness.ctx);
  const restartStatements = harness.statements.slice(restartStart);
  const pageSelects = restartStatements.filter(
    (statement) => /SELECT pid FROM vfs_append_pid_revocations[\s\S]*LIMIT \?/i.test(statement.sql),
  );
  assert.deepEqual(
    pageSelects.map((statement) => statement.params),
    [[MAX_TX_LOGICAL_ROWS], [MAX_TX_LOGICAL_ROWS], [MAX_TX_LOGICAL_ROWS]],
    '257 restart markers are selected in 256/1/0 bounded pages',
  );
  const markerDeletes = restartStatements.filter(
    (statement) => /DELETE FROM vfs_append_pid_revocations WHERE pid = \?/i.test(statement.sql),
  );
  assert.equal(markerDeletes.length, MAX_TX_LOGICAL_ROWS + 1);
  assert.ok(
    markerDeletes.every(
      (statement) => statement.transaction !== null && statement.params.length === 1,
    ),
    'each marker is retired in a bounded transaction',
  );
  assert.equal(
    [...harness.sql.exec(
      'SELECT COUNT(*) AS count FROM vfs_append_pid_revocations',
    )][0].count,
    0,
  );
}

// A new coordinator generation retires every prior-generation positive
// authority while preserving writers allocated above its PID base.
{
  const { rawVfs, vfs } = makeBridge();
  const oldPid = 3_000_001;
  const currentPid = 4_000_001;
  const oldWriter = crypto.randomUUID();
  const currentWriter = crypto.randomUUID();
  vfs.mkdir('/append', { recursive: true });
  vfs.writeFile('/append/generation.txt', 'base');
  rawVfs.activateAppendWriter(oldPid, oldWriter);
  rawVfs.activateAppendWriter(currentPid, currentWriter);
  rawVfs.revokeAppendWritersThrough(4_000_000);
  assert.throws(
    () => vfs.appendOnce(
      '/append/generation.txt',
      oldPid,
      oldWriter,
      APPEND_MODULE,
      1,
      'prior-generation',
      enc.encode('x'),
    ),
    /ESTALE/,
  );
  assert.equal(
    vfs.appendOnce(
      '/append/generation.txt',
      currentPid,
      currentWriter,
      APPEND_MODULE,
      1,
      'current-generation',
      enc.encode('y'),
    ),
    1,
  );
  assert.equal(dec.decode(vfs.readFile('/append/generation.txt')), 'basey');
}

// The receipt-to-gap transition and contiguous watermark advance share the
// same bounded transaction. A lost response cannot leave an acknowledged key
// dependent on a client ACK that will never be retried.
{
  const { harness, rawVfs, vfs } = makeBridge();
  const pid = 2_400_001;
  const writer = 'efefefef-efef-4fef-8fef-efefefefefef';
  vfs.mkdir('/append', { recursive: true });
  vfs.writeFile('/append/ack-reset.txt', 'base');
  rawVfs.activateAppendWriter(pid, writer);
  vfs.appendOnce(
    '/append/ack-reset.txt',
    pid,
    writer,
    APPEND_MODULE,
    1,
    'ack-reset',
    new Uint8Array(),
  );
  harness.failAfterTransaction({
    transaction: harness.transactionCount + 1,
    error: new Error('injected reset after atomic ACK'),
  });
  assert.throws(
    () => vfs.acknowledgeAppend(pid, writer, APPEND_MODULE, 1),
    /injected reset after atomic ACK/,
  );
  const reloadedRaw = new SqliteVFS(harness.sql, harness.ctx);
  const reloaded = reloadedRaw.as(CRED_KERNEL);
  assert.equal(
    [...harness.sql.exec(
      `SELECT acked_through FROM vfs_append_module_state
       WHERE pid = ? AND writer_id = ? AND module_id = ?`,
      pid,
      writer,
      APPEND_MODULE,
    )][0].acked_through,
    1,
  );
  assert.equal(
    [...harness.sql.exec('SELECT COUNT(*) AS count FROM vfs_append_acked_gaps')][0].count,
    0,
  );
  assert.equal(
    reloaded.appendOnce(
      '/append/ack-reset.txt',
      pid,
      writer,
      APPEND_MODULE,
      1,
      'ack-reset',
      new Uint8Array(),
    ),
    0,
  );
}

// Oversized appends may stage chunks, but publication and receipt insertion
// still share one final transaction.
{
  const { harness, rawVfs, vfs } = makeBridge();
  vfs.mkdir('/append', { recursive: true });
  vfs.writeFile('/append/large.bin', enc.encode('base'));
  rawVfs.activateAppendWriter(
    3_000_001,
    '33333333-3333-4333-8333-333333333333',
  );
  const large = new Uint8Array(MAX_TX_BLOB_BYTES + 1).fill(7);
  harness.setFaultInjector((statement) => (
    /INSERT INTO vfs_append_receipts/i.test(statement.sql)
      ? new Error('injected staged receipt failure')
      : null
  ));
  assert.throws(
    () => vfs.appendOnce(
      '/append/large.bin',
      3_000_001,
      '33333333-3333-4333-8333-333333333333',
      APPEND_MODULE,
      1,
      'digest-large',
      large,
    ),
    /injected staged receipt failure/,
  );
  harness.clearFault();
  assert.equal(dec.decode(vfs.readFile('/append/large.bin')), 'base');
  assert.equal(
    [...harness.sql.exec('SELECT COUNT(*) AS count FROM vfs_append_receipts')][0].count,
    0,
  );
  vfs.appendOnce(
    '/append/large.bin',
    3_000_001,
    '33333333-3333-4333-8333-333333333333',
    APPEND_MODULE,
    1,
    'digest-large',
    large,
  );
  assert.equal(vfs.stat('/append/large.bin').size, 4 + large.byteLength);
}

// ── symlinks: native inode durability, metadata, and resolution ──
{
  const { harness, vfs, bridge } = makeBridge();
  await bridge.writeFile('/real/target.txt', 'abcdefgh');
  await bridge.symlink('/real/target.txt', '/links/alias.txt');

  assert.equal(vfs.isSymlink('links/alias.txt'), true, 'new links must be native VFS inodes');
  assert.equal(vfs.readlink('links/alias.txt'), '/real/target.txt');
  assert.equal(await bridge.readlink('/links/alias.txt'), '/real/target.txt');
  const linkStat = await bridge.stat('/links/alias.txt', { followSymlinks: false });
  assert.equal(linkStat.type, 'symlink');
  assert.equal(linkStat.mode, 0o120777, 'lstat mode must include the symlink inode type');
  assert.equal(linkStat.size, enc.encode('/real/target.txt').byteLength);
  assert.equal((await bridge.stat('/links/alias.txt')).type, 'file');
  assert.deepEqual(
    await bridge.readdir('/links'),
    [{ name: 'alias.txt', type: 'symlink' }],
    'native symlinks must appear exactly once with their real directory-entry type',
  );
  assert.equal(dec.decode(await bridge.readRange('/links/alias.txt', 2, 3)), 'cde');
  await bridge.writeRange('/links/alias.txt', 0, enc.encode('AB'));
  assert.equal(dec.decode(await bridge.readFile('/real/target.txt')), 'ABcdefgh');
  await bridge.truncate('/links/alias.txt', 4);
  assert.equal(dec.decode(await bridge.readFile('/real/target.txt')), 'ABcd');
  // revision(link) follows the link target's data path.
  assert.equal(await bridge.revision('/links/alias.txt'), await bridge.revision('/real/target.txt'));

  const reloadedRawVfs = new SqliteVFS(harness.sql, harness.ctx);
  const reloadedVfs = reloadedRawVfs.as(CRED_KERNEL);
  const reloadedBridge = new SqliteRuntimeFsBridge(reloadedVfs, reloadedRawVfs);
  assert.equal(reloadedVfs.isSymlink('links/alias.txt'), true, 'symlink kind must survive VFS reload');
  assert.equal(await reloadedBridge.readlink('/links/alias.txt'), '/real/target.txt');
  assert.equal(
    (await reloadedBridge.stat('/links/alias.txt', { followSymlinks: false })).mode,
    0o120777,
    'the symlink mode must survive VFS reload',
  );
  assert.equal(dec.decode(await reloadedBridge.readFile('/links/alias.txt')), 'ABcd');
  await reloadedBridge.rename('/links/alias.txt', '/links/renamed.txt');
  assert.equal(reloadedVfs.isSymlink('links/alias.txt'), false);
  assert.equal(reloadedVfs.isSymlink('links/renamed.txt'), true);
  assert.equal(await reloadedBridge.readlink('/links/renamed.txt'), '/real/target.txt');
  await reloadedBridge.unlink('/links/renamed.txt');
  assert.equal(reloadedVfs.exists('links/renamed.txt'), false);
}

// ── symlinks: intermediate components, loops, and legacy read fallback ──
{
  const { rawVfs, vfs, bridge } = makeBridge();
  await bridge.writeFile('/real/dir/file.txt', 'through-directory-link');
  await bridge.symlink('../real/dir', '/links/dir');
  assert.equal(
    dec.decode(await bridge.readFile('/links/dir/file.txt')),
    'through-directory-link',
    'resolution must follow symlinks in intermediate path components',
  );
  assert.deepEqual(await bridge.readdir('/links/dir'), [{ name: 'file.txt', type: 'file' }]);

  await bridge.symlink('../missing-target', '/links/dangling');
  assert.equal(await bridge.readlink('/links/dangling'), '../missing-target');
  assert.equal(await bridge.stat('/links/dangling'), null, 'stat follows a dangling symlink');
  assert.equal((await bridge.stat('/links/dangling', { followSymlinks: false })).type, 'symlink');

  await bridge.symlink('two', '/loop/one');
  await bridge.symlink('one', '/loop/two');
  assert.equal(await bridge.stat('/loop/one'), null, 'symlink loops must not resolve to arbitrary data');
  assert.equal(await bridge.readFile('/loop/one'), null);

  getSymlinkRegistry(rawVfs).set('/legacy/link.txt', '/real/dir/file.txt');
  assert.equal(
    dec.decode(await bridge.readFile('/legacy/link.txt')),
    'through-directory-link',
    'pre-native registry entries remain readable during compatibility migration',
  );
  assert.equal((await bridge.stat('/legacy/link.txt', { followSymlinks: false })).mode, 0o120777);

  getSymlinkRegistry(rawVfs).set('/legacy/shadowed.txt', '/real/dir/file.txt');
  vfs.mkdir('legacy', { recursive: true });
  vfs.writeFile('legacy/shadowed.txt', 'native-wins');
  assert.equal(
    dec.decode(await bridge.readFile('/legacy/shadowed.txt')),
    'native-wins',
    'native inodes take precedence over stale legacy registry entries',
  );

  const registry = getSymlinkRegistry(rawVfs);
  registry.set('/legacy/destination-link', '/real/dir/file.txt');
  await assert.rejects(
    bridge.rename('/legacy/missing-source', '/legacy/destination-link'),
    /ENOENT/,
  );
  assert.equal(registry.readlink('/legacy/destination-link'), '/real/dir/file.txt');

  registry.set('/legacy/source-link', '/real/dir/file.txt');
  vfs.writeFile('legacy/native-destination', 'replace-me');
  await bridge.rename('/legacy/source-link', '/legacy/native-destination');
  assert.equal(vfs.lstat('legacy/native-destination').type, 'symlink');
  assert.equal(vfs.readlink('legacy/native-destination'), '/real/dir/file.txt');
  assert.equal(registry.readlink('/legacy/source-link'), null);

  vfs.writeFile('legacy/native-source', 'replacement');
  registry.set('/legacy/shadowed-destination', '/real/dir/file.txt');
  vfs.writeFile('legacy/shadowed-destination', 'old-native');
  await bridge.rename('/legacy/native-source', '/legacy/shadowed-destination');
  assert.equal(vfs.readFileString('legacy/shadowed-destination'), 'replacement');
  assert.equal(registry.readlink('/legacy/shadowed-destination'), null);
}

console.log('runtime-fs-bridge-range: all assertions passed');
