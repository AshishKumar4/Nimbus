#!/usr/bin/env bun
// A read's bytes are the reader's own, whatever the SQL port hands the engine
// for a BLOB: a Node Buffer (a better-sqlite3-style port) as well as a plain
// Uint8Array. A reader that changes what it was given changes nothing the
// engine keeps: a later read of the file, through a description or by name,
// and a read of another file with the same content (one chunk), are the
// stored bytes.
//
// Red before: the chunk cache kept the port's Buffer as it was, and a read
// was a slice of it, which for a Buffer is a view, not a copy.

import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
// The port answers every BLOB as a Buffer of its own, as better-sqlite3 does.
const exec = harness.sql.exec;
harness.sql.exec = (query, ...params) => exec.call(harness.sql, query, ...params)
  .map((row) => Object.fromEntries(Object.entries(row).map(([column, value]) => [column, value instanceof Uint8Array ? Buffer.from(value) : value])));
const vfs = new SqliteVFS(harness.sql, harness.ctx);
const kernel = vfs.as(CRED_KERNEL);
const content = Uint8Array.from({ length: 60_000 }, (_, i) => (i * 7) % 256);
kernel.writeFile('a', content);
kernel.writeFile('b', content);

const description = vfs.openDescription('a', CRED_KERNEL, { read: true, write: false });
try {
  for (const [what, read] of [
    ['a description', () => description.read(0, content.length)],
    ['a read by name', () => kernel.readRange('a', 0, content.length)],
  ]) {
    const first = read();
    assert.deepEqual(first, content);
    first.fill(0xff);
    assert.deepEqual(read(), content, `${what}: a later read is the stored bytes`);
    assert.deepEqual(kernel.readRange('b', 0, content.length), content, `${what}: so is the file that shares the chunk`);
  }
} finally {
  description.close();
}
console.log('sqlite-vfs-buffer-blobs: ok');
