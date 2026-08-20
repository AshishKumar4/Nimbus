#!/usr/bin/env bun
/**
 * sqlite-vfs-bun-backend — the filesystem on a non-Cloudflare SQL backend.
 *
 * SqliteVFS now depends on the SqlDatabase / TransactionHost ports declared in
 * runtime/os-contracts.ts rather than on workerd's SqlStorage and
 * DurableObjectState. This runs the public filesystem API against bun:sqlite
 * writing to a real file on disk, closes the database, reopens it, and reads
 * everything back — so the proof is behavioural rather than structural.
 *
 * It also pins the two places where the hosts genuinely disagree: bun hands
 * blobs back as Uint8Array where workerd hands back ArrayBuffer, and a bun
 * prepared statement consumes only the first statement of a multi-statement
 * string where workerd's exec runs all of them.
 */

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHUNK_SIZE } from '../../packages/platform/src/limits.ts';
import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const DIR = 'home/user/project/src';
const TEXT_PATH = `${DIR}/README.md`;
const BINARY_PATH = `${DIR}/all-bytes.bin`;
const LARGE_PATH = `${DIR}/large.bin`;
const RENAMED_PATH = `${DIR}/large-renamed.bin`;
const LARGE_SIZE = CHUNK_SIZE * 2 + 1234;

/** Non-repeating across chunk boundaries, so a swapped or truncated chunk shows. */
function pattern(length) {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) bytes[index] = (index * 31 + (index >> 8)) & 0xff;
  return bytes;
}

function mountFilesystem(db) {
  const harness = createSqliteVfsTestHarness(db);
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  return { harness, root: vfs.as(CRED_KERNEL), user: vfs.as(CRED_SESSION_USER) };
}

// ── The port, as the filesystem calls it ────────────────────────────────────
{
  const harness = createSqliteVfsTestHarness(new Database(':memory:'));

  harness.sql.exec('CREATE TABLE one (x); CREATE TABLE two (y)');
  const tables = [...harness.sql.exec(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('one', 'two') ORDER BY name",
  )].map((row) => row.name);
  assert.deepEqual(tables, ['one', 'two'], 'exec runs every statement in a multi-statement string');

  assert.deepEqual(
    [...harness.sql.exec('SELECT ? AS n', 7)],
    [{ n: 7 }],
    'exec returns a spreadable iterable of row objects',
  );

  assert.equal(
    harness.ctx.storage.transactionSync(() => 'callback value'),
    'callback value',
    'transactionSync returns the callback value',
  );

  assert.throws(() => harness.ctx.storage.transactionSync(() => {
    harness.sql.exec('INSERT INTO one (x) VALUES (1)');
    throw new Error('rolled back');
  }), /rolled back/);
  assert.deepEqual(
    [...harness.sql.exec('SELECT count(*) AS rows FROM one')],
    [{ rows: 0 }],
    'a throwing transactionSync leaves no rows behind',
  );
}

// ── The filesystem, on a SQLite file that outlives the connection ───────────
const directory = mkdtempSync(join(tmpdir(), 'nimbus-vfs-bun-'));
const databasePath = join(directory, 'vfs.sqlite');
const large = pattern(LARGE_SIZE);
const allBytes = pattern(256);

