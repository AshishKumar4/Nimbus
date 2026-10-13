#!/usr/bin/env bun
// /usr is laid out as on Linux. /usr, /usr/bin, /usr/lib and /usr/share, and
// the global module folders below them, are root's; /usr/local is the session
// user's, so `npm i -g` needs no sudo. /etc/profile, /etc/hostname and
// /etc/os-release are root's 0644. `nimbus install` does apt's job: a runtime's
// tree lands in /usr/lib/nimbus/<name>/<version>, owned by root, and each of
// its commands gets a launcher in /usr/bin, a link into the tree that runs it
// by path as by name. A session an earlier release made moves over once, as
// the kernel: those directories become root's, without what users put in
// them, and its runtimes move from ~/.nimbus/runtimes into the store, a link
// left at the old path. Red before: all of these were the session user's,
// and runtimes lived below HOME.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const encoder = new TextEncoder();
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const USER = CRED_SESSION_USER.uid;

/** A runtime package whose one command is `toy`, run by `runner`. */
function toyPackage({ name = 'toy', version = '1.0.0', runner = 'toy-runner' } = {}) {
  const contents = { 'bin/toy': '# toy launcher marker\n', 'share/toy/data': 'data\n' };
  const files = Object.entries(contents).map(([path, text], i) => ({
    path, content: `blobs/toy/${i}`, sha256: sha256(encoder.encode(text)), size: encoder.encode(text).length,
    ...(path.startsWith('bin/') ? { mode: 'exec' } : {}),
  }));
  const blobs = new Map(files.map((file, i) => [file.content, encoder.encode(Object.values(contents)[i])]));
  return {
    manifest: {
      name, version, license: 'MIT', wasi_namespace: 'wasi_snapshot_preview1', files,
      entrypoints: [{ binName: 'toy', runner, args: [] }],
    },
    readBlob: (file) => blobs.get(file.content),
  };
}

async function open(db, options = {}) {
  const harness = createSqliteVfsTestHarness(db);
  const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, generation: 1, ...options });
  ws.runtimes.registerRunner('toy-runner', (_manifest, root, binName) => async (ctx) => {
    ctx.stdout.write(`ran ${binName} from ${root}\n`);
    return 0;
  });
  // As a host that binds runners after create does: what is installed is bound now.
  await ws.runtimes.rehydrate();
  return ws;
}
const owner = (fs, path) => { const st = fs.lstat(path); return [st.type, st.uid, st.gid, st.mode & 0o7777]; };
const ROOTS = ['usr', 'usr/bin', 'usr/lib', 'usr/share', 'usr/lib/node_modules', 'usr/share/pkg', 'usr/share/pkg/node_modules'];
const USERS = ['usr/local', 'usr/local/lib', 'usr/local/lib/node_modules', 'usr/local/bin'];
const ETC = ['etc/profile', 'etc/hostname', 'etc/os-release'];

