#!/usr/bin/env bun
// git-fs-adapter — cf-git's one `fs` (git/git-fs.ts), as the session and the
// git network facet both hand it to cf-git, over a backend:
//   - readFile decodes text for the bare encoding and the options object
//     alike (cf-git reads .gitignore with the bare one), bytes otherwise;
//   - a missing path is Node's ENOENT, its syscall named;
//   - an inode is Node's fs.Stats: type bits on the mode, times as Dates;
//   - writeFile hands the backend bytes and whether the mode is executable;
//   - cf-git binds its recursive delete to the adapter's rmdir, which the
//     backend gets with `recursive`.
import assert from 'node:assert/strict';
import { createGitFs } from '../../packages/worker/src/git/git-fs.ts';

const calls = [];
const files = new Map([['repo/.gitignore', new TextEncoder().encode('dist/\n')]]);
const backend = {
  async stat(path, follow) {
    calls.push(['stat', path, follow]);
    if (path === 'repo/link') return { type: follow ? 'file' : 'symlink', size: 4, mode: 0o777, mtimeMs: 1000, ctimeMs: 2000, atimeMs: 3000, uid: 1, gid: 2, dev: 3, ino: 4, nlink: 1 };
    if (path === 'repo/dir') return { type: 'dir', size: 0, mode: 0o755, mtimeMs: 1000, ctimeMs: 1000, atimeMs: 1000, uid: 0, gid: 0, dev: 0, ino: 0, nlink: 1 };
    return null;
  },
  async readFile(path) { return files.get(path) ?? null; },
  async writeFile(path, data, executable) { calls.push(['writeFile', path, data, executable]); },
  async unlink() {},
  async readdir() { return []; },
  async mkdir() {},
  async rmdir(path, filepath, recursive) { calls.push(['rmdir', path, filepath, recursive]); },
  async symlink() {},
  async readlink() { return 'target'; },
};
const fs = createGitFs(backend, { seam: true });

assert.deepEqual(fs.packs, { seam: true });
assert.equal(await fs.promises.readFile('/repo/./.gitignore', 'utf8'), 'dist/\n');
assert.equal(await fs.promises.readFile('/repo/.gitignore', { encoding: 'utf-8' }), 'dist/\n');
assert.deepEqual(await fs.promises.readFile('/repo/.gitignore'), new TextEncoder().encode('dist/\n'));
await assert.rejects(fs.promises.readFile('/repo/missing'), (error) =>
  error.code === 'ENOENT' && error.errno === -2 && error.message === "ENOENT: no such file or directory, open '/repo/missing'");
await assert.rejects(fs.promises.lstat('/repo/missing'), (error) => error.code === 'ENOENT' && /lstat '\/repo\/missing'/.test(error.message));

const link = await fs.promises.lstat('/repo/link');
assert.equal(link.isSymbolicLink(), true);
assert.equal(link.mode, 0o120777);
assert.equal(link.ctime.getTime(), 2000);
assert.deepEqual([link.uid, link.gid, link.dev, link.ino], [1, 2, 3, 4]);
const followed = await fs.promises.stat('/repo/link');
assert.equal(followed.isFile(), true);
assert.equal(followed.mode, 0o100777);
assert.equal((await fs.promises.stat('/repo/dir')).mode, 0o040755);
assert.deepEqual(calls.filter(([op]) => op === 'stat').map(([, path, follow]) => [path, follow]),
  [['repo/missing', false], ['repo/link', false], ['repo/link', true], ['repo/dir', true]]);

await fs.promises.writeFile('/repo/run.sh', new Uint8Array([1, 2]).buffer, { mode: 0o100755 });
await fs.promises.writeFile('/repo/a.txt', 'text', { mode: 0o100644 });
assert.deepEqual(calls.filter(([op]) => op === 'writeFile'), [
  ['writeFile', 'repo/run.sh', new Uint8Array([1, 2]), true],
  ['writeFile', 'repo/a.txt', 'text', false],
]);

// cf-git's FileSystem binds `_rm` to rmdir when it takes options (models/FileSystem.js bindFs).
assert.equal('rm' in fs.promises, false);
assert.ok(fs.promises.rmdir.length > 1);
await fs.promises.rmdir('/repo/dir', { recursive: true });
await fs.promises.rmdir('/repo/dir');
assert.deepEqual(calls.filter(([op]) => op === 'rmdir'), [
  ['rmdir', 'repo/dir', '/repo/dir', true],
  ['rmdir', 'repo/dir', '/repo/dir', false],
]);
console.log('git-fs-adapter: ok');
