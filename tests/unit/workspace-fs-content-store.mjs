#!/usr/bin/env bun
// The content store (Kinu N14-N16) is the embedder's, with kernel authority:
// it lives on ws.vfs, the workspace's SQLite filesystem. ws.fs (the session
// user's view) and every per-credential handle carry only its diagnostic,
// so nothing a user holds can read past permissions, forge ownership, or
// undo a change through a snapshot. On ws.vfs it round-trips: snapshot,
// paged diff, a view at a snapshot, restore, and the paged export/import
// between workspaces, where the importer keeps the exported ownership.
// A quiesced snapshot waits for spanning work (a restore in slices) and
// never captures it half-done.

import assert from 'node:assert/strict';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { encodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';

const STORE_OPS = ['snapshot', 'snapshots', 'dropSnapshot', 'diff', 'at', 'restore', 'exportPage', 'exportChunks', 'importPage', 'pageDigest', 'exportSnapshot', 'importSnapshot'];
const USER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const text = (bytes) => new TextDecoder().decode(bytes);
const open = async () => {
  const harness = createSqliteVfsTestHarness();
  return NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
};

const ws = await open();
const store = ws.vfs;
const kernel = store.as(CRED_KERNEL);

// Nothing a user holds carries the store.
for (const op of STORE_OPS) assert.equal(op in ws.fs, false, `ws.fs.${op}`);
assert.equal(typeof (await ws.fs.storeStats()).chunks, 'number', 'the diagnostic stays');

// A root-only file stays root's: a user never reaches the store to export it.
kernel.mkdir('root', { mode: 0o700 });
kernel.writeFile('root/secret', 'TOP SECRET');
kernel.chmod('root/secret', 0o600);

kernel.mkdir('home/user/app/src', { recursive: true });
kernel.writeFile('home/user/app/src/a.txt', 'one');
kernel.writeFile('home/user/app/b.txt', 'bee');
kernel.mkdir('opt/src', { recursive: true });
kernel.writeFile('opt/src/su', 'binary');
kernel.chmod('opt/src/su', 0o4755);
assert.equal((await store.snapshot('first', { quiesce: true })).name, 'first');
assert.deepEqual(store.snapshots().map((s) => s.name), ['first']);

kernel.writeFile('home/user/app/src/a.txt', 'two');
kernel.writeFile('home/user/app/c.txt', 'sea');
kernel.unlink('home/user/app/b.txt');
const changed = [];
for (let after; ;) {
  const page = store.diff('first', null, { after, limit: 2 });
  changed.push(...page.entries.map((e) => `${e.change} ${e.path}`));
  if (page.next === null) break;
  after = page.next;
}
assert.deepEqual(changed.filter((line) => line.includes('/app/')).sort(), [
  'added home/user/app/c.txt', 'modified home/user/app/src/a.txt', 'removed home/user/app/b.txt',
]);
assert.equal(store.at('first').readFileString('home/user/app/src/a.txt'), 'one');
assert.throws(() => store.at('first', USER).readFile('root/secret'), { code: 'EACCES' }, 'a view at a snapshot keeps permissions');

// Export into another workspace: the kernel's import keeps ownership and mode.
const other = await open();
const copyOf = async (root, dst) => {
  for (let after = null; ;) {
    const page = store.exportPage({ at: 'first', root, after });
    let result = other.vfs.importPage(dst, page);
    while (result.want.length > 0) result = other.vfs.importPage(dst, page, store.exportChunks(result.want).chunks);
    if (page.next === null) return;
    after = page.next;
  }
};
await copyOf('home/user/app', 'home/user/copy');
await copyOf('opt/src', 'opt/copy');
const copy = other.vfs.snapshot('copy');
assert.equal(other.vfs.as(CRED_KERNEL).readFileString('home/user/copy/src/a.txt'), 'one');
const su = other.vfs.as(CRED_KERNEL).stat('opt/copy/su');
assert.deepEqual([su.uid, (su.mode & 0o7777).toString(8)], [0, '4755'], 'the kernel import keeps ownership, exactly as before');
assert.equal(
  store.pageDigest({ at: 'first', root: 'home/user/app' }).digest,
  other.vfs.pageDigest({ at: copy.name, root: 'home/user/copy' }).digest,
  'the same tree digests the same in both workspaces',
);

// Restore, as the embedder.
await store.restoreAsync('first', { subtree: 'home/user/app' });
assert.equal(kernel.readFileString('home/user/app/src/a.txt'), 'one');
assert.equal(kernel.readFileString('home/user/app/b.txt'), 'bee');
assert.equal(kernel.exists('home/user/app/c.txt'), false);

// A quiesced snapshot waits for a restore in slices; the tree it pins is whole.
const N = 3000;
kernel.mkdir('home/user/p');
for (let i = 0; i < N; i++) kernel.writeFile(`home/user/p/f${i}`, 'A');
store.snapshot('base');
for (let i = 0; i < N; i++) kernel.writeFile(`home/user/p/f${i}`, 'B');
const restoring = store.restoreAsync('base', { subtree: 'home/user/p' });
const mid = await store.snapshot('mid', { quiesce: true });
await restoring;
const view = store.at(mid.name);
const seen = new Set();
for (let i = 0; i < N; i++) seen.add(view.readFileString(`home/user/p/f${i}`));
assert.deepEqual([...seen], ['A'], 'the snapshot waited for the restore: never a torn tree');
// Work that starts while a quiesced snapshot waits runs after it is taken.
kernel.writeFile('home/user/app/src/a.txt', 'three');
const lease = store.acquireExclusiveMutation('home/user/p');
let taken = false;
const waiting = store.snapshot('held', { quiesce: true }).then((snap) => { taken = true; return snap; });
const late = store.restoreAsync('first', { subtree: 'home/user/app' });
for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(taken, false, 'a held lease is waited out, not refused');
store.releaseExclusiveMutation(lease.owner);
await waiting;
await late;
assert.equal(store.at('held').readFileString('home/user/app/src/a.txt'), 'three', 'the restore that started meanwhile ran after the snapshot');
assert.equal(kernel.readFileString('home/user/app/src/a.txt'), 'one');

// A clone's shape: it holds its lease and streams its batches under it. The
// snapshot waits for the lease, so the clone's own streams must not be held
// behind the snapshot, or neither ever finishes. A lease taken after the
// snapshot started waiting, whose owner then streams, is the same.
{
  const f = (path) => ({ path, parentPath: path.slice(0, path.lastIndexOf('/')), isDir: false, size: 1, mtime: 1, mode: 0o644, chunkCount: 1 });
  const batch = (path, data) => encodeWriteBatchStream({ inodes: [f(path)], chunks: [{ path, chunkId: 0, data: new TextEncoder().encode(data) }] });
  kernel.mkdir('home/user/repo');
  const clone = async (lease) => {
    await kernel.writeStream(batch('home/user/repo/a', '1'), { mutationOwner: lease.owner });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await kernel.writeStream(batch('home/user/repo/b', '2'), { mutationOwner: lease.owner });
    store.releaseExclusiveMutation(lease.owner);
  };
  const within = (promise, what) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`deadlock: ${what}`)), 3000))]);
  const early = clone(store.acquireExclusiveMutation('home/user/repo'));
  await new Promise((resolve) => setTimeout(resolve, 1));
  const pinned = store.snapshot('mid-clone', { quiesce: true });
  await within(Promise.all([early, pinned]), 'a lease taken before the snapshot');
  assert.equal(store.at('mid-clone').readFileString('home/user/repo/b'), '2', 'the pin waited for the whole clone');

  kernel.removeRecursive('home/user/repo');
  kernel.mkdir('home/user/repo');
  kernel.writeFile('home/user/other', 'x');
  const holder = store.acquireExclusiveMutation('home/user/other');
  const waiting = store.snapshot('late-lease', { quiesce: true });
  const lateClone = clone(store.acquireExclusiveMutation('home/user/repo'));
  const unrelated = kernel.writeStream(batch('home/user/unrelated', 'u'));
  store.releaseExclusiveMutation(holder.owner);
  await within(Promise.all([lateClone, waiting, unrelated]), 'a lease taken after the snapshot started waiting');
  assert.equal(store.at('late-lease').exists('home/user/unrelated'), false, 'unowned work was held until the pin');
}

