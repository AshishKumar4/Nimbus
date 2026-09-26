#!/usr/bin/env bun
// ws.fs, the embedder's handle as the session user, carries the content
// store (Kinu N14-N16): snapshot (quiesced or not), diff by generation,
// restore (only what the session user may write), a read-only view at a
// snapshot, and the paged export/import/digest between workspaces. The tar
// export of the whole tree is gone.

import assert from 'node:assert/strict';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';

const code = async (run) => { try { await run(); return 'ok'; } catch (error) { return error.code ?? error.message; } };
const open = async () => {
  const harness = createSqliteVfsTestHarness();
  return NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
};

const ws = await open();
const fs = ws.fs;
assert.equal('exportSnapshot' in fs, false, 'the tar snapshot is gone');

await fs.mkdir('/home/user/app/src', { recursive: true });
await fs.writeFile('/home/user/app/src/a.txt', 'one');
await fs.writeFile('/home/user/app/b.txt', 'bee');
const first = await fs.snapshot('first', { quiesce: true });
assert.equal(first.name, 'first');
assert.deepEqual((await fs.snapshots()).map((s) => s.name), ['first']);

await fs.writeFile('/home/user/app/src/a.txt', 'two');
await fs.writeFile('/home/user/app/c.txt', 'sea');
await fs.rm('/home/user/app/b.txt');
const changed = [];
for (let after = undefined; ;) {
  const page = await fs.diff('first', null, { after, limit: 2 });
  changed.push(...page.entries.map((e) => `${e.change} ${e.path}`));
  if (page.next === null) break;
  after = page.next;
}
assert.deepEqual(changed.filter((line) => line.includes('/app/')).sort(), [
  'added home/user/app/c.txt', 'modified home/user/app/src/a.txt', 'removed home/user/app/b.txt',
]);

// The read-only view at the snapshot.
const past = fs.at('first');
assert.equal(await past.readFile('/home/user/app/src/a.txt'), 'one');
assert.equal(await code(() => past.writeFile('/home/user/app/x', 'x')), 'EROFS');

// Export the snapshot page by page, import into another workspace, equal digests.
const other = await open();
let after = null;
for (;;) {
  const page = await fs.exportPage({ at: 'first', root: '/home/user/app', after });
  let result = await other.fs.importPage('/home/user/copy', page);
  while (result.want.length > 0) {
    const { chunks } = await fs.exportChunks(result.want);
    result = await other.fs.importPage('/home/user/copy', page, chunks);
  }
  if (page.next === null) break;
  after = page.next;
}
const copy = await other.fs.snapshot('copy');
assert.equal(await other.fs.readFile('/home/user/copy/src/a.txt'), 'one');
assert.equal(
  (await fs.pageDigest({ at: 'first', root: '/home/user/app' })).digest,
  (await other.fs.pageDigest({ at: copy.name, root: '/home/user/copy' })).digest,
  'the same tree digests the same in both workspaces',
);

// Restore brings the tree back, as far as the session user may write.
await fs.restore('first', { subtree: '/home/user/app' });
assert.equal(await fs.readFile('/home/user/app/src/a.txt'), 'one');
assert.equal(await fs.readFile('/home/user/app/b.txt'), 'bee');
assert.equal(await fs.exists('/home/user/app/c.txt'), false);

// A snapshot of a path the user cannot write is not restored through ws.fs.
ws.vfs.as(CRED_KERNEL).writeFile('etc/owned', 'root');
await fs.snapshot('with-root');
ws.vfs.as(CRED_KERNEL).writeFile('etc/owned', 'changed');
assert.equal(await code(() => fs.restore('with-root')), 'EACCES');
assert.equal(ws.vfs.as(CRED_KERNEL).readFileString('etc/owned'), 'changed', 'nothing was restored');

assert.equal(typeof (await fs.storeStats()).chunks, 'number');
await fs.dropSnapshot('first');
assert.deepEqual((await fs.snapshots()).map((s) => s.name), ['with-root']);

await ws.close();
await other.close();
console.log('workspace-fs-content-store: ok');