try {
  const first = mountFilesystem(new Database(databasePath));

  first.root.mkdir(DIR, { recursive: true, mode: 0o755 });
  first.root.chown(DIR, CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  for (const level of ['home', 'home/user', 'home/user/project', DIR]) {
    assert.equal(first.user.isDirectory(level), true, `mkdir -p created ${level}`);
  }

  first.user.writeFile(TEXT_PATH, '# nimbus\nrunning on bun:sqlite\n');
  assert.equal(
    first.user.readFileString(TEXT_PATH),
    '# nimbus\nrunning on bun:sqlite\n',
    'text round-trips',
  );

  first.user.writeFile(BINARY_PATH, allBytes);
  assert.deepEqual(first.user.readFile(BINARY_PATH), allBytes, 'every byte value round-trips');

  first.user.writeFile(LARGE_PATH, large);
  assert.deepEqual(first.user.readFile(LARGE_PATH), large, 'a multi-chunk file round-trips');
  assert.deepEqual(
    [...first.harness.sql.exec(
      `SELECT count(*) AS chunks FROM file_chunks
       WHERE content_id = (SELECT content_id FROM inodes WHERE path = ?)`,
      LARGE_PATH,
    )],
    [{ chunks: 3 }],
    'the file is stored as 64KiB chunks, so the chunking path ran',
  );
  const [storedChunk] = [...first.harness.sql.exec('SELECT data FROM file_chunks LIMIT 1')];
  assert.ok(
    storedChunk.data instanceof Uint8Array,
    'this host returns blobs as Uint8Array where workerd returns ArrayBuffer',
  );

  const boundary = first.user.readRange(LARGE_PATH, CHUNK_SIZE - 8, 16);
  assert.deepEqual(boundary, large.subarray(CHUNK_SIZE - 8, CHUNK_SIZE + 8), 'readRange spans chunks');
  assert.deepEqual(
    first.user.readRange(LARGE_PATH, CHUNK_SIZE * 2 + 200, 34),
    large.subarray(CHUNK_SIZE * 2 + 200, CHUNK_SIZE * 2 + 234),
    'readRange reads inside the tail chunk',
  );
  assert.deepEqual(
    first.user.readRange(LARGE_PATH, LARGE_SIZE - 4, 64),
    large.subarray(LARGE_SIZE - 4),
    'readRange clamps to the end of the file',
  );

  const stat = first.user.stat(LARGE_PATH);
  assert.equal(stat.type, 'file');
  assert.equal(stat.size, LARGE_SIZE);
  assert.equal(stat.mode & 0o777, 0o644, 'the creation mode survives the umask and the round-trip');
  assert.equal(stat.uid, CRED_SESSION_USER.uid);
  assert.equal(stat.gid, CRED_SESSION_USER.gid);
  assert.ok(stat.mtime > 0, 'mtime is stored');

  assert.deepEqual(
    first.user.readdir(DIR).map((entry) => `${entry.type}:${entry.name}`).sort(),
    ['file:README.md', 'file:all-bytes.bin', 'file:large.bin'],
    'readdir lists what was written',
  );

  first.user.rename(LARGE_PATH, RENAMED_PATH);
  assert.equal(first.user.exists(LARGE_PATH), false, 'rename moves the source away');
  assert.deepEqual(first.user.readFile(RENAMED_PATH), large, 'rename keeps every chunk');

  first.user.unlink(BINARY_PATH);
  assert.equal(first.user.exists(BINARY_PATH), false, 'unlink removes the file');
  assert.throws(() => first.user.readFile(BINARY_PATH), (error) => error.code === 'ENOENT');

  first.harness.db.close();

  // Nothing of the filesystem is left in this process: a new connection to the
  // same file is the only place the state can have come from.
  const second = mountFilesystem(new Database(databasePath));
  assert.equal(second.user.isDirectory(DIR), true, 'the directory tree survived the reopen');
  assert.equal(
    second.user.readFileString(TEXT_PATH),
    '# nimbus\nrunning on bun:sqlite\n',
    'text survived the reopen',
  );
  assert.deepEqual(second.user.readFile(RENAMED_PATH), large, 'the multi-chunk file survived the reopen');
  assert.equal(second.user.exists(BINARY_PATH), false, 'the unlinked file stayed unlinked');
  const { atime: reopenedAtime, ...reopenedStat } = second.user.stat(RENAMED_PATH);
  const { atime: writtenAtime, ...writtenStat } = stat;
  assert.deepEqual(reopenedStat, writtenStat, 'inode metadata survived the reopen');
  assert.ok(reopenedAtime >= writtenAtime, 'reading it again only moved atime forward');
  second.harness.db.close();
} finally {
  rmSync(directory, { recursive: true, force: true });
}

// ── transactionSync is a real transaction ───────────────────────────────────
{
  const database = new Database(':memory:');
  const { harness, user, root } = mountFilesystem(database);
  root.mkdir(DIR, { recursive: true, mode: 0o755 });
  root.chown(DIR, CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);

  const tornPath = `${DIR}/torn.bin`;
  harness.setFaultInjector((statement) => (
    statement.sql.startsWith('INSERT OR REPLACE INTO file_chunks')
      ? new Error('injected chunk write failure')
      : null
  ));
  assert.throws(() => user.writeFile(tornPath, pattern(4096)), /injected chunk write failure/);
  harness.clearFault();

  const executed = harness.statements;
  const failed = executed.at(-1);
  assert.ok(failed.transaction !== null, 'the failing write ran inside a transaction');
  assert.ok(
    executed.some((statement) => (
      statement.transaction === failed.transaction
      && statement.sql.startsWith('INSERT OR REPLACE INTO inodes')
    )),
    'the inode row was written earlier in that same transaction',
  );

  assert.equal(user.exists(tornPath), false, 'the failed write is not visible in memory');
  assert.deepEqual(
    [...harness.sql.exec('SELECT count(*) AS rows FROM inodes WHERE path = ?', tornPath)],
    [{ rows: 0 }],
    'the inode row was rolled back with the chunk that failed',
  );

  const reopened = mountFilesystem(database);
  assert.equal(reopened.user.exists(tornPath), false, 'and it is not durable either');

  user.writeFile(tornPath, pattern(4096));
  assert.deepEqual(user.readFile(tornPath), pattern(4096), 'the rollback left the database writable');
  database.close();
}

console.log('sqlite-vfs-bun-backend: all assertions passed');
