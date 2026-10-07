#!/usr/bin/env bun
// `git add -A` writes .git/index once, not once per path, and holds one
// file at a time. It used to call cf-git's add (and remove) once per changed
// file, and every call parsed and rewrote the whole index: O(n^2) bytes,
// which at 10k files took minutes and, on a Durable Object, died part way
// with half the files staged. One add() of every path instead read them all
// before writing any object, each with its own deflate stream, and 1,000
// files reset the isolate. Its objects go in waves into the engine (the
// shared wave writer): a file is read, hashed and deflated before the next
// is read, and at most two waves of objects (one buffering, one publishing)
// wait to be written; every object is published before the index. The
// repository it leaves must be one real git accepts: fsck-clean, with a
// clean status against the files on disk.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { runGitCommand } from '../../packages/worker/src/git/commands.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { WAVE_PATHS } from '../../packages/platform/src/wave-writer.ts';

const FILES = 3000;
// The VFS stamps inodes with Date.now(). One frozen second makes every index
// entry racily clean (its mtime is not older than the index's own), the case
// in which git's add refreshes the index in memory and still writes it once.
Date.now = () => Date.parse('2026-01-01T00:00:00Z');
const REPO = 'home/user/repo';

const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
const kernel = vfs.as(CRED_KERNEL);
kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
kernel.chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
const user = vfs.as(CRED_SESSION_USER);
const files = new ProcessFiles(vfs);

// The engine's waves: each object a wave publishes is no longer waiting; the index must come after them all.
let objectsPublished = 0;
let indexBeforeObjects = false;
const engineAs = vfs.as.bind(vfs);
vfs.as = (cred) => {
  const engine = engineAs(cred);
  return new Proxy(engine, {
    get(target, key) {
      if (key !== 'writeStream') return Reflect.get(target, key, target);
      return async (stream, options) => {
        const result = await target.writeStream(stream, options);
        const objects = result.receipts.filter(({ path }) => path.startsWith(`${REPO}/.git/objects/`)).length;
        objectsPublished += objects;
        filesInFlight -= objects;
        return result;
      };
    },
  });
};

// What the command does through the view it is given: index writes, and
// worktree files read but not yet written back as objects.
let indexWrites = 0;
let filesInFlight = 0;
let peakFilesInFlight = 0;
const observed = new Proxy(files.view({ pid: 1, cred: CRED_SESSION_USER }), {
  get(target, key) {
    // git reads a file it stages past the content cache; either read counts.
    if (key === 'readFile' || key === 'readFileUncached') {
      return (path) => {
        // The files being staged; .gitignore lookups are reads too, and write no object.
        if (/\/f\d+\.txt$/.test(path)) peakFilesInFlight = Math.max(peakFilesInFlight, ++filesInFlight);
        return target[key](path);
      };
    }
    if (key === 'writeFile') {
      return (path, content, options) => {
        const key = path.replace(/^\/+/, '');
        if (key === `${REPO}/.git/index`) {
          indexWrites++;
          if (filesInFlight !== 0) indexBeforeObjects = true;
        }
        if (key.startsWith(`${REPO}/.git/objects/`)) filesInFlight--;
        return target.writeFile(path, content, options);
      };
    }
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

async function git(...args) {
  let stdout = '';
  let stderr = '';
  const code = await runGitCommand({
    pid: 1,
    cred: CRED_SESSION_USER,
    args,
    cwd: `/${REPO}`,
    env: { USER: 'a', GIT_AUTHOR_EMAIL: 'a@example.com' },
    stdout: { write(s) { stdout += s; } },
    stderr: { write(s) { stderr += s; } },
    vfs: observed,
  }, vfs);
  assert.equal(code, 0, `git ${args.join(' ')}: ${stderr}`);
  return stdout;
}

user.mkdir(`${REPO}/nested/dir`, { recursive: true });
for (let i = 0; i < FILES; i++) {
  user.writeFile(`${REPO}/${i % 3 ? '' : 'nested/dir/'}f${i}.txt`, `file ${i}\n${'x'.repeat(i % 97)}\n`);
}
await git('init', '-q');

indexWrites = 0;
peakFilesInFlight = filesInFlight = 0;
await git('add', '-A');
assert.equal(indexWrites, 1, `add -A of ${FILES} new files wrote the index ${indexWrites} times`);
assert.equal(objectsPublished, FILES, 'every blob went in the waves');
assert.ok(peakFilesInFlight >= 1 && peakFilesInFlight <= 2 * WAVE_PATHS + 1, `add -A held ${peakFilesInFlight} files' objects at once (two waves: ${2 * WAVE_PATHS})`);
assert.equal(indexBeforeObjects, false, 'the index was written before every object it names');
// Taken here: the reads later commands make keep the counter moving.
const stagedAtOnce = peakFilesInFlight;
await git('commit', '-qm', 'base');
assert.equal(await git('status'), 'nothing to commit, working tree clean\n');

// Deletions stage under one index write too, the refresh of the racily clean
// entries included: git refreshes in memory and writes the index once.
for (let i = 0; i < FILES; i += 2) user.unlink(`${REPO}/${i % 3 ? '' : 'nested/dir/'}f${i}.txt`);
user.writeFile(`${REPO}/f1.txt`, 'edited\n');
indexWrites = 0;
await git('add', '-A');
assert.equal(indexWrites, 1, `add -A of ${FILES / 2} deletions and an edit wrote the index ${indexWrites} times`);
await git('commit', '-qm', 'prune');
assert.equal(await git('status'), 'nothing to commit, working tree clean\n');

// Real git reads what was written: objects, trees, index and refs.
const scratch = mkdtempSync(join(tmpdir(), 'nimbus-git-add-all-'));
try {
  const copy = (from, to) => {
    mkdirSync(to, { recursive: true });
    for (const entry of user.readdir(from)) {
      const src = `${from}/${entry.name}`;
      if (entry.type === 'directory') copy(src, join(to, entry.name));
      else {
        writeFileSync(join(to, entry.name), user.readFile(src));
        chmodSync(join(to, entry.name), user.stat(src).mode & 0o777);
      }
    }
  };
  const disk = join(scratch, 'repo');
  copy(REPO, disk);
  const env = { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const real = (...args) => {
    const r = spawnSync('git', args, { cwd: disk, env, encoding: 'utf8', maxBuffer: 1 << 26 });
    assert.equal(r.status, 0, `real git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  real('fsck', '--strict', '--no-progress');
  assert.equal(real('status', '--porcelain'), '', 'real git sees the worktree as committed');
  assert.equal(real('ls-files').split('\n').filter(Boolean).length, FILES / 2);
  assert.equal(real('rev-list', '--count', 'HEAD').trim(), '2');
  assert.equal(real('show', 'HEAD:f1.txt'), 'edited\n');
  console.log(`git-add-all-index-writes: ${FILES} files staged in one index write, ${stagedAtOnce} at a time; real git fsck and status agree`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
