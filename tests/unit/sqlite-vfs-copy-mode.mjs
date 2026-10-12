#!/usr/bin/env bun
// A file copied to a new name has the source's permission bits less the
// copier's umask, as cp(1) makes it; one copied over a file already there
// keeps that file's mode. Red before: a new copy was 0666 less the umask, so
// copying a private file made one others could read.
import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const raw = new SqliteVFS(harness.sql, harness.ctx);
const kernel = raw.as(CRED_KERNEL);
const owner = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const other = raw.as({ uid: 2000, gid: 2000, groups: [2000], umask: 0o022 });
const user = raw.as(owner);
kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
kernel.chown('home/user', 1000, 1000);

const made = (name, mode) => {
  user.writeFile(`home/user/${name}`, name);
  user.chmod(`home/user/${name}`, mode);
};
made('secret', 0o600);
made('script', 0o755);
made('shared', 0o666);
made('setuid', 0o755);
kernel.chmod('home/user/setuid', 0o4755);
made('over', 0o644);

user.copy('home/user/secret', 'home/user/secret-copy');
user.copy('home/user/script', 'home/user/script-copy');
user.copy('home/user/shared', 'home/user/shared-copy');
user.copy('home/user/setuid', 'home/user/setuid-copy');
user.copy('home/user/secret', 'home/user/over');
const modeOf = (name) => user.stat(`home/user/${name}`).mode & 0o7777;
assert.deepEqual(
  Object.fromEntries(['secret-copy', 'script-copy', 'shared-copy', 'setuid-copy', 'over'].map((name) => [name, modeOf(name)])),
  { 'secret-copy': 0o600, 'script-copy': 0o755, 'shared-copy': 0o644, 'setuid-copy': 0o755, over: 0o644 },
  "a new copy has the source's permission bits less the umask; a file copied over keeps its own",
);
assert.equal(new TextDecoder().decode(user.readFile('home/user/secret-copy')), 'secret');
assert.throws(() => other.readFile('home/user/secret-copy'), { code: 'EACCES' }, 'another principal cannot read the copy of a private file');
console.log('sqlite-vfs-copy-mode: PASS');
