#!/usr/bin/env bun
// A process killed without closing its descriptors lets go of the files they
// held, as a Linux process's exit drops its descriptors' references: an
// unlinked file its descriptor held open is collected once no description
// holds it, as after a close. A description another process still holds
// stays open, and reads through that process as before. What a write
// through the killed process's description already put in the file is the
// file's, under a delegation the process held as well.
//
// Red before: ProcessFiles.killProcess closed a last description only on a
// mount; the engine's description of an unlinked file stayed open, so its
// content stayed pinned for the engine's life.
// (And closing it after the process's delegations ended lost its held
// appends: written as another's, they were recalled from it.)

import assert from 'node:assert/strict';

import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { createSupervisorOpHandler } from '../../packages/core/src/workspace/supervisor-op.ts';
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

// Appends through its description, under its own delegation, then killed: they are the file's.
{
  const h = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(h.sql, h.ctx);
  const k = vfs.as(CRED_KERNEL);
  k.mkdir('home/user/repo', { recursive: true });
  k.chown('home/user', 1000, 1000);
  k.chown('home/user/repo', 1000, 1000);
  const filesystem = new ProcessFiles(vfs);
  const pid = 4242;
  const proc = filesystem.bind({ pid, cred: user });
  const op = createSupervisorOpHandler({ vfs, filesystem });
  const grant = await op({ op: 'fsAcquireExclusiveMutation', args: ['/home/user/repo', { delegate: { reads: true } }], pid });
  assert.ok(grant.owner, 'the process holds the subtree');
  // Its appends are held (no lease presented: the engine holds a run of them), to be written with its delegation.
  const fd = proc.open('/home/user/repo/log', { write: true, append: true, create: true });
  for (const line of ['one\n', 'two\n']) proc.write(fd.id, null, new TextEncoder().encode(line));
  filesystem.killProcess(pid);
  assert.equal(new TextDecoder().decode(k.readFile('home/user/repo/log')), 'one\ntwo\n', 'its appends are the file\'s');
  assert.equal(filesystem.delegations.size, 0, 'its delegation ended with it');
  h.db.close();
}

console.log('kill-releases-descriptions: ok');
