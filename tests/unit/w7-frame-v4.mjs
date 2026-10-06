#!/usr/bin/env bun
/**
 * W7 v4: a program-order operation log. A payload's `ops` are encoded in
 * the order given, a path named by as many as need it, including the
 * operations v3 had no record for (rename, truncate, setattr); a stream
 * that stops commits a prefix of them, in that order. Every producer
 * encodes v4 (a payload without ops is its deletes, then its directories,
 * then its files); a v3 stream still decodes, for the release that rolls
 * v4 out, with v3's rules (no new records, one operation per path).
 */

import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { decodeWriteBatchStream, encodeWriteBatchStream, W7_MAGIC } from '../../packages/platform/src/w7-frame.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();

const file = (path, text) => {
  const data = enc.encode(text);
  return {
    type: 'file',
    inode: { path, parentPath: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', kind: 'file', isDir: false, size: data.length, mtime: 7, mode: 0o644, chunkCount: data.length === 0 ? 0 : 1 },
    data,
  };
};
const directory = (path) => ({
  type: 'directory',
  inode: { path, parentPath: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', kind: 'directory', isDir: true, size: 0, mtime: 7, mode: 0o755, chunkCount: 0 },
});

/** The records a stream decodes to, chunks folded into their file's text. */
async function records(stream) {
  const decoded = await decodeWriteBatchStream(stream);
  const out = [];
  let text = null;
  for await (const record of decoded.records) {
    if (record.type === 'file-begin') { text = ''; out.push(['file', record.inode.path]); }
    else if (record.type === 'file-chunk') { text += dec.decode(record.data); record.retention.release(); }
    else if (record.type === 'file-end') out.at(-1).push(text);
    else if (record.type === 'directory') out.push(['directory', record.inode.path]);
    else if (record.type === 'delete') out.push(['delete', record.path]);
    else if (record.type === 'rename') out.push(['rename', record.from, record.to]);
    else if (record.type === 'truncate') out.push(['truncate', record.path, record.size]);
    else if (record.type === 'setattr') out.push(['setattr', record.path, record.attrs]);
    else if (record.type === 'batch-end') out.push(['end', record.summary.opCount]);
  }
  return { mode: decoded.mode, records: out };
}

const ops = [
  directory('w'),
  file('w/a', 'first'),
  { type: 'rename', from: 'w/a', to: 'w/b' },
  file('w/a', 'second'),
  { type: 'truncate', path: 'w/b', size: 3 },
  { type: 'setattr', path: 'w/b', attrs: { mode: 0o600 } },
  { type: 'setattr', path: 'w/b', attrs: { uid: 1000, gid: 1000 } },
  { type: 'setattr', path: 'w/a', attrs: { atime: 11, mtime: 12 } },
  file('w/early', 'e'),
  directory('w/later'),
  file('w/later/x', 'x'),
  { type: 'delete', path: 'w/a' },
];

// ── Encoded in the order given, a path as often as it is named ──
{
  assert.deepEqual([...W7_MAGIC], [0x4e, 0x57, 0x37, 0x04]);
  const { mode, records: got } = await records(encodeWriteBatchStream({ inodes: [], chunks: [], ops }));
  assert.equal(mode, 'program-order-committed-prefix');
  assert.deepEqual(got, [
    ['directory', 'w'],
    ['file', 'w/a', 'first'],
    ['rename', 'w/a', 'w/b'],
    ['file', 'w/a', 'second'],
    ['truncate', 'w/b', 3],
    ['setattr', 'w/b', { mode: 0o600 }],
    ['setattr', 'w/b', { uid: 1000, gid: 1000 }],
    ['setattr', 'w/a', { atime: 11, mtime: 12 }],
    ['file', 'w/early', 'e'],
    ['directory', 'w/later'],
    ['file', 'w/later/x', 'x'],
    ['delete', 'w/a'],
    ['end', 5],
  ]);
  assert.throws(() => encodeWriteBatchStream({ inodes: [], chunks: [], ops: [{ type: 'setattr', path: 'w', attrs: { mode: 0o600, uid: 1 } }] }),
    /setattr changes the mode, the owner or the times, one of them/);
  assert.throws(() => encodeWriteBatchStream({ inodes: [], chunks: [], deletePaths: ['x'], ops: [] }), /a payload of ops carries nothing else/);
}

// ── A payload without ops is v4 too: its deletes, directories, then files ──
{
  const data = enc.encode('payload');
  const { records: got } = await records(encodeWriteBatchStream({
    deletePaths: ['gone'],
    inodes: [
      { path: 'p/f', parentPath: 'p', kind: 'file', isDir: false, size: data.length, mtime: 1, mode: 0o644, chunkCount: 1 },
      { path: 'p', parentPath: '', kind: 'directory', isDir: true, size: 0, mtime: 1, mode: 0o755, chunkCount: 0 },
    ],
    chunks: [{ path: 'p/f', chunkId: 0, data }],
  }));
  assert.deepEqual(got, [['delete', 'gone'], ['directory', 'p'], ['file', 'p/f', 'payload'], ['end', 0]]);
}

// ── A v3 stream still decodes, with v3's rules ──
const V3 = Uint8Array.from(Buffer.from('Tlc3AwFTAAAAeyJpZCI6ImQ0ZGRhYTkxLWQyZTMtNDBhNS05MGYwLTdjNTIxZWMzNTFlMyIsIm1vZGUiOiJwYXRoLWF0b21pYy1jb21taXR0ZWQtcHJlZml4In0CDgAAAHsicGF0aCI6Im9sZCJ9AzQAAAB7InBhdGgiOiJkIiwibXRpbWUiOjEsIm1vZGUiOjQ5Mywia2luZCI6ImRpcmVjdG9yeSJ9BH4AAAB7InBhdGgiOiJkL2YiLCJtdGltZSI6MSwibW9kZSI6NDIwLCJraW5kIjoiZmlsZSIsImNvbnRlbnRJZCI6ImQ0ZGRhYTkxLWQyZTMtNDBhNS05MGYwLTdjNTIxZWMzNTFlMzowIiwic2l6ZSI6OCwiY2h1bmtDb3VudCI6MX0FOgAAACYAAABkNGRkYWE5MS1kMmUzLTQwYTUtOTBmMC03YzUyMWVjMzUxZTM6MAAAAAAIAAAAdjMgYnl0ZXMGYQAAAHsiY29udGVudElkIjoiZDRkZGFhOTEtZDJlMy00MGE1LTkwZjAtN2M1MjFlYzM1MWUzOjAiLCJzaXplIjo4LCJjaHVua0NvdW50IjoxLCJjaGVjayI6Mzg2NzIzMjU5Nn0HgAAAAHsicmVjb3JkQ291bnQiOjYsInBhdGhDb3VudCI6MywiZGVsZXRlQ291bnQiOjEsImRpcmVjdG9yeUNvdW50IjoxLCJmaWxlQ291bnQiOjEsImNodW5rQ291bnQiOjEsImJ5dGVDb3VudCI6OCwiY2hlY2siOjMyMTI2ODA2ODN9', 'base64'));
const streamOf = (bytes) => new ReadableStream({ type: 'bytes', start(controller) { controller.enqueue(bytes.slice()); controller.close(); } });
{
  assert.deepEqual([...V3.subarray(0, 4)], [0x4e, 0x57, 0x37, 0x03]);
  const { mode, records: got } = await records(streamOf(V3));
  assert.equal(mode, 'path-atomic-committed-prefix');
  assert.deepEqual(got, [['delete', 'old'], ['directory', 'd'], ['file', 'd/f', 'v3 bytes'], ['end', 0]]);
  // A v3 stream names each path once.
  const text = Buffer.from(V3).toString('latin1');
  const repeated = Uint8Array.from(Buffer.from(text.replace('{"path":"old"}', '{"path":"d/f"}'), 'latin1'));
  await assert.rejects(records(streamOf(repeated)), /duplicate path ownership: d\/f/);
  // And has no record v4 added: a delete's tag made a rename's is unknown there.
  const deleteAt = text.indexOf('{"path":"old"}') - 5;
  const renamed = V3.slice();
  assert.equal(renamed[deleteAt], 2);
  renamed[deleteAt] = 8;
  await assert.rejects(records(streamOf(renamed)), /unknown record tag 8/);
}

// ── Applied in program order, and a stream that stops commits a prefix ──
function open() {
  const harness = createSqliteVfsTestHarness();
  const raw = new SqliteVFS(harness.sql, harness.ctx);
  return { raw, kernel: raw.as(CRED_KERNEL) };
}
{
  const { raw, kernel } = open();
  const order = [];
  raw.observeWrites((event) => { order.push([event.type, event.path, event.oldPath]); });
  const result = await kernel.writeStream(encodeWriteBatchStream({ inodes: [], chunks: [], ops }));
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(dec.decode(kernel.readFile('w/b')), 'fir');
  assert.equal(kernel.stat('w/b').mode & 0o777, 0o600);
  assert.equal(kernel.stat('w/b').uid, 1000);
  assert.equal(kernel.exists('w/a'), false);
  assert.equal(dec.decode(kernel.readFile('w/later/x')), 'x');
  assert.deepEqual(order, [
    ['create', 'w', undefined],
    ['create', 'w/a', undefined],
    ['rename', 'w/b', 'w/a'],
    ['create', 'w/a', undefined],
    ['modify', 'w/b', undefined],
    ['modify', 'w/b', undefined],
    ['modify', 'w/b', undefined],
    ['modify', 'w/a', undefined],
    ['create', 'w/early', undefined],
    ['create', 'w/later', undefined],
    ['create', 'w/later/x', undefined],
    ['delete', 'w/a', undefined],
  ], `committed out of program order: ${JSON.stringify(order)}`);
}
{
  // A file written twice in a row: the second write follows the first.
  const { raw, kernel } = open();
  const events = [];
  raw.observeWrites((event) => {
    if (event.after?.type !== 'file') return;
    events.push([event.type, event.path, event.before === null ? null : dec.decode(event.before.read()), dec.decode(event.after.read())]);
  });
  const result = await kernel.writeStream(encodeWriteBatchStream({ inodes: [], chunks: [], ops: [
    directory('r'), file('r/f', 'one'), file('r/f', 'two'),
  ] }));
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(dec.decode(kernel.readFile('r/f')), 'two');
  assert.deepEqual(events, [['create', 'r/f', null, 'one'], ['modify', 'r/f', 'one', 'two']]);
}
{
  const { kernel } = open();
  // The truncate names a file nobody made: what came before it commits, nothing after.
  const result = await kernel.writeStream(encodeWriteBatchStream({ inodes: [], chunks: [], ops: [
    directory('p'),
    file('p/one', 'one'),
    { type: 'truncate', path: 'p/missing', size: 0 },
    file('p/two', 'two'),
  ] }));
  assert.equal(result.ok, false);
  assert.match(String(result.error?.message), /ENOENT/);
  assert.equal(dec.decode(kernel.readFile('p/one')), 'one');
  assert.equal(kernel.exists('p/two'), false, 'an operation after the one that failed was committed');
  assert.equal(result.committedGroupSequence, 2);
}

console.log('w7-frame v4: ok');
