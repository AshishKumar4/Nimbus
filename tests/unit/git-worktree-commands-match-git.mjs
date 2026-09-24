#!/usr/bin/env bun
// git rev-parse, ls-files and diff over the Nimbus VFS print what the real
// git on this machine prints for the same repository: the same bytes on
// stdout, the same exit code. Each scenario is built on disk with real git,
// mirrored into a SqliteVFS (its .git included), and both gits run the same
// command in the same state. The edits are chosen so the minimal diff is
// unique; where it is not, git's hunk placement is not a contract, and
// unified-diff-applies.mjs holds the patches to `git apply` instead.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { runGitCommand } from '../../packages/worker/src/git/commands.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const GIT_ENV = {
  PATH: process.env.PATH,
  HOME: '/nonexistent',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com', GIT_COMMITTER_DATE: '1700000000 +0000',
  LC_ALL: 'C',
  GIT_CEILING_DIRECTORIES: tmpdir(),
};

const scratch = mkdtempSync(join(tmpdir(), 'nimbus-git-match-'));
const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
const kernel = vfs.as(CRED_KERNEL);
const user = vfs.as(CRED_SESSION_USER);
kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
kernel.chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);

function realGit(cwd, args, env = {}) {
  const r = spawnSync('git', args, { cwd, env: { ...GIT_ENV, ...env } });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr.toString('utf8') };
}

function sh(cwd, ...commands) {
  for (const args of commands) {
    const r = realGit(cwd, args);
    assert.equal(r.code, 0, `git ${args.join(' ')}: ${r.stderr}`);
  }
}

/** Copy a disk tree (its .git included) into the VFS at `to`, modes and all. */
function mirror(from, to) {
  user.mkdir(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    const dst = `${to}/${name}`;
    const st = lstatSync(src);
    if (st.isDirectory()) mirror(src, dst);
    else if (st.isSymbolicLink()) user.symlink(readlinkSync(src), dst);
    else {
      user.writeFile(dst, new Uint8Array(readFileSync(src)));
      user.chmod(dst, st.mode & 0o777);
    }
  }
}

async function nimbusGit(cwd, args, env = {}) {
  const chunks = [];
  let stderr = '';
  const code = await runGitCommand({
    pid: 1,
    cred: CRED_SESSION_USER,
    args,
    cwd,
    env: { USER: 'a', ...env },
    stdout: {
      write(s) { chunks.push(Buffer.from(s, 'utf8')); },
      writeBytes(bytes) { chunks.push(Buffer.from(bytes)); },
    },
    stderr: { write(s) { stderr += s; } },
  }, vfs);
  return { code, stdout: Buffer.concat(chunks), stderr };
}

let checks = 0;
/** Run `args` in both repositories; stdout must match byte for byte once roots are swapped. */
async function same(label, { disk, virtual }, args, { env = {}, stderr = false } = {}) {
  const expected = realGit(disk, args, env);
  const actual = await nimbusGit(virtual, args, env);
  const want = Buffer.from(expected.stdout.toString('latin1').split(diskRoot).join(vfsRoot), 'latin1');
  assert.equal(actual.code, expected.code, `${label}: exit code (stderr: ${actual.stderr})`);
  assert.equal(actual.stdout.toString('latin1'), want.toString('latin1'), `${label}: stdout`);
  if (stderr) assert.equal(actual.stderr, expected.stderr.split(diskRoot).join(vfsRoot), `${label}: stderr`);
  checks++;
}

const diskRoot = join(scratch, 'home');
const vfsRoot = '/home/user/w';
mkdirSync(diskRoot);

