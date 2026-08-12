#!/usr/bin/env bun
// NimbusWorkspace is the embeddable form of Nimbus: a host supplies SQLite and
// gets `.fs` and `.exec`. This runs it the way an embedder outside Cloudflare
// would — over bun:sqlite, on a real file, with no Durable Object anywhere —
// and asserts the two surfaces actually work and actually share one filesystem.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';

const dir = mkdtempSync(join(tmpdir(), 'nimbus-workspace-'));
const dbPath = join(dir, 'workspace.sqlite');

try {
  let db = new Database(dbPath);
  let harness = createSqliteVfsTestHarness(db);
  let ws = await NimbusWorkspace.create({
    sql: harness.sql,
    transactions: harness.ctx,
    generation: 1,
  });

  // ── .fs works, and is credentialed as the session user ──────────────────
  await ws.fs.writeFile('/home/user/hello.txt', 'from fs\n');
  assert.equal(await ws.fs.readFile('/home/user/hello.txt'), 'from fs\n');
  assert.equal(await ws.fs.exists('/home/user/hello.txt'), true);

  const stat = await ws.fs.stat('/home/user/hello.txt');
  assert.equal(stat.type, 'file');
  assert.equal(stat.size, 8);

  // A pid-less host caller must not act as the kernel: os-contracts.ts states
  // CRED_SESSION_USER is the embedder-facing credential.
  const owner = ws.vfs.as({ uid: 0, gid: 0, groups: [0], umask: 0o022 }).stat('/home/user/hello.txt');
  assert.equal(owner.uid, 1000, 'file written through .fs is owned by the session user, not root');

  // ── .exec works, and sees the same filesystem .fs wrote to ──────────────
  const cat = await ws.exec('cat /home/user/hello.txt');
  assert.equal(cat.exitCode, 0, `cat failed: ${cat.stderr}`);
  assert.equal(cat.stdout, 'from fs\n');

  // ...and the reverse direction: the shell writes, .fs reads.
  const wrote = await ws.exec('echo from-shell > /home/user/shell.txt');
  assert.equal(wrote.exitCode, 0, `redirect failed: ${wrote.stderr}`);
  assert.equal(await ws.fs.readFile('/home/user/shell.txt'), 'from-shell\n');

  // Real coreutils, not stubs: a pipeline through three of them.
  const pipeline = await ws.exec("printf 'b\\na\\nb\\n' | sort | uniq -c | wc -l");
  assert.equal(pipeline.exitCode, 0, `pipeline failed: ${pipeline.stderr}`);
  assert.equal(pipeline.stdout.trim(), '2');

  // /etc/passwd is load-bearing, not decoration: `id` resolves 1000 to a NAME
  // through it, which only works if the seeded file is real and readable.
  const id = await ws.exec('id');
  assert.equal(id.exitCode, 0, `id failed: ${id.stderr}`);
  assert.match(id.stdout, /1000\(user\)/);

  // The shell's own view of the tree agrees with .fs.
  const ls = await ws.exec('ls /home/user');
  assert.match(ls.stdout, /hello\.txt/);
  assert.match(ls.stdout, /shell\.txt/);

  const stats = ws.stats();
  assert.ok(stats.files >= 2, `expected the two files to be counted, got ${stats.files}`);
  assert.ok(stats.usedBytes > 0);

  // ── Durability: close, reopen, and a NEW workspace sees the same disk ───
  db.close();

  db = new Database(dbPath);
  harness = createSqliteVfsTestHarness(db);
  ws = await NimbusWorkspace.create({
    sql: harness.sql,
    transactions: harness.ctx,
    generation: 2,
  });

  assert.equal(await ws.fs.readFile('/home/user/hello.txt'), 'from fs\n');
  const reread = await ws.exec('cat /home/user/shell.txt');
  assert.equal(reread.exitCode, 0, `cat after reopen failed: ${reread.stderr}`);
  assert.equal(reread.stdout, 'from-shell\n');

  // The account files are root-owned 0644, so a host calling `.fs` — which has
  // no process behind it — must NOT be able to rewrite who uid 1000 is.
  await assert.rejects(
    () => ws.fs.writeFile('/etc/passwd', 'root:x:0:0:root:/root:/bin/sh\n'),
    /permission|denied|EACCES/i,
    '.fs rewrote root-owned /etc/passwd',
  );

  // Reopening must not clobber the user's own files.
  await ws.fs.writeFile('/home/user/keep.txt', 'survives\n');
  db.close();

  db = new Database(dbPath);
  harness = createSqliteVfsTestHarness(db);
  ws = await NimbusWorkspace.create({
    sql: harness.sql,
    transactions: harness.ctx,
    generation: 3,
  });
  assert.equal(await ws.fs.readFile('/home/user/keep.txt'), 'survives\n');

  // ── destroy() removes the workspace, not the host's database ────────────
  // The host owns this Durable Object; the workspace is a tenant in it. A
  // destroy that reached for deleteAll would take the host's data with it.
  db.run("CREATE TABLE proteus_sessions (id TEXT PRIMARY KEY, payload TEXT)");
  db.run("INSERT INTO proteus_sessions VALUES ('s1', 'host-owned')");

  ws.destroy();

  const hostRows = db.query('SELECT payload FROM proteus_sessions').all();
  assert.deepEqual(hostRows, [{ payload: 'host-owned' }], 'destroy() ate the host table');

  const left = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND (name='inodes' OR name LIKE 'vfs_%')")
    .all();
  assert.deepEqual(left, [], `destroy() left workspace tables behind: ${JSON.stringify(left)}`);

  db.close();
  console.log('nimbus-workspace-embedded: all assertions passed');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
