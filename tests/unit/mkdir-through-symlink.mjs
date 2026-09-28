#!/usr/bin/env bun
// A recursive mkdir of a name that is a link to a directory succeeds, as
// coreutils and Node do: after EEXIST they stat the name through the link.
// The process bridge looked only at the link's own entry, so `ws.fs.mkdir`,
// the shell's `mkdir -p` and a process's `mkdir({ recursive })` answered
// EEXIST ("File exists") for a name the engine itself accepted. A plain
// mkdir of the link, and a recursive one of a link to a file or of a
// dangling link, still fail.
import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
const code = (run) => Promise.resolve().then(run).then(() => 'ok', (error) => error.code);
const dir = '/home/user';

await ws.fs.mkdir(`${dir}/real`);
await ws.fs.writeFile(`${dir}/real/f`, 'x');
await ws.fs.symlink(`${dir}/real`, `${dir}/link`);
await ws.fs.symlink(`${dir}/real/f`, `${dir}/file-link`);
await ws.fs.symlink(`${dir}/gone`, `${dir}/dangling`);

assert.equal(await code(() => ws.fs.mkdir(`${dir}/link`, { recursive: true })), 'ok', 'ws.fs: mkdir -p of a link to a directory');
assert.equal(await code(() => ws.fs.mkdir(`${dir}/link`)), 'EEXIST', 'ws.fs: a plain mkdir of the link');
assert.equal(await code(() => ws.fs.mkdir(`${dir}/file-link`, { recursive: true })), 'EEXIST', 'ws.fs: a link to a file');
assert.equal(await code(() => ws.fs.mkdir(`${dir}/dangling`, { recursive: true })), 'EEXIST', 'ws.fs: a dangling link');

const r = await ws.exec(`mkdir -p ${dir}/link && mkdir -p ${dir}/link/sub && ls -1 ${dir}/real; `
  + `for p in file-link dangling; do mkdir -p ${dir}/$p 2>/dev/null; echo "$p=$?"; done; mkdir ${dir}/link 2>/dev/null; echo "plain=$?"`);
assert.equal(r.stdout, 'f\nsub\nfile-link=1\ndangling=1\nplain=1\n', `shell: ${r.stderr}`);
assert.equal(r.stderr, '');

// A process's bridge answers the same.
const fs = ws.filesystem.bind({ pid: 70, cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 } });
assert.equal(await code(() => fs.mkdir(`${dir}/link`, { recursive: true })), 'ok', 'bridge: mkdir -p of a link to a directory');
assert.equal(await code(() => fs.mkdir(`${dir}/link`)), 'EEXIST', 'bridge: a plain mkdir of the link');
assert.equal(await code(() => fs.mkdir(`${dir}/dangling`, { recursive: true })), 'EEXIST', 'bridge: a dangling link');
assert.equal((await ws.fs.stat(`${dir}/link`, { follow: false })).type, 'symlink', 'the link is still a link');

await ws.close();
console.log('mkdir-through-symlink: ok');
