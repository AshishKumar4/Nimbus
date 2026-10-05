#!/usr/bin/env bun
// git status (short and porcelain v1), diff, add and commit over the Nimbus
// VFS print and write what the real git on this machine does for the same
// repository. Each repository is built on disk with real git, mirrored into
// a SqliteVFS (its .git included), and both gits run the same command in the
// same state: renames, deletions, mode changes, links, type changes, every
// kind of exclude rule (negations, anchors, `**`, directory-only patterns,
// nested .gitignore files, info/exclude, core.excludesFile's default),
// untracked directories, a nested repository, an index at version 4, a
// sparse (skip-worktree) entry whose .gitignore is read from the index,
// assume-unchanged, and unmerged entries. After `git add`, the index holds the
// same entries byte for byte, stat data aside (no two filesystems agree on
// inode numbers); after `git commit`, the same tree.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { runGitCommand } from '../../packages/worker/src/git/commands.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'nimbus-git-status-'));
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));
// Real git's home holds the same global excludes file as the VFS home: core.excludesFile's default.
const realHome = join(scratch, 'real-home');
mkdirSync(join(realHome, '.config/git'), { recursive: true });
writeFileSync(join(realHome, '.config/git/ignore'), '*.glob\n');

const GIT_ENV = {
  PATH: process.env.PATH,
  HOME: realHome,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'maintenance.auto', GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'gc.auto', GIT_CONFIG_VALUE_1: '0',
  GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com', GIT_COMMITTER_DATE: '1700000000 +0000',
  LC_ALL: 'C',
  GIT_CEILING_DIRECTORIES: tmpdir(),
};

const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
const kernel = vfs.as(CRED_KERNEL);
const user = vfs.as(CRED_SESSION_USER);
kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
kernel.chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
user.mkdir('home/user/.config/git', { recursive: true });
user.writeFile('home/user/.config/git/ignore', '*.glob\n');
const files = new ProcessFiles(vfs);

