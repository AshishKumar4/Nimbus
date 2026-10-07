#!/usr/bin/env bun
/**
 * sqlite-vfs-snapshots — generations and snapshots (SPEC P3): a snapshot is
 * one row; at(name) reads the pinned tree while writers go on; restore and
 * drop are O(changes) jobs that finish after a reset; diff compares by
 * content key; a streamed write is captured as its committed prefix, or
 * whole with quiesce.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CHUNK_SIZE } from '../../packages/platform/src/limits.ts';
import { encodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';
import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

function open(harness = createSqliteVfsTestHarness()) {
  const raw = new SqliteVFS(harness.sql, harness.ctx);
  return { harness, raw, vfs: raw.as(CRED_KERNEL) };
}

function random(length, seed) {
  const out = new Uint8Array(length);
  let s = (seed * 2654435761 + 1) >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    out[i] = s & 255;
  }
  return out;
}

/** Every path with its kind, mode and a byte hash: the tree's image. */
function image(view) {
  const out = {};
  const walk = (dir) => {
    for (const entry of view.readdir(dir)) {
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      const stat = view.lstat(path);
      if (entry.type === 'directory') { out[path] = `dir ${stat.mode}`; walk(path); }
      else if (entry.type === 'symlink') out[path] = `link ${view.readlink(path)}`;
      else out[path] = `file ${stat.mode} ${createHash('sha256').update(view.readFile(path)).digest('hex')}`;
    }
  };
  walk('');
  return out;
}

/** Interleaved writes, overwrites, range edits, deletes and renames. */
function churn(vfs, round) {
  for (let i = 0; i < 40; i++) {
    const path = `w/d${i % 5}/f${(i * 7 + round) % 23}`;
    switch ((i + round) % 6) {
      case 0: vfs.writeFile(path, random(100 + ((i * 131) % 3000), round * 1000 + i)); break;
      case 1: vfs.writeFile(path, random(CHUNK_SIZE + 5000 + i * 97, round * 1000 + i)); break;
      case 2: if (vfs.exists(path)) vfs.unlink(path); break;
      case 3: if (vfs.isFile(path)) vfs.writeRange(path, 17, random(40, i + round)); break;
      case 4: if (vfs.isFile(path) && !vfs.exists(`${path}.moved`)) vfs.rename(path, `${path}.moved`); break;
      default: if (vfs.isFile(path)) vfs.truncate(path, 7); break;
    }
  }
  vfs.chmod('w/d1', 0o700 + round % 8);
}

function seed(vfs) {
  for (let d = 0; d < 5; d++) vfs.mkdir(`w/d${d}`, { recursive: true });
  vfs.symlink('d0', 'w/link');
}

function drain(raw) {
  for (let pass = 0; raw.runContentMaintenance(64).transactions > 0; pass++) assert.ok(pass < 1000);
}

