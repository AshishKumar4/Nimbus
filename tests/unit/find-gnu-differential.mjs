#!/usr/bin/env bun
// find, differentially: every command line below runs under the host's GNU
// findutils and under Nimbus's find, over the same tree at the same absolute
// path, and must print the same stdout, the same stderr and the same exit
// status.
//
// The host side runs in bubblewrap, which gives it what the comparison needs:
// the tree bound at the path Nimbus has it at; a tmpfs mounted inside it (a
// second file system, for -xdev), which Nimbus has as a MemoryVFS mount;
// uid 1000; and Nimbus's own /etc/passwd and /etc/group, so names agree.
//
// GNU prints in the order readdir returns names, and so does Nimbus: SQLite
// lists a directory by name, with mount points last. The host tree is built
// on tmpfs, whose order follows creation (this checks which way), in the
// order that makes the two agree, and the agreement is checked before any
// case runs. So nothing is sorted: the order of every line is compared.
//
// What Nimbus's stat cannot report the same way (a directory's size and link
// count, inode and device numbers, ctime, a directory's atime that the
// host's own readdir moves) is kept out of the comparisons; see the refusal
// table at the end for what Nimbus declines outright.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { ProcessView } from '../../packages/core/src/runtime/process-files.ts';
import { registerShellEntrypointCommands } from '../../packages/core/src/shell/shell-entrypoints.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const gnuVersion = execFileSync('find', ['--version'], { encoding: 'utf8' }).split('\n')[0];
assert.match(gnuVersion, /^find \(GNU findutils\) 4\./, `the host's find must be GNU findutils 4.x, found: ${gnuVersion}`);
assert.equal(fs.statfsSync('/dev/shm').type, 0x01021994, '/dev/shm must be tmpfs, whose readdir order follows creation');

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// Whole seconds: both sides then hold every time exactly.
const NOW = Math.floor(Date.now() / SECOND) * SECOND;

// Where both sides have the tree: on the host, an empty directory the sandbox binds the tree over.
const ROOT = fs.mkdtempSync('/tmp/nimbus-find-diff-');
const base = fs.mkdtempSync('/dev/shm/nimbus-find-diff-');
process.on('exit', () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  for (const shut of ['w/locked', 'w/noexec']) if (fs.existsSync(path.join(base, shut))) fs.chmodSync(path.join(base, shut), 0o755);
  fs.rmSync(base, { recursive: true, force: true });
});
const W = `${ROOT}/w`;
const SCRATCH = `${ROOT}/scratch`;
const MOUNT = `${W}/mnt`;

// The tree, relative to ROOT. A directory's entries are listed in the order
// both sides must return them: by name, a mount point last.
const ENTRIES = [
  { path: 'w', type: 'dir', mode: 0o755, age: 1 * DAY },
  { path: 'w/.hidden', type: 'file', content: 'h\n', mode: 0o644, age: 10 * DAY },
  { path: 'w/Makefile', type: 'file', content: 'all:\n\ttrue\n', mode: 0o644, age: 2.5 * DAY },
  { path: 'w/README.md', type: 'file', content: 'r'.repeat(1500), mode: 0o644, age: 40 * DAY },
  { path: 'w/a', type: 'dir', mode: 0o755, age: 1 * DAY },
  { path: 'w/a/b', type: 'dir', mode: 0o755, age: 3.5 * DAY },
  { path: 'w/a/b/c.TXT', type: 'file', content: '', mode: 0o600, age: 1 * HOUR },
  { path: 'w/a/b/deep', type: 'dir', mode: 0o700, age: 3.5 * DAY },
  { path: 'w/a/b/deep/x.js', type: 'file', content: 'x'.repeat(5000), mode: 0o755, age: 3.5 * DAY },
  { path: 'w/a/empty', type: 'dir', mode: 0o755, age: 6 * HOUR },
  { path: 'w/a/f.js', type: 'file', content: 'console.log(1)\n', mode: 0o644, age: 5 * MINUTE },
  { path: 'w/a/g.ts', type: 'file', content: 'export {}\n', mode: 0o640, age: 2 * HOUR },
  { path: 'w/big.bin', type: 'file', content: 'b'.repeat(1024 * 1024 + 1), mode: 0o644, age: 100 * DAY },
  { path: 'w/cyc', type: 'dir', mode: 0o755, age: 1 * DAY },
  { path: 'w/cyc/up', type: 'link', target: '..', age: 1 * DAY },
  { path: 'w/dangling', type: 'link', target: 'nowhere', age: 1 * DAY },
  { path: 'w/dir with space', type: 'dir', mode: 0o755, age: 1 * DAY },
  { path: 'w/dir with space/file name', type: 'file', content: 'x', mode: 0o644, age: 1 * DAY },
  { path: 'w/link-to-a', type: 'link', target: 'a', age: 1 * DAY },
  { path: 'w/link-to-f', type: 'link', target: 'a/f.js', age: 1 * DAY },
  { path: 'w/locked', type: 'dir', mode: 0o000, age: 1 * DAY },
  { path: 'w/locked/secret.txt', type: 'file', content: 's', mode: 0o644, age: 1 * DAY },
  // Readable but not searchable: its names list, its entries cannot be stat'ed or entered.
  { path: 'w/noexec', type: 'dir', mode: 0o644, age: 1 * DAY },
  { path: 'w/noexec/inside', type: 'file', content: 'i', mode: 0o644, age: 1 * DAY },
  { path: 'w/noexec/sub', type: 'dir', mode: 0o755, age: 1 * DAY },
  { path: 'w/node_modules', type: 'dir', mode: 0o755, age: 1 * DAY },
  // A second before the epoch, for dates with a sign and a fraction.
  { path: 'w/pre-epoch', type: 'file', content: '', mode: 0o644, age: NOW + 1 * SECOND },
  { path: 'w/node_modules/pkg', type: 'dir', mode: 0o755, age: 1 * DAY },
  { path: 'w/node_modules/pkg/index.js', type: 'file', content: 'module.exports = 1;\n', mode: 0o644, age: 1 * DAY },
  { path: 'w/node_modules/pkg/package.json', type: 'file', content: '{}\n', mode: 0o644, age: 1 * DAY },
  { path: 'w/setuid', type: 'file', content: '#!/bin/sh\n', mode: 0o4755, age: 1 * DAY },
  { path: 'w/sticky', type: 'dir', mode: 0o1777, age: 1 * DAY },
  { path: 'w/zz-empty', type: 'file', content: '', mode: 0o644, age: 1 * DAY },
  { path: 'scratch', type: 'dir', mode: 0o755, age: 1 * DAY },
];
// The second file system, mounted at w/mnt (last in w's listing on both sides).
const MOUNTED = [
  { path: 'inner', type: 'dir', mode: 0o755, age: 1 * DAY },
  { path: 'inner/deep.txt', type: 'file', content: 'deep\n', mode: 0o644, age: 2 * DAY },
  { path: 'm.txt', type: 'file', content: 'm\n', mode: 0o644, age: 1 * DAY },
];
const MOUNT_ROOT = { mode: 0o755, age: 1 * DAY };
/** Directories whose own mode is set last, once nothing more is made or timed inside them. */
const SHUT = ['w/locked', 'w/noexec'];

