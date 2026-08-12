#!/usr/bin/env bun

// `stat -c` is how scripts and embedders read file metadata. The flag used to
// be filtered out with every other `-` argument, so the format string was
// treated as a filename and the command failed with "No such file" — the kind
// of quietly-dropped flag that pushes callers into workarounds.

import assert from 'node:assert/strict';

import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { registerUnixCommands } from '../../packages/core/src/shell/unix-commands.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
const kernel = vfs.as(CRED_KERNEL);
kernel.mkdir('home/user', { recursive: true });
kernel.mkdir('etc', { recursive: true });
kernel.writeFile('etc/passwd', 'root:x:0:0:root:/root:/bin/sh\nuser:x:1000:1000:user:/home/user:/bin/sh\n');
kernel.writeFile('etc/group', 'root:x:0:\nuser:x:1000:user\n');
kernel.writeFile('home/user/a.txt', 'hello\n', { mode: 0o644 });
kernel.chown('home/user/a.txt', 1000, 1000);

const commands = new Map();
const registry = {
  register: (name, fn) => commands.set(name, fn),
  registerLazy: (name, loader) => commands.set(name, loader),
  has: (name) => commands.has(name),
  get: (name) => commands.get(name),
  unregister: (name) => commands.delete(name),
  list: () => [...commands.keys()],
};
registerUnixCommands(registry, vfs);

async function stat(args) {
  const out = [];
  const err = [];
  const exitCode = await commands.get('stat')({
    args,
    cwd: '/home/user',
    env: {},
    cred: CRED_KERNEL,
    stdout: { write: (d) => out.push(d) },
    stderr: { write: (d) => err.push(d) },
    signal: new AbortController().signal,
  });
  return { exitCode, stdout: out.join(''), stderr: err.join('') };
}

const size = await stat(['-c', '%s', 'a.txt']);
assert.deepEqual([size.exitCode, size.stdout], [0, '6\n'], size.stderr);

const owner = await stat(['-c', '%u %U %g %G', 'a.txt']);
assert.deepEqual([owner.exitCode, owner.stdout], [0, '1000 user 1000 user\n'], owner.stderr);

const mode = await stat(['--format=%a %A %F', 'a.txt']);
assert.deepEqual([mode.exitCode, mode.stdout], [0, '644 -rw-r--r-- regular file\n'], mode.stderr);

const dir = await stat(['-c', '%F', '/home/user']);
assert.deepEqual([dir.exitCode, dir.stdout], [0, 'directory\n'], dir.stderr);

const mtime = await stat(['-c', '%Y', 'a.txt']);
assert.match(mtime.stdout, /^\d{10}\n$/, 'mtime is epoch seconds');

const escapes = await stat(['-c', '%n:%s\\t%%', 'a.txt']);
assert.equal(escapes.stdout, '/home/user/a.txt:6\t%\n');

const printf = await stat(['--printf=%s', 'a.txt']);
assert.equal(printf.stdout, '6', '--printf does not append a newline');

const multiple = await stat(['-c', '%s', 'a.txt', 'a.txt']);
assert.equal(multiple.stdout, '6\n6\n');

// Every GNU directive is answered — nothing the tool advertises is missing.
const everyDirective = 'nNsbBoaAfuUgGFhidDtTmCwWYyXxZz';
for (const directive of everyDirective) {
  const one = await stat(['-c', `%${directive}`, 'a.txt']);
  assert.equal(one.exitCode, 0, `%${directive}: ${one.stderr}`);
  assert.ok(one.stdout.length > 1, `%${directive} produced no output`);
}

// Identity is per-path, since paths are this filesystem's identity.
const inodeA = await stat(['-c', '%i', 'a.txt']);
const inodeSame = await stat(['-c', '%i', 'a.txt']);
const inodeOther = await stat(['-c', '%i', '/home/user']);
assert.equal(inodeA.stdout, inodeSame.stdout, '%i is stable for a path');
assert.notEqual(inodeA.stdout, inodeOther.stdout, '%i distinguishes files');
assert.match(inodeA.stdout, /^\d+\n$/);

// Links, birth time and SELinux report what this filesystem really knows.
const unknowns = await stat(['-c', '%h|%w|%W|%C', 'a.txt']);
assert.equal(unknowns.stdout, '1|-|0|?\n');

// -t is the terse form, not a rejected flag.
const terse = await stat(['-t', 'a.txt']);
assert.equal(terse.exitCode, 0, terse.stderr);
assert.equal(terse.stdout.trim().split(' ').length, 17, terse.stdout);
assert.ok(terse.stdout.startsWith('/home/user/a.txt 6 '), terse.stdout);

// -f reports the filesystem, with the same numbers df reads.
const fsReport = await stat(['-f', '/home/user']);
assert.equal(fsReport.exitCode, 0, fsReport.stderr);
assert.match(fsReport.stdout, /Type: nimbus-sqlite/);
assert.match(fsReport.stdout, /Namelen: 255/);
const fsFormat = await stat(['-f', '-c', '%T %s %l', '/home/user']);
assert.equal(fsFormat.stdout, 'nimbus-sqlite 65536 255\n', fsFormat.stderr);
const fsTerse = await stat(['-f', '-t', '/home/user']);
assert.equal(fsTerse.exitCode, 0, fsTerse.stderr);

// --cached is accepted (attributes are always live) and validated.
assert.equal((await stat(['--cached=never', '-c', '%s', 'a.txt'])).stdout, '6\n');
const badCache = await stat(['--cached=sometimes', 'a.txt']);
assert.equal(badCache.exitCode, 1);
assert.match(badCache.stderr, /invalid argument 'sometimes'/);

// --help and --version answer instead of erroring.
const help = await stat(['--help']);
assert.equal(help.exitCode, 0);
assert.match(help.stdout, /--file-system/);
const version = await stat(['--version']);
assert.equal(version.exitCode, 0);
assert.match(version.stdout, /nimbus coreutils/);

// Only genuinely invalid input is rejected, and it says what was wrong.
const badDirective = await stat(['-c', '%q', 'a.txt']);
assert.equal(badDirective.exitCode, 1);
assert.match(badDirective.stderr, /unrecognized format directive '%q'/);

const badFlag = await stat(['-Q', 'a.txt']);
assert.equal(badFlag.exitCode, 1);
assert.match(badFlag.stderr, /invalid option '-Q'/);

const missingArgument = await stat(['-c']);
assert.equal(missingArgument.exitCode, 1);
assert.match(missingArgument.stderr, /requires an argument/);

// The default report still works.
const plain = await stat(['a.txt']);
assert.equal(plain.exitCode, 0, plain.stderr);
assert.match(plain.stdout, /File: \/home\/user\/a\.txt/);
assert.match(plain.stdout, /Uid: \(1000\/user\)/);

console.log('unix stat format: ok');