// ── Three snapshots, interleaved churn: every at(s) is its recorded image ─
{
  const { harness, raw, vfs } = open();
  seed(vfs);
  const images = {};
  for (const [round, name] of ['s1', 's2', 's3'].entries()) {
    churn(vfs, round);
    const before = harness.statementCount;
    const snap = raw.snapshot(name);
    assert.equal(snap.gen, raw.revision(), 'a snapshot pins the last committed generation');
    const writes = harness.statements.slice(before).filter((s) => !/^\s*SELECT/i.test(s.sql));
    assert.equal(writes.length, 2, 'a snapshot is one row and pin_gen, whatever the tree');
    images[name] = image(vfs);
  }
  churn(vfs, 3);
  for (const name of ['s1', 's2', 's3']) assert.deepEqual(image(raw.at(name)), images[name], `at(${name})`);
  assert.throws(() => raw.at('s1').writeFile('w/x', 'y'), /EROFS/);
  assert.throws(() => raw.snapshot('s2'), /EEXIST/);

  // Credentials apply inside a snapshot as they do live.
  vfs.writeFile('w/secret', 'x');
  vfs.chmod('w/secret', 0o600);
  raw.snapshot('perm');
  assert.throws(() => raw.at('perm', CRED_SESSION_USER).readFile('w/secret'), /EACCES/);

  // ── diff: O(changes), by content key ────────────────────────────────────
  const changes = raw.diff('s1', 's2').entries;
  const expected = Object.keys({ ...images.s1, ...images.s2 }).filter((path) => images.s1[path] !== images.s2[path]).sort();
  assert.deepEqual(changes.map((entry) => entry.path), expected);
  for (const entry of changes) {
    assert.equal(entry.change, !(entry.path in images.s1) ? 'added' : !(entry.path in images.s2) ? 'removed' : 'modified');
  }
  assert.deepEqual(raw.diff('s3', 's3').entries, []);

  // ── Restore to each snapshot in turn ────────────────────────────────────
  for (const name of ['s2', 's1', 's3']) {
    raw.restore(name);
    const now = image(vfs);
    delete now['w/secret'];
    assert.deepEqual(now, images[name], `restored to ${name}`);
    for (const other of ['s1', 's2', 's3']) assert.deepEqual(image(raw.at(other)), images[other], `${other} intact after restoring ${name}`);
  }

  // ── Drop the middle: the others hold, history holds only what they need ─
  raw.dropSnapshot('s2');
  assert.throws(() => raw.at('s2'), /ENOENT/);
  for (const name of ['s1', 's3']) assert.deepEqual(image(raw.at(name)), images[name], `${name} after dropping s2`);
  const kept = raw.snapshots().map((snap) => snap.gen);
  for (const row of harness.sql.exec('SELECT gen_from, gen_to FROM vfs_inode_history')) {
    assert.ok(kept.some((g) => row.gen_from <= g && g < row.gen_to), `history row [${row.gen_from}, ${row.gen_to}) covers no snapshot`);
  }
  for (const name of ['s1', 's3', 'perm']) raw.dropSnapshot(name);
  assert.deepEqual(harness.sql.exec('SELECT COUNT(*) AS n FROM vfs_inode_history')[0].n, 0);
  drain(raw);
  assert.deepEqual(raw._auditContentStore(), { chunks: 0, contents: 0 });
}

// ── A snapshot read survives GC; the first write after it keeps one image ─
{
  const { harness, raw, vfs } = open();
  vfs.writeFile('f', random(200_000, 1));
  vfs.writeFile('small', 'v1');
  raw.snapshot('s');
  const history = () => harness.sql.exec('SELECT COUNT(*) AS n FROM vfs_inode_history')[0].n;
  vfs.writeRange('f', 10, new Uint8Array(3));
  vfs.writeFile('small', 'v2');
  assert.equal(history(), 2, 'the first write after a snapshot keeps the row it saw');
  vfs.writeRange('f', 20, new Uint8Array(3));
  vfs.writeFile('small', 'v3');
  assert.equal(history(), 2, 'later writes keep nothing');
  vfs.unlink('f');
  drain(raw);
  assert.deepEqual(raw.at('s').readFile('f'), random(200_000, 1), 'GC keeps what a snapshot sees');
  assert.equal(raw.at('s').readFileString('small'), 'v1', 'an in-place rewrite never reaches a snapshot');
}

// ── copyTree from a snapshot copies the pinned tree ───────────────────────
{
  const { raw, vfs } = open();
  seed(vfs);
  churn(vfs, 1);
  raw.snapshot('base');
  const pinned = image(raw.at('base'));
  churn(vfs, 2);
  vfs.copyTree('w', 'branch', { at: 'base', preserve: true });
  const branch = {};
  for (const [path, value] of Object.entries(image(vfs))) if (path.startsWith('branch')) branch[`w${path.slice('branch'.length)}`] = value;
  const expected = Object.fromEntries(Object.entries(pinned).filter(([path]) => path.startsWith('w')));
  assert.deepEqual(branch, expected);
}