const parentOf = (p) => p.slice(0, p.lastIndexOf('/'));
/** Each directory's entries, in listing order. */
function childrenBy(entries) {
  const children = new Map();
  for (const entry of entries) {
    const parent = entry.path.includes('/') ? parentOf(entry.path) : '';
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(entry);
  }
  for (const list of children.values()) list.sort((x, y) => (x.path < y.path ? -1 : 1));
  return children;
}

// ── The host's tree ─────────────────────────────────────────────────────────

/** Which way tmpfs lists a directory: in creation order, or newest first. */
const creationFirst = (() => {
  const probe = path.join(base, 'probe');
  fs.mkdirSync(probe);
  for (const name of ['a', 'b', 'c']) fs.writeFileSync(path.join(probe, name), '');
  const order = execFileSync('find', [probe, '-mindepth', '1', '-printf', '%f'], { encoding: 'utf8' });
  fs.rmSync(probe, { recursive: true });
  assert.ok(order === 'abc' || order === 'cba', `tmpfs lists a directory in creation order or its reverse, not ${order}`);
  return order === 'abc';
})();
const inCreationOrder = (list) => (creationFirst ? list : [...list].reverse());

/** Shell lines that build entries, in an order that makes the host list them as given. */
function buildScript(entries, at) {
  const lines = [];
  const children = childrenBy(entries);
  const visit = (dir) => {
    for (const entry of inCreationOrder(children.get(dir) ?? [])) {
      const target = `${at}/${entry.path}`;
      if (entry.type === 'dir') lines.push(`mkdir ${shQuote(target)}`);
      else if (entry.type === 'file') lines.push(`printf %s ${shQuote(entry.content)} > ${shQuote(target)}`);
      else lines.push(`ln -s ${shQuote(entry.target)} ${shQuote(target)}`);
    }
    for (const entry of children.get(dir) ?? []) if (entry.type === 'dir') visit(entry.path);
  };
  visit('');
  return lines;
}

function shQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

const secondsOf = (entry) => (NOW - entry.age) / SECOND;
{
  const children = childrenBy(ENTRIES);
  const visit = (dir) => {
    const listed = children.get(dir) ?? [];
    // The mount point is listed last, as Nimbus lists one; its tmpfs covers what is made here.
    const made = dir === 'w' ? [...listed, { path: 'w/mnt', type: 'mount point' }] : listed;
    for (const entry of inCreationOrder(made)) {
      const target = path.join(base, entry.path);
      if (entry.type === 'dir' || entry.type === 'mount point') fs.mkdirSync(target);
      else if (entry.type === 'file') fs.writeFileSync(target, entry.content);
      else fs.symlinkSync(entry.target, target);
    }
    for (const entry of listed) if (entry.type === 'dir') visit(entry.path);
  };
  visit('');
  // Modes, then times, deepest first, then the locked directory's mode.
  for (const entry of ENTRIES) if (entry.type !== 'link' && !SHUT.includes(entry.path)) fs.chmodSync(path.join(base, entry.path), entry.mode);
  for (const entry of [...ENTRIES].reverse()) {
    const target = path.join(base, entry.path);
    // A Date: Bun reads a negative number of seconds as now.
    const at = new Date(NOW - entry.age);
    if (entry.type === 'link') fs.lutimesSync(target, at, at);
    else fs.utimesSync(target, at, at);
  }
  for (const shut of SHUT) fs.chmodSync(path.join(base, shut), ENTRIES.find((entry) => entry.path === shut).mode);
}

// ── Nimbus's tree ───────────────────────────────────────────────────────────
const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
// sh and bash, as a session registers them, for -exec sh -c.
registerShellEntrypointCommands(ws.registry, { execute: (command, options) => ws.shell.execute(command, options) });
const user = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const view = new ProcessView(ws.filesystem.bind({ pid: ws.shellProcessPid, cred: user }));
await view.mkdir(ROOT);
for (const entry of ENTRIES) {
  const target = `${ROOT}/${entry.path}`;
  if (entry.type === 'dir') await view.mkdir(target);
  else if (entry.type === 'file') await view.writeFile(target, entry.content);
  else await view.symlink(entry.target, target);
}
for (const entry of ENTRIES) if (entry.type !== 'link' && !SHUT.includes(entry.path)) await view.chmod(`${ROOT}/${entry.path}`, entry.mode);
for (const entry of [...ENTRIES].reverse()) {
  const at = NOW - entry.age;
  await view.utimes(`${ROOT}/${entry.path}`, at, at, { follow: entry.type !== 'link' });
}
for (const shut of SHUT) await view.chmod(`${ROOT}/${shut}`, ENTRIES.find((entry) => entry.path === shut).mode);

