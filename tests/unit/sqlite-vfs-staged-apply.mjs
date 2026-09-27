#!/usr/bin/env bun
// Caller-owned, replayable publication of a changed-row import; not an all-files transaction.
import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const sourceDb = createSqliteVfsTestHarness(), targetDb = createSqliteVfsTestHarness();
try {
  const source = new SqliteVFS(sourceDb.sql, sourceDb.ctx), src = source.as(CRED_KERNEL);
  let target = new SqliteVFS(targetDb.sql, targetDb.ctx), dst = target.as(CRED_KERNEL);
  src.mkdir('tree/nested', { recursive: true }); src.mkdir('tree/dir-to-file'); src.mkdir('tree/meta');
  for (const [path, text] of Object.entries({ keep: 'shared unchanged bytes', 'nested/keep': 'untouched nested', 'nested/edit': 'before', 'file-to-dir': 'old file', 'dir-to-file/old': 'old child', gone: 'removed' })) src.writeFile(`tree/${path}`, text);
  source.snapshot('base');
  const initial = source.exportPage({ at: 'base', root: 'tree' });
  const initialChunks = source.exportChunks(target.wantChunks(initial));
  assert.equal(target.importPage('tree', initial, initialChunks.chunks).done, true);
  const untouched = ['tree/keep', 'tree/nested/keep'].map((path) => [path, dst.stat(path).ino, dst.contentKey(path)]);
  src.writeFile('tree/nested/edit', 'after'); src.writeFile('tree/same-content', 'shared unchanged bytes');
  src.unlink('tree/file-to-dir'); src.mkdir('tree/file-to-dir'); src.writeFile('tree/file-to-dir/new', 'new child');
  src.removeRecursive('tree/dir-to-file'); src.writeFile('tree/dir-to-file', 'new file');
  src.unlink('tree/gone'); src.chmod('tree/meta', 0o750); src.chown('tree/meta', 1001, 1002); src.utimes('tree/meta', 11, 22);
  src.setDefaultAcl('tree/meta', 0o770);
  src.chmod('tree/nested/edit', 0o640); src.utimes('tree/nested/edit', 33, 44);
  source.snapshot('head');
  const changes = source.diff('base', 'head').entries;
  const fingerprint = (view, path) => {
    if (!view.exists(path)) return null;
    const stat = view.lstat(path);
    return { type: stat.type, mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid, mtime: stat.mtime,
      defaultAcl: stat.type === 'directory' ? view.getDefaultAcl(path) : null,
      key: stat.type === 'directory' ? null : view.contentKey(path) };
  };
  const before = new Map(changes.map(({ path }) => [path, fingerprint(dst, path)]));
  const expected = new Map(changes.map(({ path }) => [path, fingerprint(source.at('head'), path)]));
  const expectedRevision = dst.revision('tree');

  // Export only named changed rows and their parents, never the unchanged file bodies.
  const paths = new Set(['tree']);
  for (const change of changes) if (change.change !== 'removed') {
    for (let path = change.path; path; path = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '') paths.add(path);
  }
  const rows = [...paths].sort().map((path) => {
    const row = source.exportPage({ at: 'head', root: path, limit: 1 }).rows[0];
    return { ...row, path: path === 'tree' ? '' : path.slice('tree/'.length) };
  });
  const page = { schema: initial.schema, root: 'tree', nextIno: source.exportPage({ at: 'head', root: 'tree', limit: 1 }).nextIno, after: null, rows, next: null };
  const wanted = target.wantChunks(page);
  const transferred = source.exportChunks(wanted);
  assert.equal(transferred.rest.length, 0);
  assert.equal(transferred.chunks.reduce((n, chunk) => n + chunk.data.byteLength, 0), 5 + 9 + 8);
  assert.equal(target.importPage('stage', page, transferred.chunks).done, true);
  const ordered = [...changes].sort((a, b) => {
    if ((a.change === 'removed') !== (b.change === 'removed')) return a.change === 'removed' ? -1 : 1;
    if (a.change === 'removed') return b.path.length - a.path.length;
    if ((a.type === 'directory') !== (b.type === 'directory')) return a.type === 'directory' ? -1 : 1;
    return a.path.length - b.path.length;
  });
  function publish(interruptAfter, first) {
    const lease = target.acquireGlobalExclusiveMutation();
    const own = target.as(CRED_KERNEL, { mutationOwner: lease.owner });
    try {
      if (first) assert.equal(dst.revision('tree'), expectedRevision, 'revalidate the target after staging, before publishing');
      for (let index = 0; index < ordered.length; index++) {
        const { path, change, type } = ordered[index];
        const current = fingerprint(dst, path), final = expected.get(path);
        if (JSON.stringify(current) !== JSON.stringify(final)) {
          assert.deepEqual(current, before.get(path), `a peer changed ${path}; refuse before overwriting`);
          if (change === 'removed') {
            if (type === 'directory') own.removeRecursive(path); else own.unlink(path);
          } else {
            const staged = `stage/${path.slice('tree/'.length)}`;
            if (current && current.type !== type) {
              if (current.type === 'directory') own.removeRecursive(path); else own.unlink(path);
            }
            if (type === 'directory') {
              if (!own.exists(path)) own.mkdir(path);
            } else own.rename(staged, path);
            const metadata = rows.find((row) => row.path === path.slice('tree/'.length));
            own.chmod(path, metadata.mode); own.chown(path, metadata.uid, metadata.gid); own.utimes(path, metadata.atime, metadata.mtime);
            if (type === 'directory') own.setDefaultAcl(path, metadata.defaultAcl);
          }
        }
        if (index + 1 === interruptAfter) throw new Error('caller interrupted after committed prefix');
      }
    } finally { target.releaseExclusiveMutation(lease.owner); }
  }
  assert.throws(() => publish(3, true), /committed prefix/);
  // A restart leaves the caller's saved plan and the staging tree usable; replay completed rows harmlessly.
  target = new SqliteVFS(targetDb.sql, targetDb.ctx); dst = target.as(CRED_KERNEL);
  publish(Infinity, false);
  publish(Infinity, false);
  for (const { path } of changes) assert.deepEqual(fingerprint(dst, path), expected.get(path));
  for (const [path, ino, key] of untouched) {
    assert.equal(dst.stat(path).ino, ino); assert.equal(dst.contentKey(path), key);
  }
  assert.equal(dst.readFileString('tree/file-to-dir/new'), 'new child');
  assert.equal(dst.readFileString('tree/dir-to-file'), 'new file');
  assert.equal(dst.readFileString('tree/nested/edit'), 'after');
  dst.removeRecursive('stage');
} finally { sourceDb.db.close(); targetDb.db.close(); }
console.log('sqlite-vfs-staged-apply: 22 missing bytes; nested type/metadata changes and prefix replay preserve untouched inodes/content');
