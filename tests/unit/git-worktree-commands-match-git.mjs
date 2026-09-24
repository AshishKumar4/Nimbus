#!/usr/bin/env bun
// git rev-parse, ls-files and diff over the Nimbus VFS print what the real
// git on this machine prints for the same repository: the same bytes on
// stdout, the same exit code. Each scenario is built on disk with real git,
// mirrored into a SqliteVFS (its .git included), and both gits run the same
// command in the same state. Symlinks, type changes and renames are part of
// it. The edits are chosen so the minimal diff is unique; where it is not,
// git's hunk placement is not a contract, and unified-diff-applies.mjs holds
// the patches to `git apply` instead.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
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

/** Copy a VFS tree (its .git included) back to disk, links as links. */
function copyOut(from, to) {
  mkdirSync(to, { recursive: true });
  for (const { name, type } of user.readdir(from)) {
    const src = `${from}/${name}`;
    const dst = join(to, name);
    if (type === 'directory') copyOut(src, dst);
    else if (type === 'symlink') symlinkSync(user.readlink(src), dst);
    else {
      writeFileSync(dst, user.readFile(src));
      chmodSync(dst, user.lstat(src).mode & 0o777);
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
  const link = (path, target) => {
    rmSync(join(repo, path), { force: true });
    symlinkSync(target, join(repo, path));
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
  link('link', 'a.txt');
  link('dangling', 'missing-target');
  link('dirlink', 'sub');
  link('retarget', 'a.txt');
  put('becomes-link', 'f\n');
  link('becomes-file', 'a.txt');
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
  // A tracked link changes target, a file becomes a link and a link a file; the rest stay put.
  link('retarget', 'nonl.txt');
  link('becomes-link', 'a.txt');
  rmSync(join(repo, 'becomes-file'));
  put('becomes-file', 'now a file\n');
  link('newlink', 'a.txt');
  link('newdirlink', 'sub');

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

  // ── Renames: exact (ties go to the same basename, then path order), unique basenames, then similarity ──
  const moves = join(diskRoot, 'renames');
  const moved = { disk: moves, virtual: `${vfsRoot}/renames` };
  const write = (path, content, mode) => {
    mkdirSync(join(moves, path, '..'), { recursive: true });
    writeFileSync(join(moves, path), content);
    if (mode) chmodSync(join(moves, path), mode);
  };
  const padded = (prefix, from, to) => Array.from({ length: to - from + 1 }, (_, i) => `${prefix} ${String(from + i).padStart(2, '0')}\n`).join('');
  const binary = Buffer.concat(Array.from({ length: 50 }, () => Buffer.from('bin\0ary\0data')));
  mkdirSync(moves);
  sh(moves, ['init', '-q', '-b', 'main']);
  write('old-name.txt', 'x\n');
  write('moved.txt', seq(1, 30));
  for (const path of ['a/dup.txt', 'b/dup.txt', 'c/other.txt']) write(path, 'same\n');
  write('empty1', '');
  symlinkSync('target', join(moves, 'lnk'));
  write('mode.sh', 'm\n', 0o644);
  write('sp ace.txt', 'spaces\n');
  write('blob.bin', binary);
  write('small.txt', seq(1, 10));
  // src/util.js keeps 16 of lib/util.js's 20 lines (80%) and 19 of lib/helpers.js's (95%).
  write('lib/util.js', padded('common', 1, 16) + padded('u-only', 1, 4));
  write('lib/helpers.js', padded('common', 1, 16) + padded('h-only', 1, 4));
  write('crlf.txt', padded('line', 1, 10).replaceAll('\n', '\r\n'));
  sh(moves, ['add', '-A'], ['commit', '-q', '-m', 'seed']);
  sh(moves, ['mv', 'old-name.txt', 'new-name.txt']);
  mkdirSync(join(moves, 'sub'));
  sh(moves, ['mv', 'moved.txt', 'sub/moved.txt']);
  write('sub/moved.txt', seq(1, 29));
  sh(moves, ['rm', '-q', 'a/dup.txt', 'b/dup.txt', 'c/other.txt', 'empty1', 'lnk', 'mode.sh', 'sp ace.txt',
    'blob.bin', 'small.txt', 'lib/util.js', 'lib/helpers.js', 'crlf.txt']);
  write('d/dup.txt', 'same\n');
  write('e/x.txt', 'same\n');
  write('empty2', '');
  symlinkSync('target', join(moves, 'lnk2'));
  write('mode2.sh', 'm\n', 0o755);
  write('q"uote.txt', 'spaces\n');
  write('blob2.bin', Buffer.concat([binary, Buffer.from('more')]));
  write('small2.txt', seq(1, 3));
  write('src/util.js', padded('common', 1, 16) + padded('h-only', 1, 3) + padded('s-only', 1, 1));
  write('lf.txt', padded('line', 1, 10));
  sh(moves, ['add', '-A']);
  // In the worktree the renamed file keeps exactly half of its source: 50%, the default bar itself.
  write('new-name.txt', 'x\ny\n');
  mirror(moves, moved.virtual);
  for (const args of [
    ['diff', '--cached'],
    ['diff', '--cached', '--name-status'],
    ['diff', '--cached', '-z', '--name-status'],
    ['diff', '--cached', '--name-only'],
    ['diff', '--cached', '--stat'],
    ['diff', 'HEAD'],
    ['diff', 'HEAD', '--name-status'],
    ['diff', 'HEAD', '--stat'],
    ['diff', '--name-status'],
    ['diff', '--cached', '--no-renames', '--name-status'],
    ['diff', '--cached', '-M', '--name-status'],
    ['diff', '--cached', '-M0', '--name-status'],
    ['diff', '--cached', '-M7', '--name-status'],
    ['diff', '--cached', '-M90%', '--name-status'],
    ['diff', '--cached', '--find-renames=100%', '--name-status'],
    ['diff', '--cached', '--name-status', '--', 'sub', 'lib', 'src'],
  ]) await same(args.join(' '), moved, args);
  await same('diff --cached --stat at 40 columns', moved, ['diff', '--cached', '--stat'], { env: { COLUMNS: '40' } });

  // Past diff.renameLimit squared candidate pairs git skips the similarity pass, and says so.
  const crowd = join(diskRoot, 'crowd');
  mkdirSync(crowd);
  sh(crowd, ['init', '-q', '-b', 'main']);
  for (let i = 1; i <= 1001; i++) writeFileSync(join(crowd, `old${i}`), `old ${i}\n`);
  sh(crowd, ['add', '-A'], ['commit', '-q', '-m', 'c'], ['rm', '-q', '-r', '.']);
  for (let i = 1; i <= 1001; i++) writeFileSync(join(crowd, `new${i}`), `new ${i}\n`);
  sh(crowd, ['add', '-A']);
  mirror(crowd, `${vfsRoot}/crowd`);
  await same('diff --cached --name-status past the rename limit', { disk: crowd, virtual: `${vfsRoot}/crowd` },
    ['diff', '--cached', '--name-status'], { stderr: true });

  // ── Symlinks committed through Nimbus stay links: real git reads back the tree it would have made ──
  const links = join(diskRoot, 'links');
  const linked = { disk: links, virtual: `${vfsRoot}/links` };
  mkdirSync(join(links, 'sub'), { recursive: true });
  writeFileSync(join(links, 'a.txt'), 'a\n');
  writeFileSync(join(links, 'target.txt'), 'target content\n');
  writeFileSync(join(links, 'sub/f'), 'f\n');
  symlinkSync('target.txt', join(links, 'link'));
  symlinkSync('nowhere', join(links, 'dangling'));
  symlinkSync('sub', join(links, 'dirlink'));
  mirror(links, linked.virtual);
  sh(links, ['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-q', '-m', 'c']);
  for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-qm', 'c']]) {
    assert.equal((await nimbusGit(linked.virtual, args)).code, 0, `git ${args.join(' ')}`);
  }
  writeFileSync(join(links, 'a.txt'), 'a2\n');
  user.writeFile(`${linked.virtual}/a.txt`, 'a2\n');
  sh(links, ['commit', '-q', '-a', '-m', 'edit a.txt only']);
  assert.equal((await nimbusGit(linked.virtual, ['commit', '-qam', 'edit a.txt only'])).code, 0);
  for (const args of [['ls-files'], ['ls-files', '-m'], ['diff'], ['diff', 'HEAD']]) await same(`links: ${args.join(' ')}`, linked, args);
  const copy = join(scratch, 'links-from-nimbus');
  copyOut(linked.virtual, copy);
  const lsTree = (cwd) => realGit(cwd, ['ls-tree', '-r', 'HEAD']).stdout.toString();
  assert.equal(lsTree(copy), lsTree(links), 'the commit Nimbus made holds the tree real git makes');
  assert.equal(realGit(copy, ['fsck', '--strict', '--no-progress']).code, 0);
  assert.equal(realGit(copy, ['status', '--porcelain']).stdout.toString(), '');
  checks++;
  // Checking out a branch that points the link elsewhere, then back, rewrites the link in place.
  sh(links, ['checkout', '-q', '-b', 'side']);
  rmSync(join(links, 'link'));
  symlinkSync('sub/f', join(links, 'link'));
  sh(links, ['commit', '-q', '-a', '-m', 'retarget'], ['checkout', '-q', 'main']);
  await nimbusGit(linked.virtual, ['checkout', '-q', '-b', 'side']);
  user.unlink(`${linked.virtual}/link`);
  user.symlink('sub/f', `${linked.virtual}/link`);
  assert.equal((await nimbusGit(linked.virtual, ['commit', '-qam', 'retarget'])).code, 0);
  assert.equal((await nimbusGit(linked.virtual, ['checkout', '-q', 'master'])).code, 0);
  assert.equal(user.readlink(`${linked.virtual}/link`), readlinkSync(join(links, 'link')));
  for (const args of [['ls-files', '-m'], ['diff', 'HEAD']]) await same(`links after checkout: ${args.join(' ')}`, linked, args);

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