const mounted = new MemoryVFS({ uid: 1000, gid: 1000 });
for (const entry of MOUNTED) {
  if (entry.type === 'dir') await mounted.mkdir(`/${entry.path}`, { mode: entry.mode });
  else await mounted.writeFile(`/${entry.path}`, new TextEncoder().encode(entry.content));
}
for (const entry of MOUNTED) await mounted.chmod(`/${entry.path}`, entry.mode);
for (const entry of [...MOUNTED].reverse()) await mounted.utimes(`/${entry.path}`, NOW - entry.age, NOW - entry.age);
await mounted.chmod('/', MOUNT_ROOT.mode);
await mounted.utimes('/', NOW - MOUNT_ROOT.age, NOW - MOUNT_ROOT.age);
ws.filesystem.vfs.mount(MOUNT, mounted);

// The host's mount is a fresh tmpfs each run, filled the same way before find starts.
const populateMount = [
  ...buildScript(MOUNTED, MOUNT),
  ...MOUNTED.map((entry) => `chmod ${entry.mode.toString(8)} ${shQuote(`${MOUNT}/${entry.path}`)}`),
  ...[...MOUNTED].reverse().map((entry) => `touch -d @${secondsOf(entry)} ${shQuote(`${MOUNT}/${entry.path}`)}`),
  `chmod ${MOUNT_ROOT.mode.toString(8)} ${MOUNT}`,
  `touch -d @${secondsOf(MOUNT_ROOT)} ${MOUNT}`,
].join('\n');

const accounts = path.join(base, '.accounts');
fs.mkdirSync(accounts);
fs.writeFileSync(path.join(accounts, 'passwd'), (await ws.exec('cat /etc/passwd')).stdout);
fs.writeFileSync(path.join(accounts, 'group'), (await ws.exec('cat /etc/group')).stdout);