function realGit(cwd, args) {
  const r = spawnSync('git', args, { cwd, env: GIT_ENV });
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

async function nimbusGit(cwd, args) {
  const chunks = [];
  let stderr = '';
  const code = await runGitCommand({
    pid: 1,
    cred: CRED_SESSION_USER,
    args,
    cwd,
    // The identities real git stamps, so a commit's id is compared whole.
    env: {
      HOME: '/home/user', GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_AUTHOR_DATE: '1700000000 +0000',
      GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com', GIT_COMMITTER_DATE: '1700000000 +0000',
    },
    stdout: {
      write(s) { chunks.push(Buffer.from(s, 'utf8')); },
      writeBytes(bytes) { chunks.push(Buffer.from(bytes)); },
    },
    stderr: { write(s) { stderr += s; } },
    vfs: files.view({ pid: 1, cred: CRED_SESSION_USER }),
  }, vfs);
  return { code, stdout: Buffer.concat(chunks), stderr };
}

let checks = 0;
/** Run `args` in both repositories (from `sub` below each); exit code and stdout must match byte for byte. */
async function same(label, repo, args, { sub = '' } = {}) {
  const expected = realGit(sub ? join(repo.disk, sub) : repo.disk, args);
  const actual = await nimbusGit(sub ? `${repo.virtual}/${sub}` : repo.virtual, args);
  assert.equal(actual.code, expected.code, `${label}: exit code (git: ${expected.stderr}; nimbus: ${actual.stderr})`);
  assert.equal(actual.stdout.toString('latin1'), expected.stdout.toString('latin1'), `${label}: stdout`);
  checks++;
}

/** Run `args` in both; exit code, stdout and stderr must match. */
async function sameWithStderr(label, repo, args) {
  const expected = realGit(repo.disk, args);
  const actual = await nimbusGit(repo.virtual, args);
  assert.equal(actual.code, expected.code, `${label}: exit code (git: ${expected.stderr}; nimbus: ${actual.stderr})`);
  assert.equal(actual.stdout.toString('latin1'), expected.stdout.toString('latin1'), `${label}: stdout`);
  assert.equal(actual.stderr, expected.stderr.split(diskRoot).join(vfsRoot), `${label}: stderr`);
  checks++;
}

/** Both gits run `args`, which must succeed. */
async function both(repo, args) {
  const expected = realGit(repo.disk, args);
  assert.equal(expected.code, 0, `git ${args.join(' ')}: ${expected.stderr}`);
  const actual = await nimbusGit(repo.virtual, args);
  assert.equal(actual.code, 0, `nimbus git ${args.join(' ')}: ${actual.stderr}`);
}

/**
 * An index's header and entries with the stat data zeroed (ctime, mtime, dev,
 * ino, uid, gid: every field but mode and size, and a gitlink's size), and its
 * extensions' names.
 */
function indexShape(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4);
  const count = view.getUint32(8);
  const out = Buffer.from(bytes);
  const listed = [];
  let at = 12;
  let name = Buffer.alloc(0);
  for (let i = 0; i < count; i++) {
    out.fill(0, at, at + 24);
    out.fill(0, at + 28, at + 36);
    // A gitlink records its directory's stat, whose size is the filesystem's own; git never reads it.
    const gitlink = view.getUint32(at + 24) === 0o160000;
    if (gitlink) out.fill(0, at + 36, at + 40);
    const flags = view.getUint16(at + 60);
    let nameAt = at + 62 + (flags & 0x4000 ? 2 : 0);
    let strip = 0;
    if (version === 4) {
      // The name is what it strips from the last one's end (a varint), then what it adds.
      for (let shift = 0; ; shift += 7) {
        const c = bytes[nameAt++];
        strip = shift ? (strip + 1) * 128 + (c & 127) : c & 127;
        if (!(c & 128)) break;
      }
    }
    const nul = bytes.indexOf(0, nameAt);
    name = Buffer.concat([version === 4 ? name.subarray(0, name.length - strip) : Buffer.alloc(0), Buffer.from(bytes.subarray(nameAt, nul))]);
    listed.push(`${view.getUint32(at + 24).toString(8)} ${Buffer.from(bytes.subarray(at + 40, at + 60)).toString('hex')} `
      + `${flags.toString(16)} size=${gitlink ? '-' : view.getUint32(at + 36)} ${name.toString()}`);
    at = version === 4 ? nul + 1 : at + ((nul - at + 8) & ~7);
  }
  const previous = at;
  const extensions = [];
  let tree = null;
  for (let ext = previous; ext + 8 <= bytes.length - 20;) {
    const signature = Buffer.from(bytes.subarray(ext, ext + 4)).toString('latin1');
    extensions.push(signature);
    if (signature === 'TREE') tree = Buffer.from(bytes.subarray(ext + 8, ext + 8 + view.getUint32(ext + 4))).toString('latin1');
    ext += 8 + view.getUint32(ext + 4);
  }
  return { listed, entries: out.subarray(0, previous).toString('hex'), extensions, tree };
}

/** After `args` in both, the same index entries (stat aside); Nimbus keeps no extension git would not. */
async function sameIndexAfter(label, repo, args) {
  await both(repo, args);
  const real = indexShape(readFileSync(join(repo.disk, '.git/index')));
  const ours = indexShape(user.readFile(`${repo.virtual.slice(1)}/.git/index`));
  assert.deepEqual(ours.listed, real.listed, `${label}: index entries`);
  assert.equal(ours.entries, real.entries, `${label}: index entry bytes`);
  for (const ext of ours.extensions) assert.ok(real.extensions.includes(ext), `${label}: extension ${ext} git does not write`);
  // The cache tree, where both keep one, records the same trees (what git invalidated is invalid here too).
  if (ours.tree !== null && real.tree !== null) assert.equal(ours.tree, real.tree, `${label}: cache tree`);
  checks++;
}

