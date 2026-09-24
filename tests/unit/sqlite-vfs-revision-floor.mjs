#!/usr/bin/env bun
// Per-path revisions are held under a byte budget. A path whose revision was
// dropped reports the floor, the newest revision dropped, and never less than
// its own last mutation: every consumer compares a revision it holds against
// the one reported now, and a smaller report would call a stale copy current.

import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const BUDGET = 4096;

function openVfs(options = { pathRevisionBytes: BUDGET }) {
  const harness = createSqliteVfsTestHarness();
  const rawVfs = new SqliteVFS(harness.sql, harness.ctx, undefined, options);
  return { harness, rawVfs, vfs: rawVfs.as(CRED_KERNEL) };
}

function ancestors(path) {
  const out = [];
  for (let cut = path.lastIndexOf('/'); cut > 0; cut = path.lastIndexOf('/', cut - 1)) out.push(path.slice(0, cut));
  return out;
}

// ── The map stays within its budget, and nothing reports under its write ──
{
  const { rawVfs, vfs } = openVfs();
  vfs.mkdir('pkg', { recursive: true });
  const lastWrite = new Map();
  const reported = new Map();
  for (let i = 0; i < 400; i++) {
    const path = `pkg/d${i % 20}/file-${i}.js`;
    if (i < 20) vfs.mkdir(`pkg/d${i}`);
    vfs.writeFile(path, `v${i}`);
    lastWrite.set(path, vfs.revision());
    // Every path seen so far: its report never falls, and never below its write.
    for (const [seen, written] of lastWrite) {
      const now = vfs.revision(seen);
      assert.ok(now >= written, `${seen} reports ${now}, below its write at ${written}`);
      assert.ok(now >= (reported.get(seen) ?? 0), `${seen} fell from ${reported.get(seen)} to ${now}`);
      reported.set(seen, now);
    }
  }
  const stats = rawVfs.getStats().pathRevisions;
  assert.ok(stats.bytes <= BUDGET, `${stats.bytes} B of revisions held against a ${BUDGET} B budget`);
  assert.ok(stats.floor > 0, 'the scenario is vacuous unless revisions were dropped');
  assert.ok(stats.paths < lastWrite.size, 'every path still holds a revision');

  // The earliest file was dropped: it reports the floor, and a directory
  // stays at or above everything under it.
  assert.equal(vfs.revision('pkg/d0/file-0.js'), stats.floor);
  for (const path of lastWrite.keys()) {
    for (const dir of ancestors(path)) {
      assert.ok(vfs.revision(dir) >= vfs.revision(path), `${dir} reports below ${path}`);
    }
  }
  assert.equal(vfs.revision(''), vfs.revision(), 'the root is the global clock');

  // Writing a dropped path moves its report past everything it reported.
  const before = vfs.revision('pkg/d0/file-0.js');
  vfs.writeFile('pkg/d0/file-0.js', 'rewritten');
  assert.ok(vfs.revision('pkg/d0/file-0.js') > before);
  assert.equal(vfs.revision('pkg/d0/file-0.js'), vfs.revision());
}

// ── A list page reports what revision() reports ───────────────────────────
// Including for a confined caller's /tmp, whose entries are its own files: the
// page used to look the revision up under the listed name, which for /tmp/x
// is the SHARED file's, and so reported 0 for a private file just written.
{
  const { rawVfs, vfs } = openVfs();
  const guest = { uid: 2001, gid: 2001, groups: [2001], umask: 0o022 };
  vfs.mkdir('tmp', { mode: 0o1777 });
  vfs.mkdir('run/private-2001', { recursive: true });
  vfs.chown('run/private-2001', guest.uid, guest.gid);
  rawVfs.confinePrincipal(guest.uid, 'run/private-2001');
  const confined = rawVfs.as(guest);
  confined.writeFile('/tmp/mine.txt', 'private');
  for (let i = 0; i < 200; i++) vfs.writeFile(`churn-${i}`, 'x');
  confined.writeFile('/tmp/fresh.txt', 'private too');

  const listed = new Map();
  let after = null;
  do {
    const page = confined.list(after, 64);
    for (const entry of page.entries) listed.set(entry.path, entry);
    after = page.next;
  } while (after !== null);
  for (const name of ['tmp/mine.txt', 'tmp/fresh.txt', 'churn-0', 'churn-199']) {
    const entry = listed.get(name);
    assert.ok(entry, `${name} was not listed`);
    assert.equal(entry.rev, confined.revision(name), `${name} listed at a revision revision() does not report`);
    assert.equal(entry.stat.revision, entry.rev);
  }
  assert.ok(listed.get('tmp/fresh.txt').rev > 0, 'a file just written listed at 0');
  assert.ok(rawVfs.getStats().pathRevisions.floor > 0, 'the scenario is vacuous unless revisions were dropped');
}

// ── The default budget is 16 MiB; a negative one is refused ───────────────
{
  const { rawVfs } = openVfs({});
  assert.equal(rawVfs.getStats().pathRevisions.maxBytes, 16 * 1024 * 1024);
  assert.throws(() => openVfs({ pathRevisionBytes: -1 }), /EINVAL/);
}

console.log('sqlite-vfs-revision-floor: ok');
