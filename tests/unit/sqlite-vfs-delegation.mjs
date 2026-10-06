#!/usr/bin/env bun
/**
 * Delegations (P1, the session side): an exclusive-mutation lease whose
 * holder decides its subtree's operations itself and sends them later. Any
 * other caller's access recalls them first instead of being refused:
 *   - a write anywhere it overlaps revokes the delegation (the holder sends
 *     what it decided and gives the subtree up; its later writes are ESTALE);
 *   - a lookup inside a read-covering delegation, by name or through a link,
 *     shares it (the holder sends what it decided and writes through from
 *     then on; the delegation stays);
 *   - recalls of one delegation are joined, a revoke superseding a share;
 *   - the holder's own calls recall nothing; a plain lease still refuses (EBUSY);
 *   - a caller that cannot wait is refused (EAGAIN) with the recall started,
 *     and its retry finds the subtree current.
 */

import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { RecallRequired, SqliteVFS, withRecall } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { encodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';
import { CompositeVFS } from '../../packages/core/src/vfs/composite.ts';
import { sqliteFiles } from '../../packages/core/src/vfs/sqlite-files.ts';
import { recallOf } from '../../packages/core/src/vfs/recall.ts';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSupervisorOpHandler } from '../../packages/core/src/workspace/supervisor-op.ts';

const dec = new TextDecoder();

/**
 * A holder of the delegation at `root`: what it decided is kept in `pending`
 * (path -> text) until a recall sends it through its lease.
 */
function delegate(raw, root, { reads = true } = {}) {
  const pending = new Map();
  const recalls = [];
  let owned = null;
  let writeThrough = false;
  const holder = {
    pending,
    recalls,
    get owner() { return lease.owner; },
    decide(path, text) {
      if (writeThrough) owned.writeFile(path, text);
      else pending.set(path, text);
    },
    get view() { return owned; },
  };
  const lease = raw.acquireExclusiveMutation(root, {
    delegation: {
      reads,
      async recall(kind) {
        recalls.push(kind);
        await new Promise((resolve) => setTimeout(resolve, 2));
        for (const [path, text] of pending) owned.writeFile(path, text);
        pending.clear();
        if (kind === 'share') writeThrough = true;
      },
    },
  });
  owned = raw.as(CRED_KERNEL, { mutationOwner: lease.owner });
  return holder;
}

function open() {
  const harness = createSqliteVfsTestHarness();
  const raw = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = raw.as(CRED_KERNEL);
  kernel.mkdir('work');
  kernel.mkdir('work/d');
  kernel.writeFile('work/d/a', 'stored');
  kernel.writeFile('outside', 'free');
  return { raw, kernel };
}

// ── A foreign write revokes: the holder sends what it decided and gives up ──
{
  const { raw, kernel } = open();
  const holder = delegate(raw, 'work/d');
  holder.decide('work/d/a', 'decided by the holder');
  holder.decide('work/d/b', 'made by the holder');
  assert.throws(() => kernel.writeFile('work/d/a', 'foreign'), (error) => error instanceof RecallRequired && error.kind === 'revoke' && error.code === 'EAGAIN');
  await withRecall(() => kernel.writeFile('work/d/a', 'foreign'));
  assert.deepEqual(holder.recalls, ['revoke'], 'one recall answered the refused write and its retry');
  assert.equal(dec.decode(kernel.readFile('work/d/a')), 'foreign');
  assert.equal(dec.decode(kernel.readFile('work/d/b')), 'made by the holder', "the holder's decided write was lost");
  assert.throws(() => holder.view.writeFile('work/d/c', 'late'), /ESTALE/, "a revoked holder's write landed");
  // A write outside it recalls nothing.
  kernel.writeFile('outside', 'still free');
}

// ── A foreign read shares: the holder sends what it decided, and stays ──
{
  const { raw, kernel } = open();
  const holder = delegate(raw, 'work/d');
  holder.decide('work/d/a', 'unsent');
  assert.throws(() => kernel.readFile('work/d/a'), (error) => error instanceof RecallRequired && error.kind === 'share');
  assert.equal(dec.decode(await withRecall(() => kernel.readFile('work/d/a'))), 'unsent');
  assert.deepEqual(holder.recalls, ['share']);
  // Shared: reads pass, the holder writes through, and its lease stands.
  holder.decide('work/d/a', 'written through');
  assert.equal(dec.decode(kernel.readFile('work/d/a')), 'written through');
  assert.deepEqual(holder.recalls, ['share'], 'a read of a shared delegation recalled it again');
  // A foreign write still revokes it.
  await withRecall(() => kernel.writeFile('work/d/a', 'foreign'));
  assert.deepEqual(holder.recalls, ['share', 'revoke']);
}

// ── A lookup through a link into the subtree recalls it; one that only names
//    the delegated directory's parent does not ──
{
  const { raw, kernel } = open();
  kernel.symlink('/work/d/a', 'link');
  const holder = delegate(raw, 'work/d');
  assert.throws(() => kernel.readFile('link'), (error) => error instanceof RecallRequired, 'a read through a link escaped the recall');
  assert.ok(kernel.readdir('work').some((entry) => entry.name === 'd' || entry === 'd'));
  assert.equal(dec.decode(kernel.readFile('outside')), 'free');
  assert.deepEqual(holder.recalls, ['share']);
}