/** `body` (find on argv, by default) under the host's sh, in the sandbox, after `setup`. */
function runHost(argv, cwd, setup, body = 'exec find "$@"') {
  const result = spawnSync('bwrap', [
    '--unshare-user', '--uid', '1000', '--gid', '1000',
    '--dev-bind', '/', '/',
    '--bind', base, ROOT,
    '--tmpfs', MOUNT,
    '--ro-bind', path.join(accounts, 'passwd'), '/etc/passwd',
    '--ro-bind', path.join(accounts, 'group'), '/etc/group',
    '--chdir', cwd,
    '--clearenv', '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'LC_ALL', 'C', '--setenv', 'TZ', 'UTC',
    '--', '/bin/sh', '-c', `set -e\n${populateMount}\ncd ${shQuote(cwd)}\n${setup ?? ''}\nset +e\n${body}`, 'sh', ...argv,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

async function runNimbus(argv, cwd, setup, setupCwd = cwd) {
  if (setup) {
    const prepared = await ws.exec(setup, { cwd: setupCwd });
    assert.equal(prepared.exitCode, 0, `setup: ${setup}: ${prepared.stderr}`);
  }
  const result = await ws.exec(['find', ...argv].map(shQuote).join(' '), { cwd });
  return { stdout: result.stdout, stderr: result.stderr, status: result.exitCode };
}

// ── The precondition: both sides list every directory the same way ─────────
{
  const listing = ['.', '(', '-path', './locked', '-o', '-path', './noexec', ')', '-prune', '-o', '-printf', '%p\n'];
  const host = runHost(listing, W);
  const nimbus = await runNimbus(listing, W);
  assert.equal(host.status, 0, host.stderr);
  assert.equal(nimbus.stdout, host.stdout, 'the host and Nimbus list the fixture in the same order');
}

// ── The table ───────────────────────────────────────────────────────────────
// Each case: argv after `find`, run with cwd w (or `cwd`); `setup` is a shell
// line both sides run first (in scratch, for cases that change the tree).
const CASES = [
  // Start points and the default action
  [],
  ['.'],
  ['a'],
  ['a/'],
  ['a//'],
  ['./a'],
  [`${W}/a`],
  ['a', 'README.md', 'nope', 'dangling'],
  ['-', '-maxdepth', '0'],
  [')', '-maxdepth', '0'],
  [',', '-maxdepth', '0'],
  ['README.md/'],
  [''],
  ['.', '-maxdepth', '0'],
  ['.', '-maxdepth', '1'],
  ['.', '-mindepth', '2', '-maxdepth', '3'],
  ['.', '-mindepth', '1', '-maxdepth', '1', '-type', 'd'],
  ['.', '-depth'],
  ['a', '-depth', '-print'],
  ['a', '-d'],
  ['--', 'a', '-maxdepth', '1'],
  ['a', '-mindepth', '1', '-depth', '-name', 'b', '-prune', '-o', '-print'],
  ['a', '-maxdepth', '1', '-depth'],
  ['a', '-mindepth', '3'],
  ['a', '-mindepth', '1', '-maxdepth', '0'],
  ['a', '.', 'a/b', '-maxdepth', '1', '-name', 'b'],
  ['-P', 'a', '-maxdepth', '1'],
  ['-O0', 'a', '-maxdepth', '1'],

  // Names and paths
  ['.', '-name', '*.js'],
  ['.', '-name', '.*'],
  ['.', '-name', '*'],
  ['.', '-iname', '*.txt'],
  ['.', '-name', '[a-c]*'],
  ['.', '-name', '[!a-z]*'],
  ['.', '-name', '?.??'],
  ['.', '-name', '\\*'],
  ['.', '-name', 'a/b'],
  ['a/', '-name', 'a'],
  ['.', '-path', './a/*'],
  ['.', '-path', '*b*', '-prune', '-o', '-print'],
  ['.', '-ipath', '*/B/*'],
  ['.', '-wholename', './a/f.js'],
  ['.', '-iwholename', './A/F.JS'],
  ['.', '-path', 'a/'],
  ['a/', '-path', 'a/', '-print'],
  ['.', '-not', '-path', '*/node_modules/*'],
  ['.', '-path', './node_modules', '-prune', '-o', '-name', '*.js', '-print'],
  ['.', '-name', 'file name'],
  ['.', '-lname', 'a*'],
  ['.', '-ilname', 'NOW*'],

  // Types
  ['.', '-type', 'd'],
  ['.', '-type', 'f'],
  ['.', '-type', 'l'],
  ['.', '-type', 'f,l'],
  ['.', '-type', 'b,c,p,s'],
  ['.', '-xtype', 'l'],
  ['.', '-xtype', 'd'],
  ['.', '-xtype', 'f', '-maxdepth', '1'],

  // Emptiness and sizes (of files: a directory's size is the file system's own)
  ['.', '-empty'],
  ['.', '-type', 'd', '-empty'],
  ['.', '-type', 'f', '-empty'],
  ['.', '-not', '-empty', '-type', 'f'],
  ['.', '-type', 'f', '-size', '+1k'],
  ['.', '-type', 'f', '-size', '-1'],
  ['.', '-type', 'f', '-size', '1'],
  ['.', '-type', 'f', '-size', '3'],
  ['.', '-type', 'f', '-size', '1M'],
  ['.', '-type', 'f', '-size', '2M'],
  ['.', '-type', 'f', '-size', '+1M'],
  ['.', '-type', 'f', '-size', '-1M'],
  ['.', '-type', 'f', '-size', '15c'],
  ['.', '-type', 'f', '-size', '-10w'],
  ['.', '-type', 'f', '-size', '2k'],
  ['.', '-type', 'f', '-size', '+0G'],

  // Times (of files and links; a directory's atime is moved by the host's readdir)
  ['.', '-type', 'f', '-mtime', '+30'],
  ['.', '-mtime', '-1'],
  ['.', '-mtime', '3'],
  ['.', '-mtime', '+2', '-mtime', '-4'],
  ['.', '-mtime', '0'],
  ['.', '-mtime', '1.5'],
  ['.', '-mmin', '-10'],
  ['.', '-mmin', '+60', '-mmin', '-180'],
  ['.', '-type', 'f', '-atime', '+5'],
  ['.', '-type', 'f', '-amin', '-30'],
  ['.', '-daystart', '-mtime', '1'],
  ['.', '-daystart', '-type', 'f', '-mtime', '-2'],
  // A MemoryVFS keeps no ctime (it reports its mtime), so the mount point stays out of this one.
  ['.', '-ctime', '-1', '-maxdepth', '1', '!', '-name', 'mnt'],
  ['.', '-cmin', '+100000'],
  // The MemoryVFS mounted at mnt keeps no atime or ctime of its own, so its files stay out of these.
  ['.', '-type', 'f', '-used', '-1', '!', '-path', './mnt/*'],
  ['.', '-type', 'f', '-used', '+1', '!', '-path', './mnt/*'],
  ['.', '-newer', 'Makefile'],
  ['.', '-newer', 'a/f.js'],
  ['.', '-newer', 'link-to-f', '-maxdepth', '1'],
  ['-H', '.', '-newer', 'link-to-f', '-maxdepth', '1'],
  ['.', '-maxdepth', '1', '-newermm', 'README.md'],
  ['.', '-type', 'f', '-newerma', 'Makefile'],
  ['.', '-type', 'f', '-anewer', 'Makefile'],
  ['.', '-type', 'f', '-newermt', '2020-01-01'],
  ['.', '-type', 'f', '-newermt', new Date(NOW - 50 * DAY).toISOString().slice(0, 10)],
  ['.', '-newermt', '3 days ago', '-type', 'f'],
  ['.', '-type', 'f', '!', '-newermt', 'yesterday'],
  ['.', '-newermt', `@${(NOW - 3 * DAY) / SECOND}`],
  ['.', '-type', 'f', '-newerat', '1 week ago'],
  ['.', '-newermt', `${new Date(NOW - 2 * DAY).toISOString().slice(0, 10)} 12:00`],
  ['.', '-name', 'pre-epoch', '-newermt', '@-1.5'],
  ['.', '-name', 'pre-epoch', '-newermt', '@-1,5'],
  ['.', '-name', 'pre-epoch', '-newermt', '@-1.0001'],
  ['.', '-name', 'pre-epoch', '-newermt', '@-0.5'],
  ['.', '-name', 'pre-epoch', '-newermt', '@- 1.5'],
  ['.', '-name', 'pre-epoch', '!', '-newermt', '@-1'],
  ['.', '-maxdepth', '1', '-newermt', '@ 5'],
  ['.', '-maxdepth', '1', '-newermt', '@+5'],
  ['.', '-type', 'f', '-newermt', ''],
  ['.', '-maxdepth', '1', '-newermt', '@9223372036854775807'],
  ['.', '-maxdepth', '1', '-newermt', '@-9223372036854775808'],
  ['.', '-maxdepth', '0', '-newermt', '2020-01-01 12:00 +2400'],
  ['.', '-maxdepth', '0', '-newermt', '2020-01-01 12:00 -2400'],
  ['.', '-maxdepth', '0', '-newermt', '1000000 years'],
  ['.', '-maxdepth', '0', '-newermt', '2147483520 days'],
  ['.', '-maxdepth', '0', '-newermt', '1000000 years ago'],
  ['.', '-maxdepth', '1', '-cnewer', 'README.md'],

  // Permissions and ownership
  ['.', '-perm', '644'],
  ['.', '-perm', '-644'],
  ['.', '-perm', '/111'],
  ['.', '-perm', '-u+x', '-type', 'f'],
  ['.', '-perm', '/u=x,g=x'],
  ['.', '-perm', '-4000'],
  ['.', '-perm', '/o+t'],
  ['.', '-perm', 'u=rw,go=r'],
  ['.', '-perm', 'u+rw-x'],
  ['.', '-perm', '0644', '-type', 'f'],
  ['.', '-perm', '-g+r', '-maxdepth', '1'],
  ['.', '-perm', '/000', '-maxdepth', '0'],
  ['.', '-user', 'user', '-maxdepth', '1'],
  ['.', '-group', 'user', '-maxdepth', '0'],
  ['.', '-user', 'root'],
  ['.', '-user', '1000', '-maxdepth', '0'],
  ['.', '-uid', '1000', '-maxdepth', '0'],
  ['.', '-gid', '+999', '-maxdepth', '0'],
  ['.', '-uid', '-1000', '-maxdepth', '0'],
  ['.', '-nouser'],
  ['.', '-nogroup'],
  ['.', '-type', 'f', '-links', '1', '-maxdepth', '1'],
  ['.', '-type', 'f', '-links', '+1'],
  ['.', '-samefile', 'a/f.js'],
  ['.', '-samefile', 'link-to-a/'],
  ['.', '-samefile', 'a/f.js/'],
  ['.', '-newer', 'dangling/'],
  ['-L', 'a', 'link-to-f', '-samefile', 'a/f.js'],
  ['.', '-maxdepth', '1', '-executable'],
  ['.', '-maxdepth', '1', '!', '-readable'],
  ['.', '-maxdepth', '1', '-writable', '-type', 'f'],

  // Operators
  ['.', '-name', 'a', '-o', '-name', 'b'],
  ['.', '(', '-name', '*.js', '-o', '-name', '*.ts', ')', '-print'],
  ['.', '-name', '*.js', '-a', '-type', 'f'],
  ['.', '-name', '*.js', '-and', '-type', 'f'],
  ['.', '!', '-type', 'd', '-maxdepth', '1'],
  ['.', '-not', '-name', '*.js', '-type', 'f'],
  ['.', '!', '!', '-name', 'a'],
  ['.', '-name', 'a', '-o', '-name', 'b', '-type', 'd'],
  ['.', '-name', 'a', '-or', '-name', 'f.js', '-print'],
  ['.', '-maxdepth', '1', '-name', 'a', '-print', ',', '-name', 'zz-empty', '-print'],
  ['.', '-maxdepth', '1', '-false', '-o', '-true'],
  ['.', '-true', '-a', '-false'],
  ['.', '-name', 'x', '-o', '-maxdepth', '0'],
  ['.', '(', '-name', 'a', ')', '(', '-type', 'd', ')'],
  ['.', '-maxdepth', '1', '(', '-name', 'a', '-o', '(', '-name', 'cyc', '-type', 'd', ')', ')'],
  ['.', '-maxdepth', '1', '-name', 'a', '-o', '-name', 'cyc', ',', '-name', 'sticky'],

  // Actions
  ['.', '-name', '*.js', '-print0'],
  ['.', '-name', '*.js', '-print', '-print0'],
  ['.', '-name', 'a', '-prune'],
  ['.', '-name', 'a', '-prune', '-o', '-print'],
  ['.', '-depth', '-name', 'a', '-prune', '-o', '-print'],
  ['.', '-name', '*.js', '-print', '-quit'],
  ['.', '-quit'],
  ['.', '-quit', '-print'],
  ['.', '-name', '*.ts', '-quit', '-o', '-print'],
  ['a', '-name', '*.js', '-exec', 'echo', 'got', '{}', ';'],
  ['a', '-type', 'f', '-exec', 'echo', '{}', '+'],
  ['a', '-exec', 'echo', '[{}]', '{}{}', ';'],
  ['a', '-name', '*.js', '-exec', 'false', ';', '-o', '-print'],
  ['a', '-name', '*.js', '-exec', 'nosuchcommand', '{}', ';', '-o', '-print'],
  ['a', '-name', '*.js', '-exec', 'nosuchcommand', '{}', '+'],
  ['a', '-name', '*.js', '-execdir', 'nosuchcommand', '{}', ';'],
  ['a', '-name', '*.js', '-exec', './nosuch.sh', '{}', ';'],
  ['a', '-name', '*.ts', '-exec', 'sh', '-c', 'exit 1', 'sh', '{}', '+', '-print'],
  ['a', '-name', '*.ts', '-exec', 'sh', '-c', 'exit 3', ';', '-print'],
  ['a', '-execdir', 'echo', '{}', ';'],
  ['a', '-execdir', 'echo', '{}', '+'],
  ['a/b', '-execdir', 'pwd', ';'],
  ['-L', 'link-to-a', '-name', 'f.js', '-execdir', 'pwd', ';'],
  ['-H', 'link-to-a/', '-maxdepth', '1', '-name', 'g.ts', '-execdir', 'pwd', ';'],
  ['.', '-maxdepth', '0', '-execdir', 'echo', '{}', ';'],
  ['a', 'node_modules', '-name', '*.js*', '-execdir', 'echo', '{}', '+'],
  ['a', '-print', '-execdir', 'echo', 'dir', '{}', '+'],
  ['a', '-type', 'f', '-exec', 'printf', '%s\\n', '{}', '+'],
  ['.', '-path', './node_modules', '-prune', '-o', '-type', 'f', '-name', '*.js', '-exec', 'echo', '{}', '+'],
  ['.', '-name', 'f.js', '-exec', 'echo', '{}', '+', '-quit'],

  // -printf
  ['.', '-printf', '%p|%f|%h|%P|%H|%d|%y\\n'],
  ['a/', '-printf', '%p|%f|%h|%P|%H\\n'],
  ['a//', '-printf', '%p|%f|%h|%P|%H\\n'],
  ['./a', '-printf', '%p|%f|%h|%P|%H\\n'],
  [`${W}/a/b`, '-printf', '%p|%f|%h|%P|%H|%d\\n'],
  ['.', '-type', 'f', '-printf', '%s %m %M %u %g %U %G %n %y\\n'],
  ['.', '-maxdepth', '1', '-printf', '%m %M %y %Y\\n'],
  ['.', '-maxdepth', '1', '-type', 'l', '-printf', '%p -> %l %Y\\n'],
  ['.', '-maxdepth', '1', '-printf', '%-12f|%12f|%.3f|%-5.2p|\\n'],
  ['.', '-type', 'f', '-printf', '%t | %a\\n'],
  ['.', '-printf', '%TY-%Tm-%Td %TH:%TM %Tz %TZ %Ta %TA %Tb %TB %Tj %Tu %Tw %TU %TW %TV %TG %Tg %TC %Ty %Te %Tk %Tl %TI %Tp\\n'],
  ['.', '-printf', '%Tc|%TD|%Tx|%TX|%Tr|%TR|%TT|%TS|%Ts|%TF|%Th|%TP\\n'],
  ['.', '-type', 'f', '-printf', '%T@ %T+ %A@ %AT\\n'],
  ['.', '-maxdepth', '1', '-printf', '%5d|%-5d|%05d|%+d|% d|%.3d\\n'],
  ['.', '-maxdepth', '1', '-printf', '%#m|%05m|%-6m|%.4m|%#o\\n'],
  ['.', '-maxdepth', '1', '-printf', 'x\\ty\\0z\\101\\c never\\n'],
  ['.', '-maxdepth', '1', '-printf', '%%|%5%|%-%\\n'],
  ['.', '-maxdepth', '0', '-printf', '%q|%5q|\\q|\\\\|\\a\\b\\f\\v\\r\\n'],
  ['.', '-maxdepth', '0', '-printf', '%AQ|%A|%T%|%Tn|%Tt\\n'],
  ['.', '-maxdepth', '0', '-printf', 'trailing\\'],
  ['.', '-maxdepth', '0', '-printf', '\\0\\00\\000\\0000\\1234\\n'],

  // Symbolic links
  ['link-to-a'],
  ['link-to-a/'],
  ['-H', 'link-to-a'],
  ['-L', 'link-to-a'],
  ['-L', 'a', 'dangling', '-printf', '%p %y %Y\\n'],
  ['-P', 'link-to-a', '-maxdepth', '0', '-printf', '%y %Y %l\\n'],
  ['-L', 'link-to-f', '-printf', '%y %l\\n'],
  ['-L', 'cyc'],
  ['-L', '.', '-name', 'x.js'],
  ['-L', '.', '-type', 'l'],
  ['.', '-follow', '-name', 'f.js'],
  ['-H', '.', '-maxdepth', '1', '-type', 'l'],
  ['-L', '.', '-maxdepth', '1', '-xtype', 'l'],
  ['-L', 'a', 'link-to-a', '-maxdepth', '1', '-printf', '%p %y\\n'],

  // A second file system
  ['.', '-xdev'],
  ['.', '-mount', '-name', '*.txt'],
  ['.', '-name', '*.txt'],
  ['mnt'],
  ['mnt', '-xdev'],
  ['.', '-xdev', '-type', 'd'],
  ['.', '-xdev', '-printf', '%p %y %m\\n'],
  ['.', '-xdev', '-depth', '-name', 'mnt'],
  ['-L', 'a', 'mnt', '-xdev'],

  // What GNU tests first: the tests that read nothing come before those that read a stat or a directory
  ['.', '-maxdepth', '1', '-empty', '-name', 'nope'],
  ['.', '-size', '+0', '-name', 'nope'],
  ['.', '(', '-type', 'f', '-size', '+0', ')', '-o', '-name', 'inside'],
  ['.', '-empty', '-print', '-name', 'nope'],
  ['.', '!', '-empty', '-name', 'nope'],
  ['-O0', '.', '-size', '+0', '-false'],
  ['-O1', '.', '-size', '+0', '-false'],
  ['.', '-type', 'f', '-size', '+0', '-name', 'nope', ',', '-false'],

  // Unreadable directories
  ['.', '-name', 'secret*'],
  ['locked'],
  ['locked', '-depth'],
  ['.', '-maxdepth', '1', '-name', 'locked', '-empty'],
  ['.', '-name', 'locked', '-prune', '-o', '-name', 'secret*', '-print'],
  ['noexec'],
  ['noexec', '-type', 'f'],
  ['noexec', '-type', 'd'],
  ['noexec', '-name', 'inside', '-size', '-5'],
  ['noexec', '-printf', '%p %y\n'],
  ['noexec', '-depth'],
  ['-L', 'noexec'],
  ['noexec', '-empty'],
  ['noexec/inside'],

  // Warnings
  ['.', '-warn', '-name', 'x', '-maxdepth', '1'],
  ['.', '-warn', '-name', 'a/b'],
  ['.', '-warn', '-d', '-maxdepth', '0'],
  ['.', '-nowarn', '-name', 'a/b'],
  ['.', '-warn', '(', '-maxdepth', '0', ')'],
  ['.', '-warn', '-name', 'x', '-follow', '-daystart', '-maxdepth', '0'],

  // Command lines GNU refuses
  ['.', '-bogus'],
  ['.', '-name'],
  ['.', '('],
  ['.', '(', ')'],
  ['.', '-o', '-print'],
  ['.', '-print', '-o'],
  ['.', '!'],
  ['.', '-print', ')'],
  ['.', '(', '-print'],
  ['.', '-name', 'x', ')'],
  ['.', '-true', '-a'],
  ['.', '-name', 'x', ','],
  ['.', '(', '-not', ')'],
  ['.', '(', '-name', 'x', '-o', ')'],
  ['.', '-name', 'x', ')', '('],
  ['.', '-type', 'x'],
  ['.', '-type', 'fd'],
  ['.', '-type', 'f,f'],
  ['.', '-type', 'f,'],
  ['.', '-type', ''],
  ['.', '-type', 'D'],
  ['.', '-size', '3x'],
  ['.', '-size', ''],
  ['.', '-size', '+'],
  ['.', '-size', '+k'],
  ['.', '-mtime', 'abc'],
  ['.', '-mmin', ''],
  ['.', '-mtime', '1e999'],
  ['.', '-mmin', '-1e999'],
  ['.', '-maxdepth', '0', '-mtime', '--1e100'],
  ['.', '-maxdepth', '0', '-mtime', '1e100'],
  ['.', '-maxdepth', '0', '-mtime', '+1e100'],
  ['.', '-maxdepth', '0', '-mtime', '-1e100'],
  ['.', '-maxdepth', '0', '-mmin', '--1e300'],
  ['.', '-maxdepth', '0', '-used', '--1e100'],
  ['.', '-maxdepth', '-1'],
  ['.', '-maxdepth', '1a'],
  ['.', '-mindepth'],
  ['.', '-newer', 'nope'],
  ['.', '-samefile', 'nope'],
  ['.', '-perm', '+111'],
  ['.', '-perm', '999'],
  ['.', '-perm', 'u+x,'],
  ['.', '-user', 'nosuch'],
  ['.', '-group', 'nosuch'],
  ['.', '-links', 'x'],
  ['.', '-inum', 'x'],
  ['.', '-uid', '1.5'],
  ['.', '-exec', 'echo'],
  ['.', '-exec', ';'],
  ['.', '-exec', 'echo', '{}', '{}', '+'],
  ['.', '-exec', 'echo', '{}x', '+'],
  ['.', '-printf'],
  ['.', '-printf', '%'],
  ['.', '-printf', 'a%5'],
  ['.', '-printf', '%{'],
  ['.', '-name', 'a', 'b'],
  ['.', '-name', '*.md', 'Makefile'],
  ['-HL', '.'],
  ['-D'],
  ['-Ox', '.'],
  ['-O', '.'],
  ['-O99999999', '.'],
  ['-O0001', '.', '-maxdepth', '0'],
  ['-O99999999999999999999', '.'],
  ['.', '-delete', '-prune'],
  ['.', '-context', 'x'],
  ['.', '-context'],
  ['.', '-newerBm', 'a'],
  ['.', '-newerXY', 'a'],
  ['.', '-newermm'],
  ['.', '-newertm', 'a'],
  ['.', '-newermt', 'garbage'],
  ['.', '-newermt', '@999999999999999999999999999999999999'],
  ['.', '-newermt', '@9223372036854775808'],
  ['.', '-newermt', '@-9223372036854775809'],
  ['.', '-newermt', '@.5'],
  ['.', '-newermt', '@5.'],
  ['.', '-newermt', '2020-01-01 12:00 +9999'],
  ['.', '-newermt', '2020-01-01 12:00 +2401'],
  ['.', '-newermt', '2020-01-01 23:59:60'],
  ['.', '-newermt', '3000000000 years'],
  ['.', '-newermt', '1 year 2147483647 months'],
  ['.', '-newermt', '100000000000 days'],
  ['.', '-newermt', '9223372036854775807 seconds'],
  ['.', '-newermt'],
  ['.', '-used'],
];

// Cases that change the tree: run in scratch, each after its own setup.
const CHANGING = [
  { setup: 'mkdir d1 && mkdir d1/sub && touch d1/sub/f && touch d1/g', argv: ['d1', '-delete'], then: ['.', '-path', './d1*'] },
  { setup: 'mkdir d2 && touch d2/keep && touch d2/f', argv: ['d2', '-name', 'f', '-delete', '-print'], then: ['d2'] },
  { setup: 'mkdir d3 && touch d3/x', argv: ['.', '-delete'], cwd: `${SCRATCH}/d3`, then: ['.'] },
  { setup: 'mkdir d4 && mkdir d4/sub', argv: ['d4', '-type', 'd', '-exec', 'touch', '{}/new', ';'], then: ['d4'] },
  { setup: 'mkdir d5 && touch d5/b.tmp && touch d5/a.tmp', argv: ['d5', '-name', '*.tmp', '-execdir', 'rm', '{}', ';', '-print'], then: ['d5'] },
  { setup: 'mkdir d6 && mkdir d6/full && touch d6/full/x', argv: ['d6/full', '-depth', '-delete'], then: ['.', '-path', './d6*'] },
  { setup: 'mkdir d7 && mkdir d7/n && touch d7/n/x', argv: ['d7', '-name', 'n', '-delete'], then: ['d7'] },
  { setup: 'mkdir d8 && touch d8/z && touch d8/y', argv: ['d8', '-type', 'f', '-exec', 'rm', '{}', '+'], then: ['d8'] },
  // A program named by a path is found from the directory it runs in.
  {
    setup: "mkdir d9 && touch d9/x && echo '#!/bin/sh' > d9/tool.sh && echo 'echo tool \"$1\" \"$(pwd)\"' >> d9/tool.sh && chmod 755 d9/tool.sh",
    argv: ['d9', '-name', 'x', '-execdir', './tool.sh', '{}', ';'],
    then: ['d9'],
  },
];

// -exec starts a program, as execvp does: a shell function, an alias or a
// builtin of the shell find was started from is not one. Each script runs in
// a shell of its own on both sides: the host's sh, and Nimbus's `sh -c`.
const SCRIPTS = [
  "echo() { printf 'WRONG\\n'; }; find a/f.js -exec echo '{}' ';'",
  "echo() { printf 'WRONG\\n'; }; find a/f.js a/g.ts -exec echo '{}' +",
  "job() { echo JOB; }; find a/f.js -exec job '{}' ';'; echo \"status $?\"",
  "job() { echo JOB; }; find a/f.js -exec job '{}' +; echo \"status $?\"",
  "alias cat='echo ALIAS'\nfind a/f.js -exec cat '{}' ';'",
  "cd a && find . -name f.js -exec echo '{}' ';'",
  // A program whose reader is gone dies of SIGPIPE; find reports it, the -exec is false, and the walk goes on.
  // The reader exits before find starts, so every echo loses it.
  "cd ../scratch && mkdir pipe && i=0 && while [ $i -lt 120 ]; do i=$((i+1)); : > pipe/f$i; done; " +
    "{ sleep 0.2; find pipe -type f '(' -exec echo '{}' ';' , -exec sh -c 'echo \"$1\" >> log' sh '{}' ';' ')'; echo $? > rc; } | true; " +
    "cat rc; wc -l < log",
  "cd ../scratch && { sleep 0.2; find pipe -name f1 -exec echo '{}' +; echo $? > rc; } | true; cat rc",
];

let compared = 0;
const failures = [];

function report(name, host, nimbus) {
  compared++;
  const same = host.stdout === nimbus.stdout && host.stderr === nimbus.stderr && host.status === nimbus.status;
  if (same) return;
  failures.push(name);
  console.log(`FAIL ${name}`);
  for (const key of ['status', 'stdout', 'stderr']) {
    if (host[key] !== nimbus[key]) console.log(`  ${key}\n    gnu:    ${JSON.stringify(host[key])}\n    nimbus: ${JSON.stringify(nimbus[key])}`);
  }
}

for (const argv of CASES) {
  const name = `find ${argv.map(shQuote).join(' ')}`;
  report(name, runHost(argv, W), await runNimbus(argv, W));
}

for (const { setup, argv, cwd, then } of CHANGING) {
  const name = `${setup}; find ${argv.map(shQuote).join(' ')}`;
  const at = cwd ?? SCRATCH;
  // Both set up in scratch, and the host's setup runs inside the sandbox its find runs in.
  const host = runHost(argv, SCRATCH, `${setup}\ncd ${shQuote(at)}`);
  report(name, host, await runNimbus(argv, at, setup, SCRATCH));
  report(`${name}; then find ${then.map(shQuote).join(' ')}`, runHost(then, at), await runNimbus(then, at));
}

for (const script of SCRIPTS) {
  const nimbus = await ws.exec(`sh -c ${shQuote(script)}`, { cwd: W });
  report(script, runHost([], W, '', script), { stdout: nimbus.stdout, stderr: nimbus.stderr, status: nimbus.exitCode });
}

// ── What Nimbus refuses, loudly, where GNU would act ────────────────────────
const REFUSED = [
  [['.', '-regex', '.*'], "find: invalid predicate `-regex': regular expressions are not supported\n"],
  [['.', '-iregex', '.*'], "find: invalid predicate `-iregex': regular expressions are not supported\n"],
  [['.', '-regextype', 'posix-extended'], "find: invalid predicate `-regextype': regular expressions are not supported\n"],
  [['.', '-fstype', 'ext4'], "find: invalid predicate `-fstype': file system types are not reported\n"],
  [['.', '-ls'], "find: invalid predicate `-ls': block counts are not reported\n"],
  [['.', '-fls', 'out'], "find: invalid predicate `-fls': block counts are not reported\n"],
  [['.', '-fprint', 'out'], "find: invalid predicate `-fprint': output files are not supported\n"],
  [['.', '-fprint0', 'out'], "find: invalid predicate `-fprint0': output files are not supported\n"],
  [['.', '-fprintf', 'out', '%p'], "find: invalid predicate `-fprintf': output files are not supported\n"],
  [['.', '-files0-from', 'list'], "find: invalid predicate `-files0-from': start points from a file are not supported\n"],
  [['.', '-ok', 'echo', '{}', ';'], "find: invalid predicate `-ok': there is no prompt to confirm on\n"],
  [['.', '-okdir', 'echo', '{}', ';'], "find: invalid predicate `-okdir': there is no prompt to confirm on\n"],
  [['-D', 'stat', '.'], 'find: the -D debug option is not supported here\n'],
  // From -O2 GNU reorders by estimated cost, which decides which unreadable files it reports.
  [['-O2', '.'], 'find: optimisation level 2 is not supported here; use -O0 or -O1\n'],
  [['-O3', '.'], 'find: optimisation level 3 is not supported here; use -O0 or -O1\n'],
  // GNU means to refuse this too (findutils' insert_exec_ok), but its check compares the wrong index and never fires.
  [['.', '-execdir', '{}', ';'], 'find: You may not use {} within the utility name for -execdir and -okdir, because this is a potential security problem.\n'],
  [['.', '-printf', '%k'], "find: error: the format directive `%k' is not supported here\n"],
  [['.', '-printf', '%b'], "find: error: the format directive `%b' is not supported here\n"],
  [['.', '-printf', '%S'], "find: error: the format directive `%S' is not supported here\n"],
  [['.', '-printf', '%F'], "find: error: the format directive `%F' is not supported here\n"],
  [['.', '-printf', '%Z'], "find: error: the format directive `%Z' is not supported here\n"],
  [['.', '-printf', '%BY'], "find: error: the format directive `%B' is not supported here\n"],
];
let refused = 0;
for (const [argv, stderr] of REFUSED) {
  const result = await runNimbus(argv, W);
  const name = `find ${argv.map(shQuote).join(' ')}`;
  if (result.status !== 1 || result.stdout !== '' || result.stderr !== stderr) {
    failures.push(`refusal: ${name}`);
    console.log(`FAIL refusal: ${name}\n  ${JSON.stringify(result)}`);
  }
  refused++;
}

await ws.close();

if (failures.length > 0) {
  console.error(`\nfind-gnu-differential: ${failures.length} of ${compared + refused} differ`);
  process.exit(1);
}
console.log(`find-gnu-differential: ${compared} command lines identical to ${gnuVersion}; ${refused} refusals as stated`);
