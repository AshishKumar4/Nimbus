#!/usr/bin/env bun
/**
 * Every caller that reaches the session's engine directly passes another
 * holder's delegation by waiting for its recall, never by answering EAGAIN
 * (delegation inventory, classes 1 to 8), or cannot meet one (the session's
 * own stores are never delegated). One case per class: a delegation is held
 * over the subtree with a decided write not yet sent; the foreign call
 * waits, then succeeds, and sees the holder's write.
 */

import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSupervisorOpHandler } from '../../packages/core/src/workspace/supervisor-op.ts';
import { serveEditorFs } from '../../packages/worker/src/session/editor-fs.ts';
import { rpcDeleteFile } from '../../packages/worker/src/session/programmatic.ts';
import { withRecall } from '../../packages/core/src/vfs/recall.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { createRequire } from 'node:module';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { buildWithRolldown } from '../../packages/core/src/runtime/rolldown-build.ts';
import { ProcessFiles, ProcessView } from '../../packages/core/src/runtime/process-files.ts';
import { SESSION_KERNEL_ROOTS } from '../../packages/core/src/runtime/delegations.ts';
import { DURABLE_IMAGE_DIR } from '../../packages/worker/src/facets/durable-images.ts';
import { STAGED_BINDINGS } from '../../packages/worker/src/runtime/staged-bindings.ts';

const dec = new TextDecoder();
const enc = new TextEncoder();

/** A delegation of `root` (holding `stored`, path -> text, first) whose holder decided `decided` and sends it when recalled. */
function held(root, decided, stored = {}) {
  const harness = createSqliteVfsTestHarness();
  const raw = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = raw.as(CRED_KERNEL);
  kernel.mkdir(root, { recursive: true });
  kernel.writeFile(`${root}/existing`, 'stored');
  for (const [path, text] of Object.entries(stored)) kernel.writeFile(path, text);
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

// ── Class 5: a build (a dev server's config, its served modules) reads the
//    project through the esbuild service: each read waits for the recall ──
{
  const { raw, recalls } = held('home/user/app', { 'home/user/app/dep.ts': 'export const answer = 42;' },
    { 'home/user/app/main.ts': "import { answer } from './dep.ts'; export default answer;" });
  const fromWorker = createRequire(new URL('../../packages/worker/package.json', import.meta.url));
  const api = {
    rolldown: (await import(fromWorker.resolve('rolldown'))).rolldown,
    transformSync: (await import(fromWorker.resolve('rolldown/experimental'))).transformSync,
    parseSync: (await import(fromWorker.resolve('rolldown/experimental'))).parseSync,
  };
  const service = new EsbuildService(raw.as(CRED_KERNEL), { buildHost: (options, plugin) => buildWithRolldown(api, options, plugin) });
  const built = await service.build(['/home/user/app/main.ts'], { format: 'esm' });
  const js = built.outputFiles.map((file) => (typeof file.contents === 'string' ? file.contents : dec.decode(file.contents))).join('\n');
  assert.match(js, /42/, `the build did not read the holder's decided module: ${built.errors?.map((e) => e.text).join('; ')}`);
  assert.deepEqual(recalls, ['share']);
}

// ── Class 8: a command's view of the project (git's repository, npm's
//    placements) waits for the recall at each call ──
{
  const { raw, kernel, recalls } = held('home/user/repo', { 'home/user/repo/decided': 'by the holder' });
  const filesystem = new ProcessFiles(raw);
  const view = new ProcessView(filesystem.bind({ pid: 9, cred: CRED_KERNEL }));
  assert.equal(await view.readFileString('/home/user/repo/decided'), 'by the holder');
  assert.deepEqual(recalls, ['share']);
  await view.writeFile('/home/user/repo/from-a-command', 'written');
  assert.deepEqual(recalls, ['share', 'revoke']);
  assert.equal(dec.decode(kernel.readFile('home/user/repo/from-a-command')), 'written');
}

// ── Class 8: a lease taken over a delegated subtree (git clone's) waits for
//    it to be given up, then holds the subtree ──
{
  const { raw, kernel, recalls } = held('home/user/repo/sub', { 'home/user/repo/sub/decided': 'by the holder' });
  const lease = await withRecall(() => kernel.acquireExclusiveMutation('home/user/repo', { includeMissingAncestors: true }));
  assert.equal(lease.root, 'home/user/repo');
  assert.deepEqual(recalls, ['revoke']);
  assert.equal(dec.decode(kernel.readFile('home/user/repo/sub/decided')), 'by the holder');
  raw.releaseExclusiveMutation(lease.owner);
}

// ── Class 6: the session's own stores are never delegated, so its
//    synchronous use of them cannot meet a delegation ──
{
  const harness = createSqliteVfsTestHarness();
  const raw = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = raw.as(CRED_KERNEL);
  kernel.mkdir('.nimbus/images', { recursive: true });
  kernel.mkdir('home/user', { recursive: true });
  const filesystem = new ProcessFiles(raw);
  const bridge = filesystem.bind({ pid: 11, cred: CRED_KERNEL });
  // The whole filesystem is no lease's root (EINVAL); a store, or a subtree holding one, is not delegated.
  assert.throws(() => bridge.acquireExclusiveMutation('/', { delegate: { reads: true } }), /EINVAL/);
  kernel.mkdir('var/lib', { recursive: true });
  for (const root of ['/.nimbus', '/.nimbus/images', '/var/lib/nimbus/inline-wasm', '/var']) {
    assert.throws(() => bridge.acquireExclusiveMutation(root, { includeMissingAncestors: true, delegate: { reads: true } }), /EPERM/,
      `a delegation of ${root} was granted`);
  }
  const granted = bridge.acquireExclusiveMutation('/home/user', { delegate: { reads: true } });
  bridge.releaseExclusiveMutation(granted.owner);
  // Every store the session uses synchronously lies under one of those roots.
  const under = (path) => SESSION_KERNEL_ROOTS.some((root) => path === root || path.startsWith(`${root}/`));
  for (const store of [DURABLE_IMAGE_DIR, '/var/lib/nimbus/inline-wasm'.slice(1), ...STAGED_BINDINGS.map((binding) => binding.vfsPath.slice(1))]) {
    assert.ok(under(store), `the session's store ${store} is not under a root it never delegates`);
  }
}

console.log('delegation foreign callers: ok');
