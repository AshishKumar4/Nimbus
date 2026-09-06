#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { CHUNK_SIZE, MAX_TX_BLOB_BYTES } from '../../packages/platform/src/limits.ts';
import { encodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

function open() {
  const harness = createSqliteVfsTestHarness();
  const raw = new SqliteVFS(harness.sql, harness.ctx);
  return { harness, raw, vfs: raw.as(CRED_KERNEL) };
}

function batch(path, bytes) {
  return {
    inodes: [{ path, parentPath: '', isDir: false, size: bytes.length,
      mtime: 123, mode: 0o644, chunkCount: Math.ceil(bytes.length / CHUNK_SIZE) }],
    chunks: Array.from({ length: Math.ceil(bytes.length / CHUNK_SIZE) }, (_, chunkId) => ({
      path, chunkId, data: bytes.subarray(chunkId * CHUNK_SIZE, (chunkId + 1) * CHUNK_SIZE),
    })),
  };
}

function tree(vfs, path = '') {
  return vfs.readdir(path).flatMap((entry) => {
    const child = path ? `${path}/${entry.name}` : entry.name;
    const stat = vfs.lstat(child);
    const bytes = entry.type === 'file' ? vfs.readFile(child)
      : entry.type === 'symlink' ? vfs.readlink(child) : null;
    return [[child, stat, bytes], ...(entry.type === 'directory' ? tree(vfs, child) : [])];
  });
}

// Independent statement failures: no embedder transaction is involved.
for (const [name, mutate] of [
  ['utimes', (vfs) => vfs.utimes('affected', 11, 22)],
  ['chmod', (vfs) => vfs.chmod('affected', 0o700)],
  ['chown', (vfs) => vfs.chown('affected', 42, 43)],
]) {
  const { harness, raw, vfs } = open();
  vfs.writeFile('affected', 'before rollback');
  const before = tree(vfs);
  const revision = vfs.revision();
  const events = [];
  raw.events.onPath('affected', (event) => events.push(event));
  harness.failOnStatement(1);
  assert.throws(() => mutate(vfs), /injected SQL fault/);
  assert.deepEqual(tree(vfs), before, `${name}: failed SQL must not publish metadata`);
  assert.equal(vfs.revision(), revision);
  assert.deepEqual(events, []);
  harness.db.close();
}
console.log('sqlite-vfs-transaction-coherence: standalone metadata rollback passed');

// Original Kinu failure: a replacement publishes, then the host's index write
// fails. The next demand read must use the rolled-back generation, not EIO.
{
  const { harness, raw, vfs } = open();
  const before = new TextEncoder().encode('before rollback');
  vfs.writeFile('affected', before);
  harness.sql.exec('CREATE TABLE host_index (value TEXT)');
  const fault = new Error('injected host index write failure');
  assert.throws(() => raw.withTransaction(() => {
    vfs.writeFile('affected', 'uncommitted replacement');
    harness.failOnStatement(1, fault);
    harness.sql.exec('INSERT INTO host_index VALUES (?)', 'failed index');
  }), (error) => error.cause === fault);
  assert.deepEqual(harness.sql.exec('SELECT value FROM host_index'), []);
  assert.deepEqual(vfs.readFile('affected'), before);
  harness.db.close();
}
console.log('sqlite-vfs-transaction-coherence: outer rollback read preserved pre-write bytes (no EIO)');

// Every synchronous mutator that publishes inodes/content is exercised under
// an outer rollback. Reading inside warms the LRU with uncommitted bytes.
const replacement = new Uint8Array(CHUNK_SIZE + 7).fill(17);
for (const [name, mutate] of [
  ['mkdir', (vfs) => vfs.mkdir('new/child', { recursive: true })],
  ['mkdirBatch', (vfs) => vfs.mkdirBatch(['new/child', 'new/sibling'])],
  ['writeFile', (vfs) => vfs.writeFile('affected', replacement)],
  ['writeFile staged', (vfs) => vfs.writeFile('affected', new Uint8Array(MAX_TX_BLOB_BYTES + 1).fill(21))],
  ['writeRange', (vfs) => vfs.writeRange('affected', 3, replacement)],
  ['writeRange staged', (vfs) => vfs.writeRange('affected', 3, new Uint8Array(MAX_TX_BLOB_BYTES + 1).fill(22))],
  ['truncate', (vfs) => vfs.truncate('affected', 2)],
  ['truncate staged', (vfs) => vfs.truncate('affected', MAX_TX_BLOB_BYTES + CHUNK_SIZE)],
  ['appendOnce', (vfs) => vfs.appendOnce('affected', 1, '12345678-1234-4234-9234-123456789012', '12345678-1234-4234-9234-123456789013', 1, 'digest', replacement)],
  ['utimes', (vfs) => vfs.utimes('affected', 11, 22)],
  ['chmod', (vfs) => vfs.chmod('affected', 0o700)],
  ['chown', (vfs) => vfs.chown('affected', 42, 43)],
  ['chown symlink', (vfs) => vfs.chown('link', 42, 43, { followSymlinks: false })],
  ['symlink', (vfs) => vfs.symlink('affected', 'new-link')],
  ['copyFile', (vfs) => vfs.copyFile('affected', 'copied')],
  ['unlink', (vfs) => vfs.unlink('affected')],
  ['rmdir', (vfs) => vfs.rmdir('empty')],
  ['removeRecursive', (vfs) => vfs.removeRecursive('dir')],
  ['rename', (vfs) => vfs.rename('dir', 'renamed')],
  ['rename overwrite', (vfs) => vfs.rename('dir/child', 'affected')],
  ['writeBatch', (vfs) => vfs.writeBatch({ ...batch('affected', replacement), deletePaths: ['dir'] })],
]) {
  const { harness, raw, vfs } = open();
  vfs.mkdir('dir');
  vfs.mkdir('empty');
  vfs.writeFile('affected', 'original bytes');
  vfs.writeFile('dir/child', 'child bytes');
  vfs.symlink('affected', 'link');
  raw.activateAppendWriter(1, '12345678-1234-4234-9234-123456789012');
  const before = tree(vfs);
  const revision = vfs.revision();
  const events = [];
  raw.events.on((batch) => events.push(...batch));
  await Promise.resolve(); // Discard fixture setup events, not mutation events.
  events.length = 0;
  const fault = new Error(`rollback ${name}`);
  assert.throws(() => raw.withTransaction(() => {
    mutate(vfs);
    tree(vfs); // Exercise read-your-writes and cache population.
    assert.equal(vfs.revision(), revision, `${name}: revision waits for commit`);
    throw fault;
  }), (error) => error.cause === fault);
  await Promise.resolve();
  assert.deepEqual(tree(vfs), before, `${name}: rollback restores the entire readable tree`);
  assert.equal(vfs.revision(), revision, `${name}: rollback publishes no revision`);
  assert.deepEqual(events, [], `${name}: rollback publishes no watch events`);
  assert.deepEqual(tree(new SqliteVFS(harness.sql, harness.ctx).as(CRED_KERNEL)), before);
  assert.deepEqual(harness.sql.exec('SELECT operation_id FROM vfs_append_receipts'), []);
  assert.equal(raw._verifyCounters(), null);
  harness.db.close();
}

// Success: read-your-writes, callback result, host rows and observer state all
// become committed together. An observer must not see a partially built tree.
{
  const { harness, raw, vfs } = open();
  harness.sql.exec('CREATE TABLE host_index (path TEXT)');
  const events = [];
  raw.events.onPath('new', (event) => {
    events.push([event.type, vfs.readFileString('new/file'), harness.db.inTransaction]);
  });
  const revision = vfs.revision();
  assert.equal(raw.withTransaction(() => {
    vfs.mkdir('new');
    vfs.writeFile('new/file', 'committed');
    assert.equal(vfs.readFileString('new/file'), 'committed');
    assert.deepEqual(events, []);
    harness.sql.exec('INSERT INTO host_index VALUES (?)', 'new/file');
    return 42;
  }), 42);
  assert.deepEqual(events, [['addDir', 'committed', false], ['add', 'committed', false]]);
  assert.equal(vfs.revision(), revision + 1);
  assert.deepEqual(harness.sql.exec('SELECT path FROM host_index'), [{ path: 'new/file' }]);
  assert.equal(new SqliteVFS(harness.sql, harness.ctx).as(CRED_KERNEL).readFileString('new/file'), 'committed');
  harness.db.close();
}

// A real deferred constraint fails at COMMIT, after the entire callback ran.
{
  const { harness, raw, vfs } = open();
  harness.sql.exec('PRAGMA foreign_keys = ON');
  harness.sql.exec('CREATE TABLE host_parent (id INTEGER PRIMARY KEY)');
  harness.sql.exec('CREATE TABLE host_child (id INTEGER REFERENCES host_parent(id) DEFERRABLE INITIALLY DEFERRED)');
  vfs.writeFile('affected', 'before commit failure');
  const revision = vfs.revision();
  assert.throws(() => raw.withTransaction(() => {
    vfs.writeFile('affected', 'not committed');
    assert.equal(vfs.readFileString('affected'), 'not committed');
    harness.sql.exec('INSERT INTO host_child VALUES (1)');
  }), (error) => error.cause instanceof Error && /FOREIGN KEY/.test(error.cause.message));
  assert.equal(vfs.readFileString('affected'), 'before commit failure');
  assert.equal(vfs.revision(), revision);
  assert.deepEqual(harness.sql.exec('SELECT id FROM host_child'), []);
  harness.db.close();
}

// Recovery must preserve both errors, never mask the transaction failure.
{
  const { harness, raw, vfs } = open();
  vfs.writeFile('affected', 'before recovery failure');
  const fault = new Error('host transaction failed');
  const reloadFault = new Error('inode reload failed');
  assert.throws(() => raw.withTransaction(() => {
    vfs.writeFile('affected', 'uncommitted');
    harness.setFaultInjector((statement) => statement.sql.startsWith('SELECT path, parent_path, kind')
      ? reloadFault : null);
    throw fault;
  }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause, fault);
    assert.deepEqual(error.errors, [fault, reloadFault]);
    return true;
  });
  harness.clearFault();
  assert.equal(new SqliteVFS(harness.sql, harness.ctx).as(CRED_KERNEL).readFileString('affected'), 'before recovery failure');
  harness.db.close();
}

// Stream writes cannot participate in a synchronous outer callback. Their
// bounded commit groups already use commit-then-publish: fail inside the
// replacement transaction and read the original generation on the same VFS.
{
  const { harness, raw, vfs } = open();
  vfs.writeFile('affected', 'stream original');
  const revision = vfs.revision();
  harness.setFaultInjector((statement) => statement.sql.startsWith('INSERT OR REPLACE INTO file_chunks')
    ? new Error('injected stream chunk failure') : null);
  const result = await vfs.writeStream(encodeWriteBatchStream(batch('affected', replacement)));
  harness.clearFault();
  assert.equal(result.ok, false);
  assert.equal(vfs.readFileString('affected'), 'stream original');
  assert.equal(vfs.revision(), revision);
  assert.equal(raw._verifyCounters(), null);
  harness.db.close();
}
console.log('sqlite-vfs-transaction-coherence: all assertions passed');
