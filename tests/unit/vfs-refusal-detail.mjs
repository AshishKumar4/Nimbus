#!/usr/bin/env bun
// A refusal keeps its own words through every layer that rewords it for its
// call, and path normalization clamps `..` at the root.
//
// Kinu ask 11: a confined principal's widening chmod is refused with "mode
// change would grant permission outside your own principal; use u+x", but
// toVfsError rebuilt it as a bare "EPERM: operation not permitted, chmod",
// so the agent lost the spelling that works.
// Kinu ask 12: normalizeVfsPath('/../home/main/SOUL.md') kept the leading
// `..`, where POSIX and Composite's own normalizePath clamp at `/`.

import assert from 'node:assert/strict';

import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { sqliteFiles } from '../../packages/core/src/vfs/sqlite-files.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { normalizeVfsPath, resolveVfsPath } from '../../packages/core/src/vfs/path.ts';
import { normalizePath } from '../../packages/core/src/vfs/composite.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

// ── A refusal's reason survives the rewording ───────────────────────────
{
  const A = Object.freeze({ uid: 5001, gid: 5001, groups: Object.freeze([5001]), umask: 0o022 });
  const harness = createSqliteVfsTestHarness();
  const raw = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = raw.as(CRED_KERNEL);
  kernel.mkdir('home/agent-a', { recursive: true, mode: 0o700 });
  kernel.chown('home/agent-a', A.uid, A.gid);
  raw.confinePrincipal(A.uid, 'home/agent-a');
  const a = raw.as(A);
  a.writeFile('/home/agent-a/s.sh', 'echo hi\n', { mode: 0o644 });

  // The engine's own words, reworded for the call by its VFS face.
  const files = sqliteFiles(raw, A);
  assert.throws(
    () => files.chmod('/home/agent-a/s.sh', 0o755),
    (error) => {
      assert.equal(error.code, 'EPERM');
      assert.equal(error.syscall, 'chmod');
      assert.equal(error.path, '/home/agent-a/s.sh');
      assert.match(error.message, /mode change would grant permission outside your own principal; use u\+x, chmod '\/home\/agent-a\/s\.sh'$/);
      return true;
    },
    'a widening chmod is refused with the spelling that works',
  );
  files.chmod('/home/agent-a/s.sh', 0o744);
  assert.equal(kernel.stat('home/agent-a/s.sh').mode & 0o777, 0o744, 'u+x works');
}

// ── `..` stops at the root ────────────────────────────────────────────────
assert.equal(normalizeVfsPath('/../home/main/SOUL.md'), 'home/main/SOUL.md');
assert.equal(normalizeVfsPath('../../a'), 'a');
assert.equal(normalizeVfsPath('/a/../../b'), 'b');
assert.equal(normalizeVfsPath('/..'), '');
assert.equal(resolveVfsPath('/a/../../b', '/home/user'), 'b');
assert.equal(resolveVfsPath('../../../x', '/home/user'), 'x');
assert.equal(normalizePath('/../home/main/SOUL.md'), '/home/main/SOUL.md', 'Composite agrees');
for (const path of ['/a/b/../c', '/../x', 'a//b/./c/', '/..', '../..', '/a/b/../../..']) {
  assert.equal(normalizePath(path), `/${normalizeVfsPath(path)}`, `one normalizer: ${path}`);
}

console.log('vfs-refusal-detail: ok');