// ── a fresh session ───────────────────────────────────────────────────────
{
  const db = new Database(':memory:');
  const ws = await open(db);
  const kernel = ws.vfs.as(CRED_KERNEL);
  for (const dir of ROOTS) assert.deepEqual(owner(kernel, dir), ['directory', 0, 0, 0o755], `${dir} is root's`);
  for (const dir of USERS) assert.deepEqual(owner(kernel, dir).slice(0, 3), ['directory', USER, USER], `${dir} is the user's`);
  for (const file of ETC) assert.deepEqual(owner(kernel, file), ['file', 0, 0, 0o644], `${file} is root's 0644`);

  const denied = await ws.exec('touch /usr/bin/mine');
  assert.notEqual(denied.exitCode, 0, 'the user cannot write into /usr/bin');
  assert.match(denied.stderr, /Permission denied|EACCES/);
  const allowed = await ws.exec('touch /usr/local/bin/mine && echo ok');
  assert.equal(allowed.stdout, 'ok\n', allowed.stderr);

  // nimbus install: the tree in the store, a launcher in /usr/bin.
  const installed = await ws.runtimes.installPackage(toyPackage());
  assert.equal(installed.root, 'usr/lib/nimbus/toy/1.0.0');
  assert.deepEqual(owner(kernel, 'usr/lib/nimbus').slice(0, 3), ['directory', 0, 0]);
  assert.equal(kernel.lstat('usr/lib/nimbus/toy/1.0.0/share/toy/data').uid, 0, 'the tree is root\'s');
  assert.equal(kernel.lstat('usr/bin/toy').type, 'symlink', 'the launcher is a link');
  assert.equal(kernel.readlink('usr/bin/toy'), '/usr/lib/nimbus/toy/1.0.0/bin/toy');
  assert.equal(kernel.exists('home/user/.nimbus/runtimes'), false, 'nothing below HOME');
  assert.equal((await ws.exec('toy')).stdout, 'ran toy from usr/lib/nimbus/toy/1.0.0\n');
  assert.equal((await ws.exec('/usr/bin/toy')).stdout, 'ran toy from usr/lib/nimbus/toy/1.0.0\n', 'the launcher runs it by path');
  // Its target keeps the mode it was installed with: a marker, not a program
  // a guest Bash could run as a script.
  assert.equal(kernel.stat('usr/lib/nimbus/toy/1.0.0/bin/toy').mode & 0o111, 0, 'the marker is not made executable');

  // A file someone put at a launcher's name is never replaced, and runs as itself.
  kernel.unlink('usr/bin/toy');
  kernel.writeFile('usr/bin/toy', 'echo mine\n', { mode: 0o755 });
  await ws.runtimes.installPackage(toyPackage(), { force: true });
  assert.equal(kernel.lstat('usr/bin/toy').type, 'file', 'a file at the launcher\'s name is left');
  const itself = await ws.exec('/usr/bin/toy');
  assert.equal(itself.stdout, 'mine\n', `and runs as itself: ${itself.exitCode} ${itself.stderr}`);
  assert.equal((await ws.exec('toy')).stdout, 'ran toy from usr/lib/nimbus/toy/1.0.0\n', 'the name still runs the runtime');
  kernel.unlink('usr/bin/toy');
  await ws.runtimes.installPackage(toyPackage(), { force: true });

  // Two versions installed at once: one launcher, the version its name runs.
  await Promise.all([
    ws.runtimes.installPackage(toyPackage({ version: '2.0.0' })),
    ws.runtimes.installPackage(toyPackage({ version: '3.0.0' })),
  ]);
  const serving = (await ws.exec('toy')).stdout.trim().split(' from ')[1];
  assert.equal(kernel.readlink('usr/bin/toy'), `/${serving}/bin/toy`, 'the launcher leads to the version the name runs');
  assert.equal((await ws.exec('/usr/bin/toy')).stdout, `ran toy from ${serving}\n`);
  await ws.exec('nimbus uninstall toy@2.0.0');
  await ws.exec('nimbus uninstall toy@3.0.0');

  // A package whose runner this workspace lacks links no launcher.
  await ws.runtimes.installPackage(toyPackage({ name: 'retired', runner: 'retired-runner' }));
  assert.equal(kernel.readlink('usr/bin/toy'), '/usr/lib/nimbus/toy/1.0.0/bin/toy', 'a runtime nothing runs takes no launcher');

  // Uninstall takes the launcher with it.
  const removed = await ws.exec('nimbus uninstall toy');
  assert.equal(removed.exitCode, 0, removed.stderr);
  assert.equal(kernel.exists('usr/lib/nimbus/toy'), false);
  assert.equal(kernel.statIfPresent('usr/bin/toy', false), null, 'the launcher goes with it');
  db.close();
  console.log('  a fresh session is laid out as on Linux, and installs as apt does');
}

// ── a session an earlier release made moves over, once ────────────────────
{
  const db = new Database(':memory:');
  const first = await open(db);
  const kernel0 = first.vfs.as(CRED_KERNEL);
  // As an earlier release left it: the directories the user's, the profile
  // too, a runtime installed below HOME, and a package of the user's own in
  // the global folder.
  for (const dir of [...ROOTS].reverse()) kernel0.chown(dir, USER, USER);
  for (const file of ETC) kernel0.chown(file, USER, USER);
  kernel0.mkdir('usr/lib/node_modules/mine', { mode: 0o755 });
  kernel0.chown('usr/lib/node_modules/mine', USER, USER);
  kernel0.writeFile('etc/profile', 'export PATH=/opt/mine:$PATH\n');
  const pkg = toyPackage();
  const old = 'home/user/.nimbus/runtimes/toy/1.0.0';
  kernel0.mkdir(`${old}/bin`, { recursive: true, mode: 0o755 });
  kernel0.mkdir(`${old}/share/toy`, { recursive: true, mode: 0o755 });
  for (const file of pkg.manifest.files) kernel0.writeFile(`${old}/${file.path}`, pkg.readBlob(file));
  kernel0.writeFile(`${old}/manifest.json`, JSON.stringify(pkg.manifest));

  const ws = await open(db);
  const kernel = ws.vfs.as(CRED_KERNEL);
  for (const dir of ROOTS) assert.deepEqual(owner(kernel, dir), ['directory', 0, 0, 0o755], `${dir} became root's`);
  for (const file of ETC) assert.deepEqual(owner(kernel, file), ['file', 0, 0, 0o644], `${file} became root's`);
  assert.equal(kernel.readFileString('etc/profile'), 'export PATH=/opt/mine:$PATH\n', 'a profile the user edited keeps what they wrote');
  assert.equal(kernel.lstat('usr/lib/node_modules/mine').uid, USER, 'what the user put inside stays theirs');
  assert.equal(kernel.exists('usr/lib/nimbus/toy/1.0.0/manifest.json'), true, 'the runtime moved into the store');
  assert.equal(kernel.lstat('home/user/.nimbus/runtimes').type, 'symlink', 'a link is left at the old path');
  assert.equal(kernel.readlink('home/user/.nimbus/runtimes'), '/usr/lib/nimbus');
  assert.equal(kernel.exists('home/user/.nimbus/runtimes/toy/1.0.0/manifest.json'), true, 'the old path still leads to it');
  assert.equal(kernel.readlink('usr/bin/toy'), '/usr/lib/nimbus/toy/1.0.0/bin/toy', 'its launcher is made');
  assert.equal((await ws.exec('toy')).stdout, 'ran toy from usr/lib/nimbus/toy/1.0.0\n');

  // Once: opened again, nothing moves or changes.
  const again = await open(db);
  assert.equal(again.vfs.as(CRED_KERNEL).readlink('home/user/.nimbus/runtimes'), '/usr/lib/nimbus');
  db.close();
  console.log('  a session an earlier release made moves over, once');
}

