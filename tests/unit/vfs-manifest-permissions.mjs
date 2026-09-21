#!/usr/bin/env bun
// vfs-manifest-permissions — the manifest is the CREDENTIAL'S view, not the
// filesystem's. Every mode it carries is what this uid may do with that path,
// and the walk enforces traversal itself: a directory the credential cannot
// read is listed but never entered, so nothing below it reaches the guest.
//
// This runs the real producer over a real SqliteVFS through the real
// authority, because the property being pinned is a permission decision — a
// fake bridge would only pin the test's own idea of what the authority says.

import assert from 'node:assert/strict';

import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { manifestVfs } from '../../packages/core/src/runtime/vfs-manifest.ts';
import { SqliteFilesystemAuthority } from '../../packages/core/src/runtime/filesystem-authority.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const USER = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000]), umask: 0o022 });

const harness = createSqliteVfsTestHarness();
const raw = new SqliteVFS(harness.sql, harness.ctx);
const root = raw.as(CRED_KERNEL);
const authority = new SqliteFilesystemAuthority(raw);
const bridge = authority.bind({ pid: 11, cred: USER });

try {
  // ── Each mode is this credential's effective mode, nothing wider ─────────
  {
    root.mkdir('workspace', { recursive: true });
    root.chmod('workspace', 0o755);
    root.writeFile('workspace/readable.txt', 'hello\n');
    root.chmod('workspace/readable.txt', 0o644);
    root.writeFile('workspace/unreadable.txt', 'secret\n');
    root.chmod('workspace/unreadable.txt', 0o600);
    root.writeFile('workspace/executable', '#!/bin/sh\n');
    root.chmod('workspace/executable', 0o711);
    root.mkdir('workspace/traverse-only');
    root.writeFile('workspace/traverse-only/hidden.txt', 'hidden\n');
    root.chmod('workspace/traverse-only', 0o711);

    const built = await manifestVfs(bridge, USER, 'workspace', { extraRoots: ['missing'] });
    assert.ok(!('error' in built), `the walk should succeed: ${JSON.stringify(built)}`);
    const { modes, sizes, dirs } = built.snapshot;

    // Everything here is root-owned, so the user reads the OTHER bits: r-x on
    // the workspace, r-- on the readable file, --x on the two 0o711 entries,
    // and nothing at all on the 0o600 one.
    assert.deepEqual(modes, {
      workspace: 5,
      'workspace/executable': 1,
      'workspace/readable.txt': 4,
      'workspace/traverse-only': 1,
      'workspace/unreadable.txt': 0,
    });

    // --x on a directory is traverse, not list: the walk's readdir is denied,
    // so what is inside it must not appear in the manifest at all.
    assert.ok(dirs.includes('workspace/traverse-only'), 'the traverse-only directory is still listed');
    assert.equal(modes['workspace/traverse-only/hidden.txt'], undefined,
      'a file under an unlistable directory must not leak into the manifest');
    assert.equal(sizes['workspace/traverse-only/hidden.txt'], undefined,
      'and neither must its size');

    // A mode-0 file is listed with its size: the consumer denies the read, and
    // hiding the entry would make it look deletable-and-recreatable instead.
    assert.equal(sizes['workspace/unreadable.txt'], 7);

    // An extraRoot that does not exist has no permissions to report.
    assert.equal(modes.missing, undefined, 'a root that does not exist carries no mode');

    console.log('  ok  modes are the credential\'s effective bits, and an unlistable subtree stays out');
  }

  // ── A root under a directory the credential may not enter ────────────────
  {
    root.mkdir('private/workspace', { recursive: true });
    root.writeFile('private/workspace/inner.txt', 'x');
    root.chmod('private', 0o700);

    const built = await manifestVfs(bridge, USER, 'private/workspace', {});
    assert.ok(!('error' in built), `a denied root is not a walk failure: ${JSON.stringify(built)}`);
    const { modes, sizes, dirs } = built.snapshot;

    // The requested root is reported denied rather than omitted: the guest
    // asked for it, so it must see that it exists and is closed to it.
    assert.equal(modes['private/workspace'], 0, 'the requested root is denied, not absent');
    assert.ok(dirs.includes('private/workspace'), 'and it is still listed as a directory');
    assert.deepEqual(sizes, {}, 'nothing under a root the credential cannot reach is enumerated');
    for (const path of Object.keys(modes)) {
      assert.ok(!path.startsWith('private/workspace/'),
        `nothing below the denied root may be listed: ${path}`);
    }

    console.log('  ok  an unreachable root is reported denied, and its contents stay unlisted');
  }
} finally {
  await authority.releaseProcess(11);
  harness.db.close();
}

console.log('vfs-manifest-permissions: all cases passed');
