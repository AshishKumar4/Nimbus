#!/usr/bin/env bun
// The VFS view a credentialed command actually receives.
//
// `registerUnixCommands` binds the durable coreutils to a SqliteVFS, but the
// interpreter gives each command ProcessFiles' view of the namespace. The
// coreutils call the same questions of whatever arrives, so both have to
// answer them alike.
//
// They did not. `touch` reads
//
//     if (targetVfs.exists(fp) && !targetVfs.isDirectory(fp)) { … }
//
// and `&&` short-circuits past `isDirectory` whenever the file is absent, so
// creating a file worked and touching an existing one died with
// `targetVfs.isDirectory is not a function`. That is the shape of the whole
// class of bug: a missing method on a shared view is invisible until the
// branch that reaches it is taken.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { memoryFiles } from './lib/test-box.mjs';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { VfsError } from '../../packages/core/src/vfs/vfs-error.ts';
import { readText } from '../../packages/core/src/vfs/vfs.ts';

const dir = mkdtempSync(join(tmpdir(), 'nimbus-cred-vfs-probes-'));

try {
  const db = new Database(join(dir, 'workspace.sqlite'));
  const harness = createSqliteVfsTestHarness(db);
  const ws = await NimbusWorkspace.create({
    sql: harness.sql,
    transactions: harness.ctx,
    generation: 1,
  });

  // ── touch is idempotent, which is the whole point of touch ────────────────
  const created = await ws.exec('touch /home/user/note.txt');
  assert.equal(created.exitCode, 0, `creating touch failed: ${created.stderr}`);
  assert.equal(await readText(ws.fs, '/home/user/note.txt'), '');

  const again = await ws.exec('touch /home/user/note.txt');
  assert.equal(again.stderr, '', 'touching an existing file reports no error');
  assert.equal(again.exitCode, 0, 'touching an existing file succeeds');
  assert.equal(
    await readText(ws.fs, '/home/user/note.txt'),
    '',
    'touch leaves the contents alone',
  );

  const withContent = await ws.exec('printf hello > /home/user/kept.txt && touch /home/user/kept.txt');
  assert.equal(withContent.exitCode, 0, `touch over content failed: ${withContent.stderr}`);
  assert.equal(
    await readText(ws.fs, '/home/user/kept.txt'),
    'hello',
    'touch preserves the bytes of a non-empty file',
  );

  // ── touching a directory is a no-op, not a truncation ─────────────────────
  await ws.exec('mkdir -p /home/user/adir');
  const onDir = await ws.exec('touch /home/user/adir');
  assert.equal(onDir.exitCode, 0, `touch on a directory failed: ${onDir.stderr}`);
  assert.equal(
    (await ws.fs.stat('/home/user/adir')).type,
    'directory',
    'touch does not overwrite a directory with an empty file',
  );

  db.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ── The probes themselves: a structural miss is false, a denial still throws ─
//
// `exists`-then-`isDirectory` is a two-call race in every caller, so the
// probes must answer a missing path rather than throw; but an access denial
// must not be launderable into a quiet `false`, or a traverse-x check becomes
// advisory. This is the same split `SqliteVFS.probeInode` makes.
{
  const { root, view: vfs, files } = memoryFiles();
  root.writeFile('home/user/file.txt', 'x');

  assert.equal(await vfs.isFile('/home/user/file.txt'), true);
  assert.equal(await vfs.isDirectory('/home/user/file.txt'), false);
  assert.equal(await vfs.isDirectory('/home/user'), true);
  assert.equal(await vfs.isFile('/home/user'), false);
  assert.equal(await vfs.isFile('/home/user/absent.txt'), false, 'a missing path is not a file');
  assert.equal(await vfs.isDirectory('/home/user/absent.txt'), false, 'a missing path is not a directory');
  assert.equal(
    await vfs.isDirectory('/home/user/file.txt/under'),
    false,
    'descending through a file is a structural miss, not a throw',
  );

  const locked = new MemoryVFS();
  locked.stat = () => { throw new VfsError('EACCES', 'permission denied'); };
  files.vfs.mount('/mnt/locked', locked);
  await assert.rejects(
    () => vfs.isDirectory('/mnt/locked/thing'),
    /EACCES/,
    'a denial propagates instead of degrading to false',
  );
}

console.log('shell credentialed vfs probes: ok');