// ── what a user owned under /usr before is not the kernel's to follow ─────
{
  const db = new Database(':memory:');
  const kernel0 = (await open(db)).vfs.as(CRED_KERNEL);
  for (const dir of [...ROOTS].reverse()) kernel0.chown(dir, USER, USER);
  const user0 = (await open(db)).vfs.as(CRED_SESSION_USER);
  // As an earlier release let the user: /usr/lib a link to its home.
  user0.rename('usr/lib', 'usr/lib-old');
  user0.symlink('/home/user', 'usr/lib');
  const ws = await open(db);
  const kernel = ws.vfs.as(CRED_KERNEL);
  assert.equal(kernel.lstat('usr/lib').type, 'symlink', 'the link is left');
  assert.equal(kernel.exists('home/user/node_modules'), false, 'nothing is made through it');
  assert.equal(kernel.lstat('home/user').uid, USER, 'nor is what it leads to taken');
  await assert.rejects(ws.runtimes.installPackage(toyPackage()), /usr\/lib/, 'nothing installs through it');
  db.close();
  console.log('  what a user owned under /usr before is not the kernel\'s to follow');
}
{
  const db = new Database(':memory:');
  const kernel0 = (await open(db)).vfs.as(CRED_KERNEL);
  // As an earlier release left it: no store yet, and /usr/lib the user's.
  kernel0.rmdir('usr/lib/nimbus');
  kernel0.chown('usr/lib', USER, USER);
  const user = (await open(db)).vfs.as(CRED_SESSION_USER);
  // A runtime of the user's own making in a store the user made.
  const pkg = toyPackage({ name: 'forged' });
  user.mkdir('usr/lib/nimbus/forged/1.0.0/bin', { recursive: true });
  user.mkdir('usr/lib/nimbus/forged/1.0.0/share/toy', { recursive: true });
  for (const file of pkg.manifest.files) user.writeFile(`usr/lib/nimbus/forged/1.0.0/${file.path}`, pkg.readBlob(file));
  user.writeFile('usr/lib/nimbus/forged/1.0.0/manifest.json', JSON.stringify(pkg.manifest));
  const ws = await open(db);
  const kernel = ws.vfs.as(CRED_KERNEL);
  assert.equal(kernel.lstat('usr/lib/nimbus').uid, 0, 'the store becomes root\'s');
  assert.equal(kernel.lstat('usr/lib/nimbus/forged').uid, USER, 'without what is in it');
  assert.equal(kernel.statIfPresent('usr/bin/toy', false), null, 'a runtime the user made takes no launcher');
  assert.equal((await ws.exec('toy')).exitCode, 127, 'and is not bound');
  assert.deepEqual((await ws.runtimes.list()).map((r) => r.name), [], 'nor listed');
  db.close();
  console.log('  a runtime the user made in the store is not the system\'s');
}

// ── a runtime's name and version are one name each ────────────────────────
{
  const db = new Database(':memory:');
  const ws = await open(db);
  const kernel = ws.vfs.as(CRED_KERNEL);
  const before = kernel.readFileString('etc/profile');
  await assert.rejects(ws.runtimes.installPackage(toyPackage({ name: '../../..', version: 'etc' })), /name|version/);
  assert.equal(kernel.readFileString('etc/profile'), before, 'nothing is written outside the store');
  db.close();
  console.log('  a runtime\'s name and version are one name each');
}

// ── a link at a directory of the store refuses the install ────────────────
{
  const db = new Database(':memory:');
  const ws = await open(db);
  const kernel = ws.vfs.as(CRED_KERNEL);
  // Only root could have done this (through sudo): the kernel still writes nothing through it.
  kernel.mkdir('etc/elsewhere', { mode: 0o755 });
  kernel.rmdir('usr/lib/nimbus');
  kernel.symlink('/etc/elsewhere', 'usr/lib/nimbus');
  await assert.rejects(ws.runtimes.installPackage(toyPackage()), /usr\/lib\/nimbus/);
  assert.deepEqual(kernel.readdir('etc/elsewhere'), [], 'nothing was written through it');
  db.close();
  console.log('  a link at a directory of the store refuses the install');
}

console.log('usr-layout: ok');