const diskRoot = join(scratch, 'home');
const vfsRoot = '/home/user/w';
mkdirSync(diskRoot);
let repos = 0;
/** A repository `build` makes with real git, then mirrored into the VFS. */
function scenario(build) {
  const repo = { disk: join(diskRoot, `r${repos}`), virtual: `${vfsRoot}/r${repos++}` };
  mkdirSync(repo.disk);
  sh(repo.disk, ['init', '-q', '-b', 'main']);
  const put = (path, content, mode) => {
    mkdirSync(join(repo.disk, path, '..'), { recursive: true });
    writeFileSync(join(repo.disk, path), content);
    if (mode) chmodSync(join(repo.disk, path), mode);
  };
  build({
    put,
    link: (path, target) => {
      rmSync(join(repo.disk, path), { recursive: true, force: true });
      mkdirSync(join(repo.disk, path, '..'), { recursive: true });
      symlinkSync(target, join(repo.disk, path));
    },
    rm: (path) => rmSync(join(repo.disk, path), { recursive: true, force: true }),
    mkdir: (path) => mkdirSync(join(repo.disk, path), { recursive: true }),
    chmod: (path, mode) => chmodSync(join(repo.disk, path), mode),
    git: (...args) => sh(repo.disk, args),
    at: repo.disk,
  });
  mirror(repo.disk, repo.virtual);
  return repo;
}

const STATUS_FORMS = [
  ['status', '--porcelain'],
  ['status', '-s'],
  ['status', '--short', '-z'],
  ['status', '-z'],
  ['status', '--porcelain=v1', '--untracked-files=all'],
  ['status', '-s', '-uall'],
  ['status', '-s', '-uno'],
  ['status', '--porcelain', '--no-renames'],
];

/** Every status form, then the same from `subs`, and with pathspecs. */
async function statusAgrees(label, repo, { subs = [], specs = [] } = {}) {
  for (const args of STATUS_FORMS) await same(`${label}: ${args.join(' ')}`, repo, args);
  for (const sub of subs) {
    for (const args of [['status', '-s'], ['status', '--porcelain'], ['status', '-s', '-uall']]) {
      await same(`${label}: ${args.join(' ')} from ${sub}`, repo, args, { sub });
    }
  }
  for (const spec of specs) {
    await same(`${label}: status -s -- ${spec}`, repo, ['status', '-s', '--', spec]);
    await same(`${label}: status --porcelain -uall ${spec}`, repo, ['status', '--porcelain', '-uall', spec]);
  }
}

const lines = (n, tag = 'line') => Array.from({ length: n }, (_, i) => `${tag} ${i}\n`).join('');

