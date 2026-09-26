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
// Setup before the try below can fail too: the exit hook removes the scratch tree however the test ends.
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));
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
  /** `path` gone from both worktrees. */
  const removeBoth = (repo, path) => {
    rmSync(join(repo.disk, path), { recursive: true, force: true });
    user.removeRecursive(`${repo.virtual}/${path}`);
  };
  const linkBoth = (repo, path, target) => {
    symlinkSync(target, join(repo.disk, path));
    user.symlink(target, `${repo.virtual}/${path}`);
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
  sh(types, ['checkout', '-q', '-b', 'nod'], ['rm', '-rq', 'd'], ['commit', '-q', '-m', 'no d']);
  // And one where `d` is a file.
  writeFileSync(join(types, 'd'), 'd, a file\n');
  sh(types, ['checkout', '-q', '-b', 'dfile'], ['add', 'd'], ['commit', '-q', '-m', 'd, a file'], ['checkout', '-q', 'main']);

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
    if (gitCode !== 0) assert.equal(`${pull.error}\n`, gitStderr, `${label}: the refusal`);
    assert.equal(realGit(pulled.disk, ['rev-parse', 'HEAD']).stdout.toString(), realGit(copyOf(pulled), ['rev-parse', 'HEAD']).stdout.toString(), `${label}: HEAD`);
    await sameWorktree(label, pulled);
  };
  await pullBoth('pull the directories over the links', 'b');
  // A directory the pulled commit drops keeps the untracked files in it, as rmdir(2) keeps them.
  rewriteBoth(pulled, 'd/u', 'untracked\n');
  await pullBoth('pull a commit without the directory, an untracked file in it', 'nod');
  // A pull git refuses moves nothing: not the branch, not the index, not the worktree.
  await pullBoth('pull a file over a directory with an untracked file in it', 'dfile');
  removeBoth(pulled, 'd');
  await pullBoth('pull the file once the directory is gone', 'dfile');

  // ── A branch switch refuses what git refuses, all at once, and keeps what git keeps ──
  // Each repository is built by real git and mirrored; both gits run the
  // command, exit alike with the same stderr, and leave the same HEAD,
  // worktree and index. Unforced, a switch is git's twoway merge of the index
  // against HEAD and the target: a staged or local change the switch does not
  // touch survives, an untracked file is overwritten only if ignored, and a
  // directory a file replaces goes only if nothing untracked is left in it.
  let scenarios = 0;
  /** A repository `build` makes with real git (put, link, rm, git), mirrored into the VFS. */
  const scenario = (build) => {
    const repo = { disk: join(diskRoot, `scenario-${scenarios}`), virtual: `${vfsRoot}/scenario-${scenarios++}` };
    mkdirSync(repo.disk);
    sh(repo.disk, ['init', '-q', '-b', 'main']);
    build({
      put: (path, content) => {
        mkdirSync(join(repo.disk, path, '..'), { recursive: true });
        writeFileSync(join(repo.disk, path), content);
      },
      link: (path, target) => symlinkSync(target, join(repo.disk, path)),
      rm: (path) => rmSync(join(repo.disk, path), { recursive: true, force: true }),
      git: (...args) => sh(repo.disk, args),
    });
    mirror(repo.disk, repo.virtual);
    return repo;
  };
  /**
   * Both gits run `args` in `repo`: the same exit, stderr, HEAD, worktree and index (status
   * included). A commit's id differs (its dates and author do), so `commits` compares trees instead.
   * `sub` runs both from a subdirectory; `stdout` compares what they print; `firstLine` compares
   * only stderr's first line (a usage text below it is this git's own).
   */
  const agreeOn = async (label, repo, args, { commits = false, sub = '', stdout = false, firstLine = false, mask = null, env = {} } = {}) => {
    const expected = realGit(sub ? join(repo.disk, sub) : repo.disk, args, env);
    const actual = await nimbusGit(sub ? `${repo.virtual}/${sub}` : repo.virtual, args, env);
    assert.equal(actual.code, expected.code, `${label}: exit code (git: ${expected.stderr}; nimbus: ${actual.stderr})`);
    const head = (text) => (firstLine ? text.split('\n')[0] : text);
    assert.equal(head(actual.stderr), head(expected.stderr), `${label}: stderr`);
    // `mask` hides what differs by clock alone (a tag object's id: its tagger line carries a time).
    const shown = (text) => (mask ? text.replace(mask, '<masked>') : text);
    if (stdout) assert.equal(shown(actual.stdout.toString()), shown(expected.stdout.toString()), `${label}: stdout`);
    const copy = copyOf(repo);
    for (const probe of [commits ? ['rev-parse', 'HEAD^{tree}'] : ['rev-parse', 'HEAD'], ['symbolic-ref', '-q', 'HEAD'], ['ls-files', '-s'],
      ['status', '--porcelain', '--untracked-files=all', '--ignored']]) {
      assert.equal(realGit(copy, probe).stdout.toString(), realGit(repo.disk, probe).stdout.toString(), `${label}: git ${probe.join(' ')}`);
    }
    assert.deepEqual(vfsTree(repo.virtual), diskTree(repo.disk), `${label}: worktree`);
    checks++;
  };
  /** main tracks `d/x`, k and f; branch b has `d` as a file (or, `asLink`, a link), n, and a changed f. */
  const dirBecomesFile = ({ asLink = false } = {}) => scenario(({ put, link, rm, git }) => {
    put('.gitignore', '*.o\n');
    put('d/x', 'x\n');
    put('k', 'k\n');
    put('f', 'f\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'dir');
    git('checkout', '-q', '-b', 'b');
    rm('d');
    if (asLink) link('d', 'elsewhere');
    else put('d', 'file d\n');
    put('n', 'new\n');
    put('f', 'f2\n');
    put('i.o', 'tracked, and ignored\n');
    git('add', '-A');
    git('add', '-f', 'i.o');
    git('commit', '-q', '-m', 'b');
    git('checkout', '-q', 'main');
  });
  {
    const repo = dirBecomesFile();
    rewriteBoth(repo, 'd/u', 'untracked\n');
    await agreeOn('a switch that would lose an untracked file in a directory it replaces', repo, ['checkout', '-q', 'b']);
    rewriteBoth(repo, 'n', 'mine\n');
    rewriteBoth(repo, 'f', 'local\n');
    await agreeOn('a switch refused for a local change, an untracked directory and an untracked file', repo, ['checkout', 'b']);
    removeBoth(repo, 'n');
    removeBoth(repo, 'd/u');
    rewriteBoth(repo, 'd/u.o', 'ignored\n');
    await agreeOn('a switch refused for a local change alone, an ignored file in the directory', repo, ['checkout', '-q', 'b']);
    rewriteBoth(repo, 'f', 'f\n');
    rewriteBoth(repo, 'i.o', 'ignored, in the way\n');
    await agreeOn('a switch removes the ignored files in its way', repo, ['checkout', '-q', 'b']);
  }
  {
    const repo = dirBecomesFile({ asLink: true });
    rewriteBoth(repo, 'd/u.o', 'ignored\n');
    await agreeOn('a directory with only ignored files in it becomes a link', repo, ['checkout', '-q', 'b']);
    await agreeOn('and the link a directory again', repo, ['checkout', '-q', 'main']);
  }
  {
    const repo = scenario(({ put, git }) => {
      put('k', 'k\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'k');
      git('checkout', '-q', '-b', 'b');
      put('d/x', 'x\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'd');
      git('checkout', '-q', 'main');
    });
    linkBoth(repo, 'd', 'nowhere');
    await agreeOn('an untracked link where the branch has a directory', repo, ['checkout', '-q', 'b']);
    removeBoth(repo, 'd');
    rewriteBoth(repo, 'd/x', 'x\n');
    await agreeOn('an untracked file the branch has, byte for byte', repo, ['checkout', '-q', 'b']);
  }
  {
    const repo = scenario(({ put, git }) => {
      put('f', 'f\n');
      put('g', 'g\n');
      put('s', 's\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'c');
      git('checkout', '-q', '-b', 'b');
      put('f', 'f2\n');
      git('commit', '-q', '-a', '-m', 'b');
      git('checkout', '-q', 'main');
    });
    rewriteBoth(repo, 's', 'staged\n');
    rewriteBoth(repo, 'a', 'added\n');
    for (const path of ['s', 'a']) {
      sh(repo.disk, ['add', path]);
      assert.equal((await nimbusGit(repo.virtual, ['add', path])).code, 0);
    }
    rewriteBoth(repo, 'g', 'local\n');
    await agreeOn('a switch keeps a staged change, a staged new file and a local change it does not touch', repo, ['checkout', '-q', 'b']);
    await agreeOn('and so does the switch back', repo, ['checkout', '-q', 'main']);
    rewriteBoth(repo, 'f', 'f2\n');
    await agreeOn('a local change is one even when it matches the branch', repo, ['checkout', '-q', 'b']);
  }
  // merge checks the merged commit out as a switch does, and moves the branch only after.
  {
    const repo = dirBecomesFile();
    rewriteBoth(repo, 'd/u', 'untracked\n');
    rewriteBoth(repo, 'n', 'mine\n');
    rewriteBoth(repo, 'f', 'local\n');
    await agreeOn('a merge refused for a local change, an untracked directory and an untracked file', repo, ['merge', 'b']);
    removeBoth(repo, 'n');
    removeBoth(repo, 'd/u');
    rewriteBoth(repo, 'f', 'f\n');
    await agreeOn('the merge once nothing is in its way', repo, ['merge', '-q', 'b']);
  }
  // A merge that is not a fast-forward refuses the same way, with exit 2 and ort's last word.
  {
    const repo = scenario(({ put, git }) => {
      put('f', '1\n');
      put('h', 'h\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'c');
      git('checkout', '-q', '-b', 'b');
      put('f', '2\n');
      put('n', 'new\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'b');
      git('checkout', '-q', 'main');
      put('h', 'h2\n');
      git('commit', '-q', '-a', '-m', 'm');
    });
    rewriteBoth(repo, 'f', 'local\n');
    await agreeOn('a merge, not a fast-forward, refused for a local change', repo, ['merge', '-q', '--no-edit', 'b']);
    rewriteBoth(repo, 'f', '1\n');
    rewriteBoth(repo, 'n', 'mine\n');
    await agreeOn('a merge, not a fast-forward, refused for an untracked file', repo, ['merge', '-q', '--no-edit', 'b']);
  }
  // reset --hard is a forced checkout: untracked paths in the target's way go.
  for (const [label, target, untracked] of [
    ['reset --hard over an untracked file where the target has a directory', ['d/x'], 'd'],
    ['reset --hard over an untracked directory where the target has a file', ['d'], 'd/u'],
  ]) {
    const repo = scenario(({ put, git }) => {
      put('k', 'k\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'k');
      git('branch', 'old');
      for (const path of target) put(path, 'tracked\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'target');
      git('checkout', '-q', '-b', 'moved', 'old');
    });
    rewriteBoth(repo, untracked, 'untracked\n');
    await agreeOn(label, repo, ['reset', '-q', '--hard', 'main']);
  }

  // checkout with a bare `--` switches (or stays), keeping local and staged changes.
  for (const args of [['checkout', '--'], ['checkout', 'HEAD', '--'], ['checkout', '-q', 'main', '--'], ['checkout']]) {
    const repo = scenario(({ put, git }) => {
      put('f', 'base\n');
      put('s/g', 'g\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'c');
    });
    rewriteBoth(repo, 'f', 'local\n');
    rewriteBoth(repo, 's/g', 'staged\n');
    sh(repo.disk, ['add', 's/g']);
    assert.equal((await nimbusGit(repo.virtual, ['add', 's/g'])).code, 0);
    await agreeOn(`git ${args.join(' ')} with no paths`, repo, args);
  }
  // checkout <tree> -- <path> replaces the index entries a restored path conflicts with, and the
  // worktree's directory, file or link in its way; the next commit holds what git's holds.
  {
    const repo = scenario(({ put, link, rm, git }) => {
      put('d/x', 'x\n');
      put('t/f', 'f\n');
      link('l', 't');
      git('add', '-A');
      git('commit', '-q', '-m', 'dir');
      git('branch', 'withdir');
      rm('d');
      put('d', 'file\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'file');
      git('branch', 'withfile');
    });
    // The commits below differ from git's by id alone, so HEAD is compared by its tree.
    const agreeTree = (label, at, args) => agreeOn(label, at, args, { commits: true });
    await agreeTree('checkout <tree> -- a directory where the index has a file', repo, ['checkout', 'withdir', '--', 'd']);
    await agreeTree('and commit it', repo, ['commit', '-q', '-m', 'd, a directory']);
    const lsTree = (cwd) => realGit(cwd, ['ls-tree', '-r', 'HEAD']).stdout.toString();
    assert.equal(lsTree(copyOf(repo)), lsTree(repo.disk), 'the commit after checkout <tree> -- d');
    await agreeTree('checkout <tree> -- a file where the index has a directory', repo, ['checkout', 'withfile', '--', 'd']);
    await agreeTree('and commit that', repo, ['commit', '-q', '-m', 'd, a file']);
    assert.equal(lsTree(copyOf(repo)), lsTree(repo.disk), 'the commit after checkout <tree> -- d, back');
    removeBoth(repo, 'd');
    rewriteBoth(repo, 'd/u', 'untracked\n');
    await agreeTree('checkout -- a file where the worktree has a directory', repo, ['checkout', '--', 'd']);
    removeBoth(repo, 'l');
    rewriteBoth(repo, 'l/u', 'untracked\n');
    await agreeTree('checkout HEAD -- a link where the worktree has a directory', repo, ['checkout', 'HEAD', '--', 'l']);
    // A pathspec ending in '/' names a directory, never the link there.
    removeBoth(repo, 'l');
    await agreeTree('checkout -- a link named as a directory', repo, ['checkout', '--', 'l/']);
    await agreeTree('checkout -- a path below a tracked link', repo, ['checkout', '--', 'l/f']);
    rewriteBoth(repo, 't/f', 'changed\n');
    await agreeTree('checkout -- a directory named with its slash', repo, ['checkout', '--', 't/']);
  }

  // ── git add: what git 2.x stages for a pathspec, -n/--dry-run and -v printing it ──
  {
    const repo = scenario(({ put, git }) => {
      put('.gitignore', 'i*\nidir/\n');
      put('a', 'a\n');
      put('s/b', 'b\n');
      put('keep', 'k\n');
      git('add', 'a', 's', 'keep');
      git('commit', '-q', '-m', 'c');
      put('a', 'a2\n');
      put('ign', 'i\n');
      put('idir/f', 'f\n');
      put('sp ace', 's\n');
      put('tab\tt', 't\n');
      put('s/n', 'n\n');
    });
    removeBoth(repo, 's/b');
    const dry = (label, args, options = {}) => agreeOn(label, repo, args, { stdout: true, ...options });
    await dry('add -n of a file', ['add', '-n', 'a']);
    await dry('add --dry-run of the tree', ['add', '--dry-run', '.']);
    await dry('add -n from a subdirectory', ['add', '-n', '.'], { sub: 's' });
    await dry('add -n -A', ['add', '-n', '-A']);
    await dry('add -nA from a subdirectory: the whole tree', ['add', '-nA'], { sub: 's' });
    await dry('add -nu', ['add', '-nu']);
    await dry('add -n ../a n from a subdirectory', ['add', '-n', '../a', 'n'], { sub: 's' });
    await dry('add -n --no-all', ['add', '-n', '--no-all', '.']);
    await dry('add -n of odd names', ['add', '-n', 'sp ace', 'tab\tt']);
    await dry('add -n of a pathspec that matches nothing', ['add', '-n', 'nope', 'a']);
    await dry('add -n of an ignored file', ['add', '-n', 'ign', 'a']);
    await dry('add -n of a file in an ignored directory', ['add', '-n', 'idir/f']);
    await dry('add -n -f of an ignored directory', ['add', '-n', '-f', 'idir']);
    await dry('add with nothing specified', ['add']);
    await dry('add -v', ['add', '-v', 's']);
    await dry('add -n once staged', ['add', '-n', 's']);
    await dry('add of an ignored file, the rest staged', ['add', 'ign', 'a']);
    await dry('add -f of an ignored file', ['add', '-f', 'ign']);
    await dry('add -A', ['add', '-A']);
    // -u updates only what the index holds: a path removed from it with rm --cached stays removed.
    // Nimbus has no git rm, so real git removes it and the index is mirrored in.
    sh(repo.disk, ['rm', '-q', '--cached', 'keep']);
    user.writeFile(`${repo.virtual.slice(1)}/.git/index`, readFileSync(join(repo.disk, '.git/index')));
    await dry('add -u after rm --cached', ['add', '-u']);
    await dry('add -u of a path the index no longer holds', ['add', '-u', 'keep']);
    await dry('add of an unknown switch', ['add', '-Q', 'a'], { firstLine: true });
    await dry('add of an unknown option', ['add', '--bogus', 'a'], { firstLine: true });
  }

  // ── git tag: lightweight and annotated tags, listing, -f and -d, as git makes them ──
  {
    const repo = scenario(({ put, git }) => {
      put('a', 'a\n');
      git('add', 'a');
      git('commit', '-q', '-m', 'first\n\nits body');
      git('branch', 'older');
      put('a', 'a2\n');
      git('commit', '-q', '-a', '-m', 'second');
    });
    // Both gits stamp tags with the committer git's environment names (GIT_ENV's
    // committer, and its date), so tag objects are byte-identical, ids included.
    const committer = { GIT_COMMITTER_NAME: GIT_ENV.GIT_COMMITTER_NAME, GIT_COMMITTER_EMAIL: GIT_ENV.GIT_COMMITTER_EMAIL, GIT_COMMITTER_DATE: GIT_ENV.GIT_COMMITTER_DATE };
    const tag = (label, args, options = {}) => agreeOn(label, repo, args, { stdout: true, env: committer, ...options });
    const tags = (cwd) => realGit(cwd, ['for-each-ref',
      '--format=%(refname) %(objecttype) %(objectname) %(type) %(tag) %(*objectname) %(taggername) %(taggeremail) %(taggerdate:raw) [%(contents)]',
      'refs/tags']).stdout.toString();
    const sameTags = (label) => assert.equal(tags(copyOf(repo)), tags(repo.disk), `${label}: refs/tags`);
    for (const [label, args] of [
      ['a lightweight tag', ['tag', 'light']],
      ['a lightweight tag of a named commit', ['tag', 'old', 'older']],
      ['an annotated tag, -a -m', ['tag', '-a', 'v1', '-m', 'msg']],
      ['-m alone makes it annotated', ['tag', '-m', 'only m', 'v2']],
      ['two -m paragraphs, whitespace cleaned', ['tag', '-m', 'a  ', '-m', '\n\nb\n\n', 'v3']],
      ['-m bundled, of an older commit', ['tag', '-mbundled', 'v4', 'older']],
    ]) {
      await tag(label, args);
      sameTags(label);
    }
    await tag('a tag that exists', ['tag', 'v1']);
    await tag('-a with no message', ['tag', '-a', 'v5']);
    await tag('-f replaces it', ['tag', '-f', '-a', '-m', 're', 'v2']);
    sameTags('-f');
    await tag('-f to the same commit, lightweight', ['tag', '-f', 'light']);
    await tag('list', ['tag']);
    await tag('-l with a pattern', ['tag', '-l', 'v*']);
    await tag('--list with two patterns', ['tag', '--list', 'l*', 'o?d']);
    await tag('-n', ['tag', '-n']);
    await tag('-n2', ['tag', '-n2']);
    await tag('-d', ['tag', '-d', 'v1', 'light']);
    sameTags('-d');
    await tag('-d of a tag that does not exist', ['tag', '-d', 'nope']);
    await tag('a commit that does not exist', ['tag', 'x', 'nosuchref']);
    await tag('an unknown switch', ['tag', '-Q'], { firstLine: true });
    // git's strip cleanup: comment lines go; an empty message is an empty body; -n lists it empty.
    for (const [label, args] of [
      ['a message with a comment line', ['tag', '-m', '# a comment\nreal line', 'c1']],
      ['a message that is only a comment', ['tag', '-m', '#only a comment', 'c2']],
      ['an empty message', ['tag', '-m', '', 'c3']],
    ]) {
      await tag(label, args);
      sameTags(label);
    }
    await tag('-n9 over empty and cleaned messages', ['tag', '-n9']);
    // The tagger is the committer, never the author; a date git cannot read is its error.
    const people = { ...committer, GIT_AUTHOR_NAME: 'Author', GIT_AUTHOR_EMAIL: 'author@x', GIT_COMMITTER_NAME: 'Committer', GIT_COMMITTER_EMAIL: 'committer@x' };
    await tag('the tagger is the committer', ['tag', '-m', 'm', 'who'], { env: people });
    sameTags('the tagger is the committer');
    await tag('a zoned ISO committer date', ['tag', '-m', 'm', 'iso'], { env: { ...committer, GIT_COMMITTER_DATE: '2020-01-01 10:00:00 +0530' } });
    sameTags('a zoned ISO committer date');
    await tag('a committer date git cannot read', ['tag', '-m', 'm', 'bad'], { env: { ...committer, GIT_COMMITTER_DATE: 'garbage' } });
    // Every absolute form date.c's parse_date_basic reads, read as it reads it; and what it refuses.
    for (const [i, date] of [
      'Thu, 02 Jan 2020 03:04:05 -0800', 'Thu Jan 2 03:04:05 2020 -0800', '02 Jan 2020 03:04:05 +0000',
      '2020.01.02 03:04:05 +0000', '01/02/2020 03:04:05 +0000', '2020-01-02 03:04:05', '2020-01-02T03:04:05Z',
      '20200102T030405 +0100', 'Jan 2 2020 3:04:05 pm PST', '1700000000', '@1700000000 -0330', '2 January 2020 03:04 CEST',
      '2020-01-02', '1960-01-02 03:04:05 +0000', 'Thu Jan 2 2020',
    ].entries()) {
      const env = { ...committer, GIT_COMMITTER_DATE: date };
      await tag(`committer date ${JSON.stringify(date)}`, ['tag', '-m', 'm', `date${i}`], { env });
      sameTags(`committer date ${JSON.stringify(date)}`);
    }
  }

  // ── Commits stamp the author and committer git's environment and config name ──
  // Both gits commit the same tree with the same identities and dates, so the commit
  // objects (and their ids) are byte-identical; a date git cannot read is its error.
  {
    const repo = scenario(({ put, git }) => {
      put('f', '1\n');
      git('add', 'f');
      git('commit', '-q', '-m', 'base');
    });
    const catHead = (cwd) => realGit(cwd, ['cat-file', 'commit', 'HEAD']).stdout.toString();
    const identity = Object.fromEntries(Object.entries(GIT_ENV).filter(([k]) => /^GIT_(AUTHOR|COMMITTER)_/.test(k)));
    const commitBoth = async (label, content, overrides, extra = {}) => {
      const env = { ...identity, ...overrides };
      rewriteBoth(repo, 'f', content);
      sh(repo.disk, ['add', 'f']);
      { const r = await nimbusGit(repo.virtual, ['add', 'f'], env); assert.equal(r.code, 0, r.stderr); }
      const expected = realGit(repo.disk, ['commit', '-q', '-m', 'msg'], env);
      const actual = await nimbusGit(repo.virtual, ['commit', '-q', '-m', 'msg'], env);
      assert.equal(actual.code, expected.code, `${label}: exit (${actual.stderr})`);
      assert.equal(catHead(copyOf(repo)), catHead(repo.disk), `${label}: the commit object`);
      checks++;
    };
    const people = {
      GIT_AUTHOR_NAME: 'Au Thor', GIT_AUTHOR_EMAIL: 'au@x', GIT_AUTHOR_DATE: 'Thu, 02 Jan 2020 03:04:05 -0800',
      GIT_COMMITTER_NAME: 'Co Mitter', GIT_COMMITTER_EMAIL: 'co@x', GIT_COMMITTER_DATE: '2021-03-04T05:06:07+05:30',
    };
    await commitBoth('a commit with GIT_ENV\'s identities and dates', '2\n', {});
    await commitBoth('author and committer apart, in two date forms', '3\n', people);
    await commitBoth('git\'s own date format, and @epoch', '4\n',
      { ...people, GIT_AUTHOR_DATE: 'Thu Jan 2 03:04:05 2020 -0800', GIT_COMMITTER_DATE: '@1700000000 +0100' });
    // No name in the environment: user.name and user.email from the config, for both.
    for (const cwd of [repo.disk]) sh(cwd, ['config', 'user.name', 'Conf Igured'], ['config', 'user.email', 'conf@x']);
    { const r = await nimbusGit(repo.virtual, ['config', 'user.name', 'Conf Igured']); assert.equal(r.code, 0, r.stderr); }
    { const r = await nimbusGit(repo.virtual, ['config', 'user.email', 'conf@x']); assert.equal(r.code, 0, r.stderr); }
    const noNames = { GIT_AUTHOR_NAME: '', GIT_AUTHOR_EMAIL: '', GIT_COMMITTER_NAME: '', GIT_COMMITTER_EMAIL: '' };
    const unset = (env) => Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
    {
      rewriteBoth(repo, 'f', '5\n');
      sh(repo.disk, ['add', 'f']);
      assert.equal((await nimbusGit(repo.virtual, ['add', 'f'])).code, 0);
      // Real git gets the names removed from its environment; Nimbus gets none.
      const r = spawnSync('git', ['commit', '-q', '-m', 'msg'], { cwd: repo.disk, env: unset({ ...GIT_ENV, ...noNames }) });
      assert.equal(r.status, 0, r.stderr.toString());
      const n = await nimbusGit(repo.virtual, ['commit', '-q', '-m', 'msg'], { GIT_AUTHOR_DATE: GIT_ENV.GIT_AUTHOR_DATE, GIT_COMMITTER_DATE: GIT_ENV.GIT_COMMITTER_DATE });
      assert.equal(n.code, 0, n.stderr);
      assert.equal(catHead(copyOf(repo)), catHead(repo.disk), 'identities from the config: the commit object');
    }
    // The message as git's cleanup modes leave it (-m has no editor, so `default` and
    // `scissors` are `whitespace`; `strip` drops comment lines; `verbatim` keeps every byte).
    const messy = '\n\n  x  \n# c\n\n\n\ny\t\n\n';
    let n = 10;
    const commitMessage = async (label, args, env = {}) => {
      rewriteBoth(repo, 'f', `${n++}\n`);
      sh(repo.disk, ['add', 'f']);
      assert.equal((await nimbusGit(repo.virtual, ['add', 'f'])).code, 0);
      const both = { ...identity, ...env };
      const expected = realGit(repo.disk, ['commit', '-q', ...args], both);
      const actual = await nimbusGit(repo.virtual, ['commit', '-q', ...args], both);
      assert.equal(actual.code, expected.code, `${label}: exit (git: ${expected.stderr}; nimbus: ${actual.stderr})`);
      assert.equal(actual.stderr, expected.stderr, `${label}: stderr`);
      assert.equal(catHead(copyOf(repo)), catHead(repo.disk), `${label}: the commit object`);
      checks++;
    };
    for (const mode of [null, 'default', 'strip', 'whitespace', 'verbatim', 'scissors']) {
      await commitMessage(`-m, cleanup ${mode ?? 'unset'}`, [...(mode ? [`--cleanup=${mode}`] : []), '-m', messy]);
    }
    await commitMessage('two -m paragraphs', ['-m', 'a', '-m', 'b']);
    await commitMessage('an empty -m before another', ['-m', '', '-m', 'b']);
    await commitMessage('two -m, verbatim', ['--cleanup', 'verbatim', '-m', ' a ', '-m', ' b ']);
    await commitMessage('a carriage return kept by whitespace', ['-m', 'a\rb']);
    await commitMessage('a message that cleans to nothing', ['-m', '   ']);
    await commitMessage('an empty message, allowed', ['--allow-empty-message', '-m', '   ']);
    await commitMessage('an empty verbatim message', ['--cleanup=verbatim', '-m', '']);
    await commitMessage('only a comment, stripped', ['--cleanup=strip', '-m', '#only']);
    await commitMessage('a cleanup mode git does not know', ['--cleanup=bogus', '-m', 'x']);
    // A byte-exact message is one object: no stray commit or tree is left behind.
    {
      const fsck = realGit(copyOf(repo), ['fsck', '--no-progress', '--dangling', '--unreachable']);
      assert.equal(fsck.code, 0, fsck.stderr);
      // Blobs staged for the refused commits above are unreachable in both gits; a commit or tree is not.
      assert.deepEqual(fsck.stdout.toString().split('\n').filter((l) => / (commit|tree) /.test(l)), [], 'no stray commit or tree');
    }
    sh(repo.disk, ['config', 'commit.cleanup', 'strip']);
    { const r = await nimbusGit(repo.virtual, ['config', 'commit.cleanup', 'strip']); assert.equal(r.code, 0, r.stderr); }
    await commitMessage('commit.cleanup from the config', ['-m', '# c\nz']);
    await commitMessage('--cleanup over the config', ['--cleanup=whitespace', '-m', '# c\nz']);
    sh(repo.disk, ['config', '--unset', 'commit.cleanup']);
    { const r = await nimbusGit(repo.virtual, ['config', '--unset', 'commit.cleanup']); assert.equal(r.code, 0, r.stderr); }
    rewriteBoth(repo, 'f', '6\n');
    sh(repo.disk, ['add', 'f']);
    assert.equal((await nimbusGit(repo.virtual, ['add', 'f'])).code, 0);
    await agreeOn('an author date git cannot read', repo, ['commit', '-q', '-m', 'msg'], { env: { ...identity, GIT_AUTHOR_DATE: 'garbage' } });
  }
  // On a detached HEAD, git moves HEAD itself: commit (plain and verbatim), merge and tag.
  // Nimbus used to leave HEAD where it was and write a ref file named after the old commit.
  {
    const repo = scenario(({ put, git }) => {
      put('f', '1\n');
      git('add', 'f');
      git('commit', '-q', '-m', 'c');
      git('checkout', '-q', '-b', 'side');
      put('h', 'h\n');
      git('add', 'h');
      git('commit', '-q', '-m', 'h');
      git('checkout', '-q', '--detach', 'main');
    });
    const identity = Object.fromEntries(Object.entries(GIT_ENV).filter(([k]) => /^GIT_(AUTHOR|COMMITTER)_/.test(k)));
    const detached = async (label, args, content) => {
      if (content !== undefined) {
        rewriteBoth(repo, 'f', content);
        sh(repo.disk, ['add', 'f']);
        const added = await nimbusGit(repo.virtual, ['add', 'f']);
        assert.equal(added.code, 0, added.stderr);
      }
      const expected = realGit(repo.disk, args, identity);
      const actual = await nimbusGit(repo.virtual, args, identity);
      assert.equal(actual.code, expected.code, `${label}: exit (git: ${expected.stderr}; nimbus: ${actual.stderr})`);
      const copy = copyOf(repo);
      for (const probe of [['rev-parse', 'HEAD'], ['symbolic-ref', '-q', 'HEAD'], ['cat-file', '-p', 'HEAD'], ['show-ref']]) {
        assert.equal(realGit(copy, probe).stdout.toString(), realGit(repo.disk, probe).stdout.toString(), `${label}: git ${probe.join(' ')}`);
      }
      const stray = readdirSync(join(copy, '.git')).filter((n) => /^[0-9a-f]{40}$/.test(n));
      assert.deepEqual(stray, [], `${label}: no .git file named after a commit`);
      checks++;
    };
    await detached('commit on a detached HEAD', ['commit', '-q', '-m', 'on detached'], '2\n');
    await detached('a verbatim commit on a detached HEAD', ['commit', '-q', '--cleanup=verbatim', '-m', ' verbatim '], '3\n');
    await detached('a tag on a detached HEAD', ['tag', '-m', 'm', 'det-tag']);
    await detached('a merge into a detached HEAD', ['merge', '-q', '--no-edit', 'side']);
  }
  // A merge that makes a commit stamps both lines the same way.
  {
    const repo = scenario(({ put, git }) => {
      put('f', '1\n');
      put('g', 'g\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'c');
      git('checkout', '-q', '-b', 'b');
      put('f', '2\n');
      git('commit', '-q', '-a', '-m', 'b');
      git('checkout', '-q', 'main');
      put('g', 'g2\n');
      git('commit', '-q', '-a', '-m', 'm');
    });
    const people = { GIT_AUTHOR_NAME: 'Au', GIT_AUTHOR_EMAIL: 'au@x', GIT_AUTHOR_DATE: '1600000000 +0200',
      GIT_COMMITTER_NAME: 'Co', GIT_COMMITTER_EMAIL: 'co@x', GIT_COMMITTER_DATE: '1600000100 -0400' };
    const expected = realGit(repo.disk, ['merge', '-q', '--no-edit', 'b'], people);
    const actual = await nimbusGit(repo.virtual, ['merge', '-q', '--no-edit', 'b'], people);
    assert.equal(actual.code, expected.code, `a merge commit: exit (${actual.stderr})`);
    const signatures = (cwd) => realGit(cwd, ['cat-file', 'commit', 'HEAD']).stdout.toString().split('\n').filter((l) => /^(author|committer) /.test(l)).join('\n');
    assert.equal(signatures(copyOf(repo)), signatures(repo.disk), 'a merge commit: its author and committer');
    checks++;
  }

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
