#!/usr/bin/env bun
// The session's git reads a packed repository by range, and keeps out of a
// clone that is still running.
//
//   - log, diff and status on a repository whose objects are only in packs
//     (one git-built, ofs-deltas, larger than any single read) answer as git
//     does, and no pack is ever read whole: every read of a .pack is a range
//     (the store's), none a readFile (cf-git's own pack loader). Red before
//     the packs seam: cf-git read the whole pack on the first object.
//   - while .git holds the clone's job marker, every command but init and
//     clone refuses, naming the clone; with the marker gone they run.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { runGitCommand } from '../../packages/worker/src/git/commands.ts';
import { GIT_CLONE_JOB_MARKER } from '../../packages/worker/src/git/network-facet.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const work = mkdtempSync(join(tmpdir(), 'nimbus-session-packs-'));
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: work, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
function hostGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, env, maxBuffer: 1 << 26 });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.toString();
}

const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
const kernel = vfs.as(CRED_KERNEL);
kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
kernel.chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
const user = vfs.as(CRED_SESSION_USER);
const files = new ProcessFiles(vfs);

// Every whole-file read and every range read of a .pack, as the engine serves them.
const packReads = { whole: 0, ranges: 0, largest: 0 };
for (const [name, kind] of [['readFile', 'whole'], ['readFileUncached', 'whole'], ['readRange', 'ranges']]) {
  const original = SqliteVFS.prototype[name];
  SqliteVFS.prototype[name] = function (path, ...rest) {
    const result = original.call(this, path, ...rest);
    if (String(path).endsWith('.pack')) {
      packReads[kind]++;
      packReads.largest = Math.max(packReads.largest, result.byteLength);
    }
    return result;
  };
}

async function git(cwd, args) {
  let stdout = '';
  let stderr = '';
  const code = await runGitCommand({
    pid: 7,
    cred: CRED_SESSION_USER,
    args,
    cwd,
    env: { USER: 'a' },
    stdout: { write(s) { stdout += s; } },
    stderr: { write(s) { stderr += s; } },
    vfs: files.view({ pid: 7, cred: CRED_SESSION_USER }),
  }, vfs);
  return { code, stdout: stdout.replace(/\x1b\[[0-9;]*m/g, ''), stderr };
}

try {
  const source = join(work, 'source');
  hostGit(work, ['init', '-q', '-b', 'main', source]);
  let seed = 9;
  const random = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  const text = (n) => Array.from({ length: n }, () => 'w' + Math.floor(random() * 500).toString(36)).join(' ') + '\n';
  for (let commit = 0; commit < 4; commit++) {
    mkdirSync(join(source, 'src'), { recursive: true });
    for (let f = 0; f < 12; f++) writeFileSync(join(source, `src/f${f}.txt`), text(2000 + f * 100) + `rev ${commit}\n`);
    hostGit(source, ['add', '-A']);
    hostGit(source, ['commit', '-q', '-m', `c${commit}`]);
  }
  hostGit(source, ['repack', '-adq']);
  hostGit(source, ['prune-packed']);
  // The repository, objects only in its pack, copied into the session's filesystem.
  const copy = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const key = 'home/user/repo/' + relative(source, path);
      if (statSync(path).isDirectory()) { user.mkdir(key, { recursive: true }); copy(path); }
      else user.writeFile(key, readFileSync(path));
    }
  };
  user.mkdir('home/user/repo', { recursive: true });
  copy(source);
  const packBytes = readdirSync(join(source, '.git/objects/pack')).filter((n) => n.endsWith('.pack'))
    .reduce((n, name) => n + statSync(join(source, '.git/objects/pack', name)).size, 0);

  const log = await git('/home/user/repo', ['log', '--oneline']);
  assert.equal(log.code, 0, log.stderr);
  assert.equal(log.stdout.trim().split('\n').length, 4);
  const [parent, head] = hostGit(source, ['rev-parse', 'HEAD~1', 'HEAD']).trim().split('\n');
  const diff = await git('/home/user/repo', ['diff', parent, '--stat']);
  assert.equal(diff.code, 0, diff.stderr + diff.stdout);
  assert.equal(diff.stdout.trim().split('\n').pop().trim(), hostGit(source, ['diff', '--stat', 'HEAD~1', 'HEAD']).trim().split('\n').pop().trim());
  const status = await git('/home/user/repo', ['status']);
  assert.match(status.stdout, /nothing to commit, working tree clean/);
  assert.equal(packReads.whole, 0, 'a pack was read whole');
  assert.ok(packReads.ranges > 0, 'the pack was read by range');
  assert.ok(packReads.largest < packBytes, `largest pack read ${packReads.largest} of ${packBytes}`);

  // A clone in progress: its marker refuses every command but init and clone.
  user.writeFile(`home/user/repo/.git/${GIT_CLONE_JOB_MARKER}`, '{}');
  for (const args of [['log', '--oneline'], ['status'], ['diff'], ['rev-parse', 'HEAD']]) {
    const refused = await git('/home/user/repo/src', args);
    assert.equal(refused.code, 128, args.join(' '));
    assert.equal(refused.stderr, "fatal: '/home/user/repo' is still being cloned\n");
  }
  user.unlink(`home/user/repo/.git/${GIT_CLONE_JOB_MARKER}`);
  assert.equal((await git('/home/user/repo', ['log', '--oneline'])).code, 0);
  console.log('git-session-packs: ok');
} finally {
  rmSync(work, { recursive: true, force: true });
}