try {
  // ── A repository with every kind of change git diff and ls-files report ──
  const repo = join(diskRoot, 'repo');
  mkdirSync(repo);
  sh(repo, ['init', '-q', '-b', 'main']);
  const put = (path, content, mode) => {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), content);
    if (mode) chmodSync(join(repo, path), mode);
  };
  const lines = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}\n`).join('');
  put('a.txt', 'a\n');
  put('nonl.txt', 'x\ny');
  put('gone.txt', 'keep\n');
  put('mode.sh', 'echo m\n', 0o644);
  put('b.bin', Buffer.from([0x62, 0x69, 0x6e, 0, 0x61, 0x72, 0x79]));
  put('empty', '');
  put('sp ace.txt', 's\n');
  put('tab\tname', 't\n');
  put('é.txt', 'accent\n');
  put('quote"mark', 'q\n');
  put('sub/deep/x', 'x1\n');
  put('long.c', `#include <stdio.h>\n\nint main(void) {\n${lines(1, 40)}  return 0;\n}\n\nstatic int helper(int v) {\n${lines(41, 60)}}\n`);
  put('many.txt', lines(1, 100));
  put('.gitignore', 'ign*\nbuild/\n');
  sh(repo, ['add', '-A'], ['commit', '-q', '-m', 'seed']);

  put('a.txt', 'a\nb\n');
  put('nonl.txt', 'x\ny\nz\n');
  rmSync(join(repo, 'gone.txt'));
  chmodSync(join(repo, 'mode.sh'), 0o755);
  put('b.bin', Buffer.from([0x62, 0x69, 0x6e, 0, 0x61, 0x72, 0x79, 0x32]));
  put('sp ace.txt', 's2\n');
  put('tab\tname', 't2\n');
  put('é.txt', 'accent 2\n');
  put('long.c', `#include <stdio.h>\n\nint main(void) {\n${lines(1, 20)}  changed in main\n${lines(22, 40)}  return 0;\n}\n\nstatic int helper(int v) {\n${lines(41, 55)}  changed in helper\n${lines(57, 60)}}\n`);
  // Two edits 6 lines apart share a hunk, 7 apart do not (2 * 3 lines of context).
  put('many.txt', lines(1, 100).replace('line 10\n', 'ten\n').replace('line 17\n', 'seventeen\n')
    .replace('line 40\n', 'forty\n').replace('line 48\n', 'forty-eight\n').replace('line 100\n', 'hundred'));
  put('new.txt', 'new\n');
  put('empty2', '');
  put('sub/deep/x', 'x2\n');
  sh(repo, ['add', 'new.txt', 'empty2', 'sub/deep/x']);
  put('sub/deep/x', 'x3\n');
  put('ignored.txt', 'i\n');
  put('build/out.o', 'o\n');
  put('newdir/n', 'n\n');
  put('untracked sp.txt', 'u\n');
  // cf-git's index splits paths on backslashes too, so a tracked one is out of scope; an untracked one is not.
  put('back\\slash', 'b\n');
  mkdirSync(join(repo, 'nested'));
  sh(join(repo, 'nested'), ['init', '-q']);
  put('nested/z', 'z\n');

  mirror(repo, `${vfsRoot}/repo`);
  const at = (sub = '') => ({ disk: join(repo, sub), virtual: `${vfsRoot}/repo${sub ? `/${sub}` : ''}` });

  // rev-parse
  for (const args of [
    ['rev-parse', '--show-toplevel'],
    ['rev-parse', '--git-dir'],
    ['rev-parse', '--is-inside-work-tree'],
    ['rev-parse', 'HEAD'],
    ['rev-parse', '--verify', 'HEAD'],
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    ['rev-parse', 'main'],
    ['rev-parse', '--show-toplevel', '--git-dir', '--is-inside-work-tree', 'HEAD'],
    ['rev-parse', '--verify', '-q', 'nosuchref'],
  ]) await same(args.join(' '), at(), args, { stderr: true });
  await same('rev-parse from a subdirectory', at('sub/deep'), ['rev-parse', '--show-toplevel', '--git-dir', '--is-inside-work-tree']);
  await same('rev-parse inside .git', at('.git'), ['rev-parse', '--is-inside-work-tree', '--git-dir']);
  await same('rev-parse below .git', at('.git/refs'), ['rev-parse', '--git-dir', '--is-inside-work-tree']);
  await same('rev-parse --show-toplevel inside .git', at('.git'), ['rev-parse', '--show-toplevel'], { stderr: true });
  await same('rev-parse --verify of a non-revision', at(), ['rev-parse', '--verify', 'nosuchref'], { stderr: true });

  // ls-files
  for (const args of [
    ['ls-files'],
    ['ls-files', '-z'],
    ['ls-files', '--others'],
    ['ls-files', '--others', '--exclude-standard'],
    ['ls-files', '--others', '--exclude-standard', '-z'],
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    ['ls-files', '-m'],
    ['ls-files', '-d'],
    ['ls-files', '-m', '-d'],
    ['ls-files', '-cd'],
    ['ls-files', '--', 'sub'],
  ]) await same(args.join(' '), at(), args);
  await same('ls-files from a subdirectory', at('sub'), ['ls-files']);
  await same('ls-files from a subdirectory, a path outside it', at('sub'), ['ls-files', '../a.txt']);

  // diff
  for (const args of [
    ['diff'],
    ['--no-pager', 'diff'],
    ['diff', 'HEAD', '--'],
    ['diff', 'HEAD'],
    ['diff', '--no-ext-diff', '--no-renames', 'HEAD', '--'],
    ['diff', '--cached'],
    ['diff', '--staged', 'HEAD'],
    ['diff', '--stat'],
    ['diff', '--stat', 'HEAD'],
    ['diff', '--stat', '--cached'],
    ['diff', '--name-only', 'HEAD'],
    ['diff', '--name-status', 'HEAD'],
    ['diff', '-z', '--name-only', 'HEAD'],
    ['diff', '-z', '--name-status', 'HEAD', '--'],
    ['diff', '-U1', 'HEAD'],
    ['diff', '--unified=0'],
    ['diff', 'HEAD', '--', 'sub', 'a.txt'],
    ['diff', 'a.txt'],
  ]) await same(args.join(' '), at(), args);
  await same('diff --stat at 40 columns', at(), ['diff', '--stat', 'HEAD'], { env: { COLUMNS: '40' } });
  await same('diff --stat at 200 columns', at(), ['diff', '--stat', 'HEAD'], { env: { COLUMNS: '200' } });
  await same('diff from a subdirectory', at('sub'), ['diff', 'HEAD']);
  for (const args of [
    ['diff', '--no-index', '--', '/dev/null', 'newdir/n'],
    ['diff', '--no-index', '--no-ext-diff', '--no-renames', '--', '/dev/null', 'untracked sp.txt'],
    ['diff', '--no-index', '--', '/dev/null', 'back\\slash'],
    ['diff', '--no-index', '--', '/dev/null', 'empty2'],
    ['diff', '--no-index', '--', 'a.txt', 'nonl.txt'],
    ['diff', '--no-index', '--', 'a.txt', 'a.txt'],
    ['diff', '--no-index', '--', 'new.txt', '/dev/null'],
    ['diff', '--no-index', '--stat', '--', '/dev/null', 'new.txt'],
    ['diff', '--no-index', '--name-status', '--', 'a.txt', 'new.txt'],
    ['diff', '--no-index', '--name-only', '--', 'new.txt', '/dev/null'],
    ['diff', '--no-index', '--', '/dev/null', 'missing.txt'],
  ]) await same(args.join(' '), at(), args, { stderr: args.includes('missing.txt') });
  await same('diff --no-index outside any repository', { disk: diskRoot, virtual: vfsRoot },
    ['diff', '--no-index', '--', '/dev/null', 'repo/new.txt']);

  // ── --stat scaling: long names are cut at a '/', big changes scale to the columns left ──
  const wide = join(diskRoot, 'wide');
  const deep = 'very/long/directory/name/that/keeps/going/and/going/forever/and/ever';
  mkdirSync(join(wide, deep), { recursive: true });
  sh(wide, ['init', '-q', '-b', 'main']);
  const seq = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `${from + i}\n`).join('');
  writeFileSync(join(wide, deep, 'file-with-a-long-name.txt'), seq(1, 200));
  writeFileSync(join(wide, 'short.txt'), seq(1, 5));
  writeFileSync(join(wide, 'tab\there.txt'), seq(1, 3));
  sh(wide, ['add', '-A'], ['commit', '-q', '-m', 'c']);
  writeFileSync(join(wide, deep, 'file-with-a-long-name.txt'), seq(1000, 1300));
  writeFileSync(join(wide, 'short.txt'), seq(2, 7));
  writeFileSync(join(wide, 'tab\there.txt'), seq(4, 9));
  mirror(wide, `${vfsRoot}/wide`);
  for (const columns of ['40', '60', '80', '120', '200']) {
    await same(`diff --stat at ${columns} columns`, { disk: wide, virtual: `${vfsRoot}/wide` }, ['diff', '--stat'],
      { env: { COLUMNS: columns } });
  }

  // ── An unborn repository: HEAD names no commit yet ──
  const unborn = join(diskRoot, 'unborn');
  mkdirSync(unborn);
  sh(unborn, ['init', '-q', '-b', 'main']);
  writeFileSync(join(unborn, 'f.txt'), 'f\n');
  sh(unborn, ['add', 'f.txt']);
  mirror(unborn, `${vfsRoot}/unborn`);
  const bare = { disk: unborn, virtual: `${vfsRoot}/unborn` };
  await same('rev-parse HEAD, unborn', bare, ['rev-parse', 'HEAD'], { stderr: true });
  await same('rev-parse --verify HEAD, unborn', bare, ['rev-parse', '--verify', 'HEAD'], { stderr: true });
  await same('rev-parse --verify -q HEAD, unborn', bare, ['rev-parse', '--verify', '-q', 'HEAD'], { stderr: true });
  await same('diff HEAD --, unborn', bare, ['diff', 'HEAD', '--'], { stderr: true });
  await same('diff --cached, unborn', bare, ['diff', '--cached']);
  await same('ls-files --cached --others --exclude-standard -z, unborn', bare,
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);

  // ── Outside any repository ──
  const nowhere = { disk: diskRoot, virtual: vfsRoot };
  await same('rev-parse outside any repository', nowhere, ['rev-parse', '--show-toplevel'], { stderr: true });
  await same('ls-files outside any repository', nowhere, ['ls-files'], { stderr: true });

  // ── A reader that goes away (`git diff | head -1`): git dies of SIGPIPE, 141, silently ──
  let stderr = '';
  const code = await runGitCommand({
    pid: 1, cred: CRED_SESSION_USER, args: ['diff', 'HEAD'], cwd: `${vfsRoot}/repo`, env: {},
    stdout: {
      write() { throw Object.assign(new Error('EPIPE: pipe reader closed'), { code: 'EPIPE' }); },
      writeBytes() { throw Object.assign(new Error('EPIPE: pipe reader closed'), { code: 'EPIPE' }); },
    },
    stderr: { write(s) { stderr += s; } },
  }, vfs);
  assert.deepEqual({ code, stderr }, { code: 141, stderr: '' });

  console.log(`git-worktree-commands-match-git: ${checks} commands byte-identical to ${realGit(scratch, ['--version']).stdout.toString().trim()}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