// ── The holder's own calls recall nothing ──
{
  const { raw } = open();
  const holder = delegate(raw, 'work/d');
  holder.view.writeFile('work/d/own', 'mine');
  assert.equal(dec.decode(holder.view.readFile('work/d/own')), 'mine');
  assert.deepEqual(holder.recalls, []);
}

// ── Concurrent recalls of one delegation are one; a revoke supersedes a share ──
{
  const { raw, kernel } = open();
  const holder = delegate(raw, 'work/d');
  await Promise.all([
    withRecall(() => kernel.readFile('work/d/a')),
    withRecall(() => kernel.stat('work/d/a')),
    withRecall(() => kernel.exists('work/d/a')),
  ]);
  assert.deepEqual(holder.recalls, ['share'], `concurrent reads recalled ${holder.recalls.length} times`);
}

// ── A read-only delegation (reads: false) lets reads through; writes revoke ──
{
  const { raw, kernel } = open();
  const holder = delegate(raw, 'work/d', { reads: false });
  assert.equal(dec.decode(kernel.readFile('work/d/a')), 'stored');
  await withRecall(() => kernel.unlink('work/d/a'));
  assert.deepEqual(holder.recalls, ['revoke']);
}

// ── A plain lease still refuses (EBUSY), and a caller that cannot wait is
//    refused with the recall already started ──
{
  const { raw, kernel } = open();
  const plain = raw.acquireExclusiveMutation('work/d');
  assert.throws(() => kernel.writeFile('work/d/a', 'x'), (error) => error.code === 'EBUSY' && !(error instanceof RecallRequired));
  raw.releaseExclusiveMutation(plain.owner);
  const holder = delegate(raw, 'work/d');
  holder.decide('work/d/a', 'sent on recall');
  assert.throws(() => kernel.readFile('work/d/a'), (error) => error.code === 'EAGAIN');
  assert.deepEqual(holder.recalls, ['share'], 'the refusal did not start the recall');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(dec.decode(kernel.readFile('work/d/a')), 'sent on recall', "a retry after the recall did not find the holder's write");
}

// ── Through a namespace: its asynchronous calls wait for the recall; its
//    synchronous face reports EAGAIN for its own call, the recall its cause ──
{
  const { raw } = open();
  const vfs = new CompositeVFS(sqliteFiles(raw, CRED_KERNEL));
  const holder = delegate(raw, 'work/d');
  holder.decide('work/d/a', 'from the holder');
  assert.throws(() => vfs.sync.readFile('/work/d/a'), (error) => error.code === 'EAGAIN' && /open '\/work\/d\/a'/.test(error.message) && recallOf(error) !== null);
  assert.equal(dec.decode(await vfs.readFile('/work/d/a')), 'from the holder');
  await vfs.writeFile('/work/d/a', new TextEncoder().encode('embedder'));
  assert.deepEqual(holder.recalls, ['share', 'revoke']);
  assert.equal(dec.decode(await vfs.readFile('/work/d/a')), 'embedder');
}

// ── A process's call through the supervisor waits for the recall: no process
//    call is refused for a delegation ──
{
  const harness = createSqliteVfsTestHarness();
  const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
  const kernel = ws.vfs.as(CRED_KERNEL);
  kernel.mkdir('work/d', { recursive: true });
  kernel.writeFile('work/d/a', 'stored');
  kernel.chmod('work/d', 0o777);
  const holder = delegate(ws.vfs, 'work/d');
  holder.decide('work/d/a', 'decided');
  const op = createSupervisorOpHandler({ vfs: ws.vfs, filesystem: ws.filesystem });
  const pid = ws.shell.pid ?? 1;
  assert.equal(dec.decode(await op({ op: 'readFileBytes', args: ['/work/d/a'], pid })), 'decided');
  await op({ op: 'writeFile', args: ['/work/d/b', 'from a process'], pid });
  assert.deepEqual(holder.recalls, ['share', 'revoke']);
  assert.equal(dec.decode(kernel.readFile('work/d/b')), 'from a process');
}

// ── A W7 stream landing in a delegation waits for it to be given up, between
//    records, and then applies whole ──
{
  const { raw, kernel } = open();
  const holder = delegate(raw, 'work/d');
  holder.decide('work/d/held', 'the holder\'s');
  const data = new TextEncoder().encode('from a wave');
  const result = await kernel.writeStream(encodeWriteBatchStream({
    inodes: [{ path: 'work/d/w', parentPath: 'work/d', kind: 'file', isDir: false, size: data.length, mtime: 1, mode: 0o644, chunkCount: 1 }],
    chunks: [{ path: 'work/d/w', chunkId: 0, data }],
  }));
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.deepEqual(holder.recalls, ['revoke']);
  assert.equal(dec.decode(kernel.readFile('work/d/w')), 'from a wave');
  assert.equal(dec.decode(kernel.readFile('work/d/held')), "the holder's");
}

console.log('sqlite-vfs delegation: ok');
