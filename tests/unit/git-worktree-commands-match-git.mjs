#!/usr/bin/env bun
// git rev-parse, ls-files and diff over the Nimbus VFS print what the real
// git on this machine prints for the same repository: the same bytes on
// stdout, the same exit code. Each scenario is built on disk with real git,
// mirrored into a SqliteVFS (its .git included), and both gits run the same
// command in the same state. Symlinks, type changes and renames are part of
// it. The edits are chosen so the minimal diff is unique; where it is not,
// git's hunk placement is not a contract, and unified-diff-applies.mjs holds
// the patches to `git apply` instead. checkout, reset --hard, merge and pull
// (through the network facet) across a link/directory type change must leave
// the worktree and index real git leaves, and the link's target untouched. A
// same-size rewrite in the second of `git add` shows in both, as it does in git.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteRuntimeFsBridge } from '../../packages/core/src/runtime/sqlite-runtime-fs-bridge.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { getSymlinkRegistry } from '../../packages/core/src/vfs/symlink-registry.ts';
import { GIT_BUNDLE_CODE } from '../../packages/worker/src/git-bundle.generated.ts';
import { runGitCommand } from '../../packages/worker/src/git/commands.ts';
import { assembleGitNetworkFacetSource } from '../../packages/worker/src/git/network-facet.ts';
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