// ── A reset inside restore or drop: the next open finishes the job ────────
for (const op of ['restore', 'drop']) {
  const baseline = open();
  seed(baseline.vfs);
  for (let r = 0; r < 3; r++) churn(baseline.vfs, r);
  baseline.raw.snapshot('s');
  for (let r = 3; r < 8; r++) churn(baseline.vfs, r);
  const start = baseline.harness.transactionCount;
  if (op === 'restore') baseline.raw.restore('s'); else baseline.raw.dropSnapshot('s');
  const transactions = baseline.harness.transactionCount - start;
  const expected = image(baseline.vfs);
  const history = baseline.harness.sql.exec('SELECT COUNT(*) AS n FROM vfs_inode_history')[0].n;
  assert.ok(transactions >= 3, `${op} spans ${transactions} transactions`);
  for (let k = 1; k <= transactions; k++) {
    const { harness, raw, vfs } = open();
    seed(vfs);
    for (let r = 0; r < 3; r++) churn(vfs, r);
    raw.snapshot('s');
    for (let r = 3; r < 8; r++) churn(vfs, r);
    harness.failAfterTransaction({ transaction: harness.transactionCount + k, error: new Error(`reset at ${k}`) });
    // A reset inside the maintenance a job triggers is survived, not thrown.
    try { if (op === 'restore') raw.restore('s'); else raw.dropSnapshot('s'); } catch (error) { assert.match(String(error), new RegExp(`reset at ${k}`)); }
    harness.clearFault();
    const reopened = open(createSqliteVfsTestHarness(harness.db));
    assert.deepEqual(image(reopened.vfs), expected, `${op} after a reset at ${k}`);
    assert.deepEqual(reopened.raw.jobs(), [], `${op}: no job left after a reset at ${k}`);
    assert.equal(harness.sql.exec('SELECT COUNT(*) AS n FROM vfs_inode_history')[0].n, history);
    assert.equal(reopened.raw._verifyCounters(), null);
  }
}

// ── A restore holds its snapshot against a drop ───────────────────────────
{
  const { harness, raw, vfs } = open();
  seed(vfs);
  churn(vfs, 0);
  raw.snapshot('s');
  churn(vfs, 1);
  harness.failAfterTransaction({ transaction: harness.transactionCount + 2, error: new Error('reset') });
  assert.throws(() => raw.restore('s'), /reset/);
  harness.clearFault();
  assert.throws(() => raw.dropSnapshot('s'), /EBUSY/);
}

// ── A snapshot during a stream: its committed prefix, or all with quiesce ─
{
  const files = Array.from({ length: 6 }, (_, i) => ({ path: `s/f${i}`, data: random(300_000, i) }));
  const payload = {
    inodes: [{ path: 's', parentPath: '', isDir: true, size: 0, mtime: 1, mode: 0o755, chunkCount: 0 }, ...files.map((f) => ({
      path: f.path, parentPath: 's', isDir: false, size: f.data.length, mtime: 1, mode: 0o644, chunkCount: Math.ceil(f.data.length / CHUNK_SIZE),
    }))],
    chunks: files.flatMap((f) => Array.from({ length: Math.ceil(f.data.length / CHUNK_SIZE) }, (_, id) => ({
      path: f.path, chunkId: id, data: f.data.slice(id * CHUNK_SIZE, (id + 1) * CHUNK_SIZE),
    }))),
  };
  // A stream that pauses mid-way: snapshot while it is paused.
  const paused = (bytes, gate) => new ReadableStream({
    type: 'bytes',
    async start(controller) {
      controller.enqueue(bytes.slice(0, Math.floor(bytes.length * 0.6)));
      await gate;
      controller.enqueue(bytes.slice(Math.floor(bytes.length * 0.6)));
      controller.close();
    },
  });
  const collect = async (stream) => new Uint8Array(await new Response(stream).arrayBuffer());
  const bytes = await collect(encodeWriteBatchStream(payload));
  for (const quiesce of [false, true]) {
    const { raw, vfs } = open();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const writing = vfs.writeStream(paused(bytes, gate));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const snapping = quiesce ? raw.snapshot('s', { quiesce: true }) : raw.snapshot('s');
    release();
    await snapping;
    const written = await writing;
    assert.equal(written.ok, true, JSON.stringify(written.error));
    const view = raw.at('s');
    const captured = files.filter((f) => view.exists(f.path));
    for (const f of captured) assert.deepEqual(view.readFile(f.path), f.data, 'whole files only');
    if (quiesce) assert.equal(captured.length, files.length, 'quiesce waits for the stream');
    else assert.ok(captured.length < files.length, `without quiesce, a committed prefix (${captured.length})`);
    assert.deepEqual(files.map((f) => view.exists(f.path)), files.map((_, i) => i < captured.length), 'a prefix, in stream order');
  }
}

console.log('sqlite-vfs-snapshots: all assertions passed');