// FormalModelsLane's two proved deadlock shapes (CS-008 hypothesis WF), made
// impossible by construction: a lease holder that awaits a copy or a
// restore passes its owner, and that work is never held.
{
  kernel.mkdir('home/user/leased/src', { recursive: true });
  kernel.writeFile('home/user/leased/src/f', 'copied');
  kernel.writeFile('home/user/leased/r', 'before');
  store.snapshot('leased-base');
  kernel.writeFile('home/user/leased/r', 'after');
  const within = (promise, what) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`deadlock: ${what}`)), 3000))]);
  const lease = store.acquireExclusiveMutation('home/user/leased');
  const holder = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    await kernel.copyTreeAsync('home/user/leased/src', 'home/user/leased/dst', { mutationOwner: lease.owner });
    await store.restoreAsync('leased-base', { subtree: 'home/user/leased/r', mutationOwner: lease.owner });
    store.releaseExclusiveMutation(lease.owner);
  })();
  const pinned = store.snapshot('leased-pin', { quiesce: true });
  await within(Promise.all([holder, pinned]), 'a lease holder awaiting its copy and restore');
  const view = store.at('leased-pin');
  assert.equal(view.readFileString('home/user/leased/dst/f'), 'copied');
  assert.equal(view.readFileString('home/user/leased/r'), 'before', 'the pin waited for the holder');
  // A full restore under the caller's own global lease; another's lease still refuses it.
  kernel.writeFile('home/user/leased/r', 'again');
  const global = store.acquireGlobalExclusiveMutation();
  assert.equal((await store.restoreAsync('leased-base', { mutationOwner: global.owner })).restored > 0, true);
  assert.equal(kernel.readFileString('home/user/leased/r'), 'before');
  store.releaseExclusiveMutation(global.owner);
  const someone = store.acquireExclusiveMutation('home/user/leased');
  const mine = store.acquireExclusiveMutation('home/user/p');
  await assert.rejects(() => store.restoreAsync('leased-base', { mutationOwner: mine.owner }), { code: 'EBUSY' });
  store.releaseExclusiveMutation(someone.owner);
  store.releaseExclusiveMutation(mine.owner);
  // An owner that is not live is refused, not trusted to bypass the gate.
  await assert.rejects(() => store.restoreAsync('leased-base', { subtree: 'home/user/leased/r', mutationOwner: lease.owner }), { code: 'ESTALE' });
}

store.dropSnapshot('first');
assert.equal(store.snapshots().some((s) => s.name === 'first'), false);

await ws.close();
await other.close();
console.log('workspace-fs-content-store: ok');