let server;
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

  // ── A path that is a link on one branch and a directory on the other ──
  // git replaces the link with a real directory and never writes through a
  // leading link (has_symlink_leading_path), so the link's target stays as it was.
  const types = join(diskRoot, 'types');
  const typed = { disk: types, virtual: `${vfsRoot}/types` };
  const typedIn = (sub) => ({ disk: join(types, sub), virtual: `${typed.virtual}/${sub}` });
  const outside = join(diskRoot, 'types-outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'keep.txt'), 'keep\n');
  mkdirSync(join(types, 'sub'), { recursive: true });
  sh(types, ['init', '-q', '-b', 'main']);
  writeFileSync(join(types, 'f.txt'), 'f\n');
  writeFileSync(join(types, 'sub/s'), 's\n');
  symlinkSync('../types-outside', join(types, 'd'));
  symlinkSync('nowhere', join(types, 'dangling'));
  sh(types, ['add', '-A'], ['commit', '-q', '-m', 'links'], ['checkout', '-q', '-b', 'b']);
  for (const name of ['d', 'dangling']) {
    rmSync(join(types, name));
    mkdirSync(join(types, name));
  }
  writeFileSync(join(types, 'd/x'), 'x\n');
  writeFileSync(join(types, 'dangling/y'), 'y\n');
  sh(types, ['add', '-A'], ['commit', '-q', '-m', 'directories']);
  mirror(types, typed.virtual);
  mirror(outside, `${vfsRoot}/types-outside`);
  /** The worktree (its .git aside) as `path kind content-or-target` lines. */
  const diskTree = (root, sub = '') => readdirSync(join(root, sub)).sort().flatMap((name) => {
    const path = sub ? `${sub}/${name}` : name;
    if (path === '.git') return [];
    const st = lstatSync(join(root, path));
    if (st.isSymbolicLink()) return [`${path} link ${readlinkSync(join(root, path))}`];
    if (st.isDirectory()) return [`${path}/`, ...diskTree(root, path)];
    return [`${path} file ${readFileSync(join(root, path), 'utf8')}`];
  });
  const vfsTree = (root, sub = '') => user.readdir(sub ? `${root}/${sub}` : root).map(({ name }) => name).sort().flatMap((name) => {
    const path = sub ? `${sub}/${name}` : name;
    if (path === '.git') return [];
    const st = user.lstat(`${root}/${path}`);
    if (st.type === 'symlink') return [`${path} link ${user.readlink(`${root}/${path}`)}`];
    // A directory or file that replaced a link keeps none of the link's mode.
    assert.notEqual(st.mode & 0o170000, 0o120000, `${root}/${path}: a ${st.type} with a link's mode`);
    if (st.type === 'directory') return [`${path}/`, ...vfsTree(root, path)];
    return [`${path} file ${new TextDecoder().decode(user.readFile(`${root}/${path}`))}`];
  });
  let copies = 0;
  /** A disk copy of a VFS repository, for real git to read. */
  const copyOf = (repo) => {
    const to = join(scratch, `copy-${copies++}`);
    copyOut(repo.virtual, to);
    return to;
  };
  /** Write `path` in both worktrees of `repo`, parents made. */
  const rewriteBoth = (repo, path, content) => {
    mkdirSync(join(repo.disk, path, '..'), { recursive: true });
    writeFileSync(join(repo.disk, path), content);
    user.mkdir(`${repo.virtual}/${path}`.split('/').slice(0, -1).join('/'), { recursive: true });
    user.writeFile(`${repo.virtual}/${path}`, content);
  };
  /** The same worktree (the link's target directory untouched) and the same index, as both gits list them. */
  const sameWorktree = async (label, repo) => {
    assert.deepEqual(vfsTree(repo.virtual), diskTree(repo.disk), `${label}: worktree`);
    assert.deepEqual(vfsTree(`${vfsRoot}/types-outside`), ['keep.txt file keep\n'], `${label}: the link's target directory`);
    assert.deepEqual(diskTree(outside), ['keep.txt file keep\n']);
    for (const cmd of [['ls-files'], ['ls-files', '-m', '-d', '-o'], ['diff', 'HEAD'], ['diff', '--cached']]) {
      await same(`${label}: ${cmd.join(' ')}`, repo, cmd);
    }
  };
  /** Both gits run `args`, exit alike (stderr too, when asked), and leave the same worktree and index. */
  const typeChange = async (label, args, { at = typed, stderr = false } = {}) => {
    const expected = realGit(at.disk, args);
    const actual = await nimbusGit(at.virtual, args);
    assert.equal(actual.code, expected.code, `${label}: exit code (git: ${expected.stderr}; nimbus: ${actual.stderr})`);
    if (stderr) assert.equal(actual.stderr, expected.stderr.split(diskRoot).join(vfsRoot), `${label}: stderr`);
    await sameWorktree(label, typed);
  };
  await typeChange('checkout a branch where the directories are links', ['checkout', '-q', 'main']);
  await typeChange('checkout back to the directories', ['checkout', '-q', 'b']);
  await typeChange('checkout the links again', ['checkout', '-q', 'main']);
  await typeChange('checkout -b at the links', ['checkout', '-q', '-b', 'r']);
  await typeChange('reset --hard onto the directories', ['reset', '-q', '--hard', 'b']);
  await typeChange('checkout the directories by name', ['checkout', '-q', 'b']);
  // A pathspec restores a file from the index; a link where its directory belongs is replaced, not followed.
  const relink = (name, target) => {
    rmSync(join(types, name), { recursive: true });
    symlinkSync(target, join(types, name));
    for (const { name: child } of user.readdir(`${typed.virtual}/${name}`)) user.unlink(`${typed.virtual}/${name}/${child}`);
    user.rmdir(`${typed.virtual}/${name}`);
    user.symlink(target, `${typed.virtual}/${name}`);
  };
  relink('d', '../types-outside');
  relink('dangling', 'nowhere');
  await typeChange('checkout -- a path below a link', ['checkout', '--', 'd/x']);
  await typeChange('checkout -- a path through ..', ['checkout', '--', 'sub/../dangling/y']);
  relink('dangling', 'nowhere');
  await typeChange('checkout -- from a subdirectory, up through ..', ['checkout', '--', '../dangling/y'], { at: typedIn('sub') });
  await typeChange('checkout -- a path outside the repository', ['checkout', '--', '../types-outside/keep.txt'], { stderr: true });
  await typeChange('checkout -- a path git does not know', ['checkout', '--', 'nope'], { stderr: true });
  user.writeFile(`${typed.virtual}/f.txt`, 'changed\n');
  writeFileSync(join(types, 'f.txt'), 'changed\n');
  await typeChange('checkout -- a modified file', ['checkout', '--', 'f.txt']);
  // A fast-forward merge moves the worktree the way a checkout does.
  await typeChange('checkout the links to merge into', ['checkout', '-q', 'main']);
  await typeChange('merge the directories in', ['merge', 'b']);

  // A branch without `d`, for a pull that removes the directory.
  sh(types, ['checkout', '-q', '-b', 'nod'], ['rm', '-rq', 'd'], ['commit', '-q', '-m', 'no d'], ['checkout', '-q', 'main']);

  // pull runs in the network facet (the bundled cf-git over its buffered fs), from one smart-HTTP server.
  const served = join(scratch, 'served');
  mkdirSync(served);
  sh(scratch, ['clone', '-q', '--bare', types, join(served, 'types.git')]);
  const servedTypes = join(served, 'types.git');
  const commitOf = (rev) => realGit(types, ['rev-parse', rev]).stdout.toString().trim();
  sh(servedTypes, ['update-ref', 'refs/heads/main', commitOf('b~1')]);
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === 'POST' ? new Uint8Array(await request.arrayBuffer()) : null;
      const child = Bun.spawn(['git', 'http-backend'], {
        env: {
          ...GIT_ENV,
          GIT_PROJECT_ROOT: served,
          GIT_HTTP_EXPORT_ALL: '1',
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: request.method,
          CONTENT_TYPE: request.headers.get('content-type') ?? '',
          CONTENT_LENGTH: body ? String(body.length) : '',
          HTTP_CONTENT_ENCODING: request.headers.get('content-encoding') ?? '',
          GIT_PROTOCOL: request.headers.get('git-protocol') ?? '',
        },
        stdin: body ? new Blob([body]) : 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
      });
      const out = new Uint8Array(await new Response(child.stdout).arrayBuffer());
      await child.exited;
      const split = Buffer.from(out).indexOf('\r\n\r\n');
      const headers = new Headers();
      let status = 200;
      for (const line of new TextDecoder().decode(out.subarray(0, split)).split('\r\n')) {
        const colon = line.indexOf(':');
        const name = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === 'status') status = parseInt(value, 10);
        else headers.set(name, value);
      }
      return new Response(out.subarray(split + 4), { status, headers });
    },
  });
  /** Real git as a child the event loop keeps serving: it fetches from this process's server. */
  const realGitAsync = async (cwd, args) => {
    const child = Bun.spawn(['git', ...args], { cwd, env: GIT_ENV, stdout: 'pipe', stderr: 'pipe' });
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    assert.equal(code, 0, `real git ${args.join(' ')}: ${stderr}`);
  };
  const moduleDir = join(scratch, 'facet');
  mkdirSync(moduleDir);
  writeFileSync(join(moduleDir, 'git-network-worker.mjs'), assembleGitNetworkFacetSource());
  writeFileSync(join(moduleDir, 'git-bundle.js'), GIT_BUNDLE_CODE);
  const facet = await import(pathToFileURL(join(moduleDir, 'git-network-worker.mjs')).href);
  const bridge = new SqliteRuntimeFsBridge(user, vfs);
  const facetEnv = {
    SUPERVISOR: {
      stat: async (path) => bridge.stat(path),
      lstat: async (path) => bridge.stat(path, { followSymlinks: false }),
      hasLegacySymlinkUnder: async (path) => getSymlinkRegistry(vfs).hasAtOrBelow(path),
      readdir: async (path) => bridge.readdir(path),
      readFileBytes: async (path) => bridge.readFile(path),
      readlink: async (path) => bridge.readlink(path),
      fsReadRange: async (path, offset, length) => bridge.readRange(path, offset, length),
      writeBatchStream: async (stream) => user.writeStream(stream),
      async stdout() {},
    },
  };
  const pulled = { disk: join(diskRoot, 'pulled'), virtual: `${vfsRoot}/pulled` };
  await realGitAsync(diskRoot, ['clone', '-q', `http://127.0.0.1:${server.port}/types.git`, pulled.disk]);
  mirror(pulled.disk, pulled.virtual);
  await sameWorktree('a clone at the links', pulled);
  /** Both gits pull `rev` of the served repository; both succeed or both refuse, and the repositories agree. */
  const pullBoth = async (label, rev) => {
    sh(servedTypes, ['update-ref', 'refs/heads/main', commitOf(rev)]);
    const child = Bun.spawn(['git', 'pull', '-q', 'origin', 'main'], { cwd: pulled.disk, env: GIT_ENV, stdout: 'pipe', stderr: 'pipe' });
    const [gitStderr, gitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    const response = await facet.default.fetch(new Request('http://git/op', {
      method: 'POST',
      body: JSON.stringify({ op: 'pull', dir: pulled.virtual, remote: 'origin', ref: 'main', author: { name: 'a', email: 'a@example.com' } }),
    }), facetEnv);
    const pull = await response.json();
    assert.equal(pull.success, gitCode === 0, `${label}: git exits ${gitCode} (${gitStderr}); nimbus: ${pull.error}`);
    if (gitCode !== 0) assert.equal(`${pull.error}\n`, gitStderr.replace(/^error: /, ''), `${label}: the refusal`);
    assert.equal(realGit(pulled.disk, ['rev-parse', 'HEAD']).stdout.toString(), realGit(copyOf(pulled), ['rev-parse', 'HEAD']).stdout.toString(), `${label}: HEAD`);
    await sameWorktree(label, pulled);
  };
  await pullBoth('pull the directories over the links', 'b');
  // A directory the pulled commit drops keeps the untracked files in it, as rmdir(2) keeps them.
  rewriteBoth(pulled, 'd/u', 'untracked\n');
  await pullBoth('pull a commit without the directory, an untracked file in it', 'nod');

  // ── A same-size rewrite in the second the index was written ──
  // Its stat still matches the index entry, so only git's racily-clean rule
  // (read-cache.c is_racy_timestamp) sees it: an entry whose mtime is not older
  // than the index file's is compared by content. The clock is never moved:
  // each step starts on a fresh second, and one that crosses into the next is
  // run again. Both gits see every step.
  const racy = { disk: join(diskRoot, 'racy'), virtual: `${vfsRoot}/racy` };
  mkdirSync(racy.disk);
  sh(racy.disk, ['init', '-q', '-b', 'main']);
  mirror(racy.disk, racy.virtual);
  const rewrite = (name, content) => {
    writeFileSync(join(racy.disk, name), content);
    user.writeFile(`${racy.virtual.slice(1)}/${name}`, content);
  };
  const both = async (args) => {
    const expected = realGit(racy.disk, args);
    const actual = await nimbusGit(racy.virtual, args);
    assert.equal(expected.code, 0, `git ${args.join(' ')}: ${expected.stderr}`);
    assert.equal(actual.code, 0, `nimbus git ${args.join(' ')}: ${actual.stderr}`);
  };
  /** `step` inside one wall-clock second, from its start. */
  const withinOneSecond = async (step) => {
    for (;;) {
      await Bun.sleep(1000 - (Date.now() % 1000));
      const start = Math.floor(Date.now() / 1000);
      await step();
      if (Math.floor(Date.now() / 1000) === start) return;
    }
  };
  const status = async () => {
    const out = (await nimbusGit(racy.virtual, ['status'])).stdout.toString().replace(/\x1b\[[0-9;]*m/g, '');
    return out === 'nothing to commit, working tree clean\n' ? '' : out;
  };
  const agree = async (label) => {
    assert.equal(await status(), realGit(racy.disk, ['status', '--porcelain']).stdout.toString(), `${label}: status`);
    for (const args of [['diff'], ['diff', '--cached'], ['ls-files', '-m'], ['diff', 'HEAD', '--name-status']]) {
      await same(`${label}: ${args.join(' ')}`, racy, args);
    }
  };
  rewrite('f', 'base\n');
  await both(['add', 'f']);
  await both(['commit', '-qm', 'base']);
  // Rewritten to its committed bytes, staged, and rewritten again, all in one second.
  await withinOneSecond(async () => {
    rewrite('f', 'base\n');
    await both(['add', 'f']);
    rewrite('f', 'next\n');
  });
  await agree('a same-second rewrite after add');
  assert.equal(realGit(racy.disk, ['status', '--porcelain']).stdout.toString(), ' M f\n');
  await both(['commit', '-qam', 'next']);
  await agree('commit -am of a same-second rewrite');
  const committed = join(scratch, 'racy-from-nimbus');
  copyOut(racy.virtual, committed);
  assert.equal(realGit(committed, ['show', 'HEAD:f']).stdout.toString(), 'next\n', 'commit -am committed the rewrite');
  // A later index write that never looks at the file keeps the rewrite visible:
  // git smudges the racily clean entry as it writes (ce_smudge_racily_clean_entry).
  await withinOneSecond(async () => {
    rewrite('f', 'next\n');
    await both(['add', 'f']);
    rewrite('f', 'last\n');
  });
  await Bun.sleep(1000 - (Date.now() % 1000));
  rewrite('g', 'g\n');
  await both(['add', 'g']);
  await agree('a same-second rewrite, then another file staged a second later');

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
  server?.stop(true);
  rmSync(scratch, { recursive: true, force: true });
}