try {
  // ── Every kind of change, every kind of exclude rule ──
  const everything = scenario(({ put, link, rm, mkdir, chmod, git, at }) => {
    put('.gitignore', [
      '# a comment', '*.log', '!keep.log', '/build/', 'tmp/', '**/gen/*.c', 'doc/**/*.pdf', '\\#hash', 'trailing\\ ',
      'anchored/inner', '*.o', 'lone[0-9].txt', '!lone5.txt', 'idir/', 'tracked-ignored/', '',
    ].join('\n'));
    put('a.txt', 'a\n');
    put('same-size.txt', 'aaaa\n');
    put('sub/c.txt', 'c\n');
    put('sub/deep/d.txt', 'd\n');
    put('sub/.gitignore', 'local.txt\n!important.log\n/rooted\n');
    put('mode.sh', 'echo m\n', 0o644);
    put('rename-src.txt', lines(40, 'moved'));
    put('similar-src.txt', lines(30, 'similar'));
    put('staged.txt', 's\n');
    put('keep/x', 'x\n');
    put('sp ace.txt', 's\n');
    put('é.txt', 'accent\n');
    put('tab\tname', 't\n');
    put('quote"mark', 'q\n');
    put('dir-to-file/f', 'f\n');
    put('file-to-dir', 'file\n');
    put('becomes-link', 'b\n');
    put('tracked-ignored/t.txt', 't\n');
    put('gone-dir/one', '1\n');
    put('gone-dir/sub/two', '2\n');
    link('link', 'a.txt');
    link('dirlink', 'sub');
    git('add', '-A');
    git('add', '-f', 'tracked-ignored/t.txt');
    git('commit', '-q', '-m', 'seed');

    put('a.txt', 'a changed, and longer\n');
    put('same-size.txt', 'bbbb\n');
    rm('sub/c.txt');
    chmod('mode.sh', 0o755);
    link('link', 'same-size.txt');
    git('mv', 'rename-src.txt', 'renamed.txt');
    git('mv', 'similar-src.txt', 'sub/similar.txt');
    put('sub/similar.txt', lines(29, 'similar') + 'changed\n');
    git('add', 'sub/similar.txt');
    put('new-staged.txt', 'n\n');
    git('add', 'new-staged.txt');
    put('staged.txt', 's2\n');
    git('add', 'staged.txt');
    put('staged.txt', 's3, unstaged on top\n');
    git('rm', '-q', '--cached', 'keep/x');
    link('becomes-link', 'a.txt');
    rm('dir-to-file');
    put('dir-to-file', 'now a file\n');
    rm('file-to-dir');
    put('file-to-dir/inner', 'inner\n');
    rm('gone-dir');
    // Untracked: files, directories (collapsed or listed), and what the rules hide.
    put('untracked.txt', 'u\n');
    put('sub/new.txt', 'n\n');
    put('newdir/a', 'a\n');
    put('newdir/deeper/b', 'b\n');
    mkdir('empty-untracked');
    put('only-ignored/x.log', 'l\n');
    put('only-ignored/deep/y.o', 'o\n');
    put('debug.log', 'l\n');
    put('keep.log', 'k\n');
    put('build/out', 'o\n');
    put('sub/build/out', 'not the rooted build\n');
    put('tmp/t', 't\n');
    put('sub/tmp/t', 't\n');
    put('src/gen/x.c', 'c\n');
    put('src/a/gen/y.c', 'c\n');
    put('src/gen/x.h', 'h\n');
    put('doc/a/b/c.pdf', 'p\n');
    put('doc/c.pdf', 'p\n');
    put('#hash', 'h\n');
    put('trailing ', 't\n');
    put('anchored/inner', 'i\n');
    put('sub/anchored/inner', 'i\n');
    put('lone3.txt', 'l\n');
    put('lone5.txt', 'l\n');
    put('sub/local.txt', 'l\n');
    put('sub/important.log', 'i\n');
    put('sub/rooted', 'r\n');
    put('rooted', 'r\n');
    put('idir/f', 'f\n');
    put('tracked-ignored/new.txt', 'hidden: its directory is ignored\n');
    put('x.excl', 'info/exclude\n');
    put('x.glob', 'core.excludesFile\n');
    put('sp ace dir/f', 'f\n');
    link('newlink', 'a.txt');
    link('newdirlink', 'sub');
    mkdirSync(join(at, 'nested'));
    sh(join(at, 'nested'), ['init', '-q']);
    put('nested/z', 'z\n');
    sh(join(at, 'nested'), ['add', 'z'], ['commit', '-q', '-m', 'nested']);
    mkdirSync(join(at, 'sub/unborn-nested'));
    sh(join(at, 'sub/unborn-nested'), ['init', '-q']);
    put('sub/unborn-nested/z', 'z\n');
    put('.git/info/exclude', '*.excl\n');
  });
  await statusAgrees('everything', everything, { subs: ['sub', 'sub/deep', 'newdir'], specs: ['sub', 'a.txt', 'newdir', 'nested'] });
  for (const args of [
    ['diff'], ['diff', '--cached'], ['diff', 'HEAD'], ['diff', '--name-status', 'HEAD'], ['diff', '--stat'],
    ['diff', '--cached', '--name-status'], ['ls-files', '-o', '--exclude-standard'], ['ls-files', '-o'], ['ls-files', '-m', '-d'],
  ]) await same(`everything: ${args.join(' ')}`, everything, args);

  // Staging: one path, a directory, then everything; the index entries are git's.
  await sameWithStderr('add -n of a nested repository with no commit', everything, ['add', '-n', 'sub']);
  await sameWithStderr('add of a nested repository with no commit', everything, ['add', 'sub']);
  await sameWithStderr('add -n of a nested repository with a commit', everything, ['add', '-n', 'newdir', 'nested']);
  rmSync(join(everything.disk, 'sub/unborn-nested'), { recursive: true });
  user.removeRecursive(`${everything.virtual.slice(1)}/sub/unborn-nested`);
  await sameIndexAfter('add one file', everything, ['add', 'a.txt']);
  await sameIndexAfter('add a directory', everything, ['add', 'sub']);
  await sameIndexAfter('add -u', everything, ['add', '-u']);
  await sameIndexAfter('add -A', everything, ['add', '-A']);
  await statusAgrees('everything, staged', everything, { subs: ['sub'] });
  await sameIndexAfter('commit', everything, ['commit', '-q', '-m', 'all of it']);
  // The same tree, parent and identities: the same commit.
  await same('everything: the commit', everything, ['rev-parse', 'HEAD']);
  await statusAgrees('everything, committed', everything);

  // ── commit -a, then the tree real git reads back is the one it would have made ──
  {
    const repo = scenario(({ put, link, git }) => {
      put('a', 'a\n');
      put('d/b', 'b\n');
      put('d/e/f', 'f\n');
      put('x.sh', 'x\n', 0o755);
      link('l', 'a');
      git('add', '-A');
      git('commit', '-q', '-m', 'c');
    });
    for (const [path, content] of [['a', 'a2\n'], ['d/e/f', 'f2\n']]) {
      writeFileSync(join(repo.disk, path), content);
      user.writeFile(`${repo.virtual.slice(1)}/${path}`, content);
    }
    rmSync(join(repo.disk, 'd/b'));
    user.unlink(`${repo.virtual.slice(1)}/d/b`);
    await both(repo, ['commit', '-q', '-a', '-m', 'edit']);
    await same('commit -a: the commit', repo, ['rev-parse', 'HEAD']);
    const copy = join(scratch, 'commit-a-copy');
    const out = (from, to) => {
      mkdirSync(to, { recursive: true });
      for (const { name, type } of user.readdir(from)) {
        if (type === 'directory') out(`${from}/${name}`, join(to, name));
        else if (type === 'symlink') symlinkSync(user.readlink(`${from}/${name}`), join(to, name));
        else writeFileSync(join(to, name), user.readFile(`${from}/${name}`));
      }
    };
    out(repo.virtual.slice(1), copy);
    assert.equal(realGit(copy, ['fsck', '--strict', '--no-progress']).code, 0, 'commit -a: fsck');
    await statusAgrees('after commit -a', repo);
  }

  // ── Renames git status finds among staged adds and deletes ──
  {
    const repo = scenario(({ put, mkdir, git }) => {
      for (const name of ['a', 'b', 'c']) put(`src/${name}.txt`, lines(20, name));
      put('dup1', 'same\n');
      put('dup2', 'same\n');
      put('sp src.txt', lines(10, 'space'));
      git('add', '-A');
      git('commit', '-q', '-m', 'c');
      mkdir('dst');
      git('mv', 'src/a.txt', 'dst/a.txt');
      git('mv', 'src/b.txt', 'b-moved.txt');
      git('mv', 'sp src.txt', 'sp dst.txt');
      put('b-moved.txt', lines(19, 'b') + 'changed\n');
      git('add', 'b-moved.txt');
      git('rm', '-q', 'dup1', 'dup2');
      put('dup3', 'same\n');
      git('add', 'dup3');
      put('dst/a.txt', lines(20, 'a') + 'unstaged\n');
    });
    await statusAgrees('renames', repo, { subs: ['dst'] });
  }

  // ── An unborn branch, and an index at version 4 ──
  {
    const repo = scenario(({ put, git }) => {
      put('f', 'f\n');
      put('d/g', 'g\n');
      git('add', '-A');
      put('f', 'changed\n');
      put('u', 'u\n');
    });
    await statusAgrees('unborn', repo);
    const v4 = scenario(({ put, git }) => {
      for (let i = 0; i < 20; i++) put(`dir/sub${i % 3}/file-with-a-long-shared-name-${i}.txt`, `${i}\n`);
      git('add', '-A');
      git('commit', '-q', '-m', 'c');
      git('update-index', '--index-version', '4');
      put('dir/sub1/file-with-a-long-shared-name-1.txt', 'changed\n');
      put('dir/sub2/new.txt', 'n\n');
    });
    await statusAgrees('index v4', v4);
    await sameIndexAfter('add -A at index v4', v4, ['add', '-A']);
    await statusAgrees('index v4, staged', v4);
  }

  // ── Sparse and assume-unchanged entries are never looked at; a sparse .gitignore comes from the index ──
  {
    const repo = scenario(({ put, rm, git }) => {
      put('.gitignore', '*.tmp\n');
      put('away/data', 'd\n');
      put('kept', 'k\n');
      put('assumed', 'a\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'c');
      git('update-index', '--skip-worktree', 'away/data', '.gitignore');
      git('update-index', '--assume-unchanged', 'assumed');
      rm('away');
      rm('.gitignore');
      put('assumed', 'changed, but assumed unchanged\n');
      put('x.tmp', 'ignored by the sparse .gitignore\n');
      put('kept', 'k2\n');
    });
    await statusAgrees('skip-worktree and assume-unchanged', repo);
    await sameIndexAfter('add -A with skip-worktree entries', repo, ['add', '-A']);
  }

  // ── Unmerged entries ──
  {
    const repo = scenario(({ put, rm, git, at }) => {
      put('both', 'base\n');
      put('ours-deletes', 'base\n');
      put('theirs-deletes', 'base\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'base');
      git('checkout', '-q', '-b', 'side');
      put('both', 'side\n');
      rm('theirs-deletes');
      put('ours-deletes', 'side\n');
      put('added-both', 'side\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'side');
      git('checkout', '-q', 'main');
      put('both', 'main\n');
      rm('ours-deletes');
      put('theirs-deletes', 'main\n');
      put('added-both', 'main\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'main');
      assert.equal(realGit(at, ['merge', '-q', 'side']).code, 1, 'the merge conflicts');
    });
    await statusAgrees('unmerged', repo);
  }

  // ── reset --hard restores what the worktree changed where the index already holds the target's ──
  {
    const repo = scenario(({ put, git }) => {
      put('kept', 'k\n');
      put('edited', 'e\n');
      put('removed', 'r\n');
      put('d/staged', 's\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'c');
    });
    const change = (path, content) => {
      writeFileSync(join(repo.disk, path), content);
      user.writeFile(`${repo.virtual.slice(1)}/${path}`, content);
    };
    change('edited', 'edited, and longer\n');
    change('d/staged', 'staged\n');
    await both(repo, ['add', 'd/staged']);
    rmSync(join(repo.disk, 'removed'));
    user.unlink(`${repo.virtual.slice(1)}/removed`);
    change('new', 'untracked, stays\n');
    await statusAgrees('before reset --hard', repo);
    await both(repo, ['reset', '-q', '--hard']);
    await statusAgrees('after reset --hard', repo);
    await same('reset --hard: the index', repo, ['ls-files', '-s']);
    for (const path of ['edited', 'removed', 'd/staged']) {
      assert.equal(new TextDecoder().decode(user.readFile(`${repo.virtual.slice(1)}/${path}`)), readFileSync(join(repo.disk, path), 'utf8'), path);
    }
    // A mixed reset of a staged change keeps the worktree, and says what is left unstaged.
    change('edited', 'again\n');
    await both(repo, ['add', 'edited']);
    await sameWithStderr('reset (mixed)', repo, ['reset']);
    await statusAgrees('after reset', repo);
    await sameWithStderr('reset -- a path', repo, ['reset', '--', 'edited']);
  }

  console.log(`git-status-matches-git: ${checks} commands byte-identical to ${realGit(scratch, ['--version']).stdout.toString().trim()}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
