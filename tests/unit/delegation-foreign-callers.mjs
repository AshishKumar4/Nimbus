#!/usr/bin/env bun
/**
 * Every caller that reaches the session's engine directly passes another
 * holder's delegation by waiting for its recall, never by answering EAGAIN
 * (delegation inventory, classes 1, 3, 4 and 7). One case per class: a
 * delegation is held over the subtree with a decided write not yet sent;
 * the foreign call waits, then succeeds, and sees the holder's write.
 */

import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSupervisorOpHandler } from '../../packages/core/src/workspace/supervisor-op.ts';
import { serveEditorFs } from '../../packages/worker/src/session/editor-fs.ts';
import { rpcDeleteFile } from '../../packages/worker/src/session/programmatic.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const dec = new TextDecoder();
const enc = new TextEncoder();

/** A delegation of `root` whose holder decided `decided` (path -> text) and sends it when recalled. */
function held(root, decided) {
  const harness = createSqliteVfsTestHarness();
  const raw = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = raw.as(CRED_KERNEL);
  kernel.mkdir(root, { recursive: true });
  kernel.writeFile(`${root}/existing`, 'stored');
  const recalls = [];
  let owned;
  const lease = raw.acquireExclusiveMutation(root, {
    delegation: {
      reads: true,
      async recall(kind) {
        recalls.push(kind);
        await new Promise((resolve) => setTimeout(resolve, 2));
        for (const [path, text] of Object.entries(decided)) owned.writeFile(path, text);
      },
    },
  });
  owned = raw.as(CRED_KERNEL, { mutationOwner: lease.owner });
  return { raw, kernel, recalls };
}

// ── Class 1: a routed supervisor op (a host _rpc* method on the engine) ──
{
  const { raw, kernel, recalls } = held('home/user/repo', { 'home/user/repo/decided': 'by the holder' });
  const data = enc.encode('routed');
  const op = createSupervisorOpHandler({
    vfs: raw,
    host: {
      // What the session's _rpcWriteBatch does: the engine, as the caller.
      _rpcWriteBatch: (payload) => raw.as(CRED_KERNEL).writeBatch(payload),
    },
  });
  await op({
    op: 'writeBatch',
    args: [{
      inodes: [{ path: 'home/user/repo/routed', parentPath: 'home/user/repo', kind: 'file', isDir: false, size: data.length, mtime: 1, mode: 0o644, chunkCount: 1 }],
      chunks: [{ path: 'home/user/repo/routed', chunkId: 0, data }],
    }],
    pid: 1,
  });
  assert.deepEqual(recalls, ['revoke']);
  assert.equal(dec.decode(kernel.readFile('home/user/repo/routed')), 'routed');
  assert.equal(dec.decode(kernel.readFile('home/user/repo/decided')), 'by the holder');
}

// ── Class 4: the programmatic files API (files.delete) ──
{
  const { raw, kernel, recalls } = held('home/user/repo', { 'home/user/repo/decided': 'by the holder' });
  const host = { sqliteFs: raw, async ensureRuntimeReady() {} };
  await rpcDeleteFile(host, '/home/user/repo/existing');
  // It looks before it removes: the look shares, the removal revokes.
  assert.deepEqual(recalls, ['share', 'revoke']);
  assert.equal(kernel.exists('home/user/repo/existing'), false);
  assert.equal(dec.decode(kernel.readFile('home/user/repo/decided')), 'by the holder');
}

// ── Class 7: the editor pane's reads, lists and writes ──
{
  const { raw, kernel, recalls } = held('home/user/repo', { 'home/user/repo/decided': 'by the holder' });
  const editor = raw.as(CRED_KERNEL);
  const read = await serveEditorFs(editor, { type: 'fs-read', path: '/home/user/repo/decided' });
  assert.deepEqual(read, { type: 'fs-read-result', path: '/home/user/repo/decided', content: 'by the holder' });
  assert.deepEqual(recalls, ['share']);
  const listed = await serveEditorFs(editor, { type: 'fs-list', dir: '/home/user', recursive: true });
  assert.deepEqual(listed.entries.map((entry) => entry.path).sort(),
    ['/home/user/repo', '/home/user/repo/decided', '/home/user/repo/existing']);
  const written = await serveEditorFs(editor, { type: 'fs-write', path: '/home/user/repo/edited', content: 'from the editor' });
  assert.deepEqual(written, { type: 'fs-write-result', path: '/home/user/repo/edited', ok: true });
  assert.deepEqual(recalls, ['share', 'revoke']);
  assert.equal(dec.decode(kernel.readFile('home/user/repo/edited')), 'from the editor');
}

// ── A list that meets a delegation it may not wait out is not silently cut:
//    the walk is recalled whole, never answered with the subtree left out ──
{
  const { raw, recalls } = held('home/user/repo', {});
  const listed = await serveEditorFs(raw.as(CRED_KERNEL), { type: 'fs-list', dir: '/home', recursive: true });
  assert.ok(listed.entries.some((entry) => entry.path === '/home/user/repo/existing'), JSON.stringify(listed));
  assert.deepEqual(recalls, ['share']);
}

console.log('delegation foreign callers: ok');
