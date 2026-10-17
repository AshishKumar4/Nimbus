#!/usr/bin/env bun
// A process killed without closing its descriptors lets go of the files they
// held, as a Linux process's exit drops its descriptors' references: an
// unlinked file its descriptor held open is collected once no description
// holds it, as after a close. A description another process still holds
// stays open, and reads through that process as before.
//
// Red before: ProcessFiles.killProcess closed a last description only on a
// mount; the engine's description of an unlinked file stayed open, so its
// content stayed pinned for the engine's life.

import assert from 'node:assert/strict';

import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { processFiles } from './lib/process-bridge.mjs';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const user = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const harness = createSqliteVfsTestHarness();
const engine = new SqliteVFS(harness.sql, harness.ctx);
const kernel = engine.as(CRED_KERNEL);
kernel.mkdir('home/user', { recursive: true });
kernel.chown('home/user', 1000, 1000);
const files = processFiles(engine);
const chunks = () => Number([...harness.sql.exec('SELECT COUNT(*) AS n FROM vfs_chunks')][0].n);
const collected = () => { engine.runContentMaintenance(64); return chunks(); };

/** A file of its own bytes, opened by `pids` (each its own process), then unlinked: the chunk count with it, and its descriptors. */
async function heldUnlinked(name, pids) {
  const before = collected();
  kernel.writeFile(`home/user/${name}`, new TextEncoder().encode(`the bytes of ${name}`));
  const fds = [];
  for (const pid of pids) {
    const proc = files.bind({ pid, cred: user });
    fds.push({ proc, pid, fd: await proc.open(`/home/user/${name}`, { read: true }) });
  }
  kernel.unlink(`home/user/${name}`);
  assert.equal(collected(), before + 1, `${name}: held open, its content stays`);
  return { before, fds };
}

// Killed: its only description closes, and the content goes.
{
  const { before } = await heldUnlinked('one', [7]);
  const { lost } = files.killProcess(7);
  assert.deepEqual(lost, [], 'nothing was buffered');
  assert.equal(collected(), before, 'killed, its unlinked file is collected');
}

// Another process holds it too: still open, still readable there, until that one is killed.
{
  const { before, fds } = await heldUnlinked('two', [8, 9]);
  files.killProcess(8);
  assert.equal(collected(), before + 1, 'another process holds it: it stays');
  const other = fds[1];
  assert.equal(new TextDecoder().decode(await other.proc.read(other.fd.id, 0, 64)), 'the bytes of two', 'and reads there');
  files.killProcess(9);
  assert.equal(collected(), before, 'the last holder killed, it is collected');
}

console.log('kill-releases-descriptions: ok');
