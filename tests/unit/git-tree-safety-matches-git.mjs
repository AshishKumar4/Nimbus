#!/usr/bin/env bun
// Trees JS git must not trust, against host git doing the same in the same
// state. Each repository is built with host git (mktree, hash-object
// --literally) and mirrored into the session.
//   - A malformed tree (no NUL and id at its end, a mode that is not octal
//     or starts with a space, an empty name): checkout, reset --hard, reset,
//     checkout <commit> -- . and diff exit 128 with git's fatal error, and
//     end. One decoder looped on such a tree, growing without bound (41 GB
//     before the kernel killed it), so these run in a child stopped at
//     30 s or 512 MiB resident, which fails the test naming the command.
//   - A tree holding a path git refuses (`.GIT`, `.git`, `..`, `.`, `git~1`,
//     `.git ` and a backslash before `.git` under core.protectNTFS, a link
//     named `.gitmodules`, `.g\u200cit` under core.protectHFS): checkout and
//     reset --hard refuse with git's errors and write nothing, the worktree
//     and .git as they were; reset leaves the index; checkout <commit> -- .
//     skips the path and writes the rest. Settings that let a name through
//     let it through here too.
//   - A clone of such a repository: git's errors, its repository kept with
//     nothing checked out and no index, as git leaves it.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { createFacetSession } from './lib/facet-session.mjs';
import { startGitHttpServer } from './lib/git-http-server.mjs';

const work = mkdtempSync(join(tmpdir(), 'nimbus-tree-safety-'));
process.on('exit', () => rmSync(work, { recursive: true, force: true }));
const GIT_ENV = {
  PATH: process.env.PATH,
  HOME: work,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com', GIT_COMMITTER_DATE: '1700000000 +0000',
  LC_ALL: 'C',
};

function hostGit(cwd, args, input) {
  const r = spawnSync('git', args, { cwd, input, env: GIT_ENV });
  return { code: r.status, stdout: r.stdout.toString('latin1'), stderr: r.stderr.toString() };
}

function sh(cwd, args, input) {
  const r = hostGit(cwd, args, input);
  assert.equal(r.code, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A tree object of `entries` ([mode, name, hex id]), as written, unchecked. */
function rawTree(repo, bytes) {
  return sh(repo, ['hash-object', '-t', 'tree', '--literally', '-w', '--stdin'], bytes);
}

function treeBytes(entries) {
  return Buffer.concat(entries.map(([mode, name, oid]) => Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(oid, 'hex')])));
}

/** A repository at `dir`: main with a.txt and b.txt; `evil` a commit on it whose tree `make` writes. */
function repository(dir, make) {
  mkdirSync(dir, { recursive: true });
  sh(dir, ['init', '-q', '-b', 'main']);
  for (const [name, text] of [['a.txt', 'a\n'], ['b.txt', 'b\n']]) writeFileSync(join(dir, name), text);
  sh(dir, ['add', 'a.txt', 'b.txt']);
  sh(dir, ['commit', '-q', '-m', 'main']);
  const blob = (text) => sh(dir, ['hash-object', '-w', '--stdin'], text);
  const tree = make({ a: blob('a\n'), evil: blob('evil\n'), tree: (bytes) => rawTree(dir, bytes) });
  sh(dir, ['branch', 'evil', sh(dir, ['commit-tree', tree, '-p', 'HEAD', '-m', 'evil'])]);
  return dir;
}

const session = await createFacetSession(work);
const user = session.vfs.as(CRED_SESSION_USER);

/** Copy a disk tree (its .git included) into the session at `to`. */
function mirror(from, to) {
  user.mkdir(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const st = lstatSync(join(from, name));
    if (st.isDirectory()) mirror(join(from, name), `${to}/${name}`);
    else if (st.isSymbolicLink()) user.symlink(readlinkSync(join(from, name)), `${to}/${name}`);
    else {
      user.writeFile(`${to}/${name}`, new Uint8Array(readFileSync(join(from, name))));
      user.chmod(`${to}/${name}`, st.mode & 0o777);
    }
  }
}

/** Every path below `root` with its content (a link's target), sorted: on disk, or in the session. */
function diskState(root, prefix = '') {
  const out = [];
  for (const name of readdirSync(join(root, prefix)).sort()) {
    const path = prefix ? `${prefix}/${name}` : name;
    const st = lstatSync(join(root, path));
    if (st.isDirectory()) out.push(`${path}/`, ...diskState(root, path));
    else out.push(`${path} ${st.isSymbolicLink() ? readlinkSync(join(root, path)) : readFileSync(join(root, path)).toString('hex')}`);
  }
  return out;
}

function sessionState(root, prefix = '') {
  const out = [];
  for (const { name, type } of [...user.readdir(prefix ? `${root}/${prefix}` : root)].sort((x, y) => (x.name < y.name ? -1 : 1))) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (type === 'directory') out.push(`${path}/`, ...sessionState(root, path));
    else out.push(`${path} ${type === 'symlink' ? user.readlink(`${root}/${path}`) : Buffer.from(user.readFile(`${root}/${path}`)).toString('hex')}`);
  }
  return out;
}

let cases = 0;
/**
 * The repository `make` builds (then `prepare`d), mirrored, then `args` run
 * by both gits: the same exit, stdout and stderr, and the same worktree,
 * index and HEAD after. `unchanged`: nothing in the session changed.
 */
async function same(label, make, args, { unchanged = false, prepare = () => {} } = {}) {
  const id = ++cases;
  const disk = repository(join(work, `disk-${id}`), make);
  prepare(disk);
  const root = `/home/user/case-${id}`;
  mirror(disk, root);
  const before = sessionState(root);
  const host = hostGit(disk, args);
  const ours = await session.git(root, args);
  assert.equal(ours.code, host.code, `${label}: git ${args.join(' ')} exits as git (git's: ${host.stderr}; ours: ${ours.stderr})`);
  assert.equal(ours.stderr, host.stderr, `${label}: git ${args.join(' ')}: stderr`);
  assert.equal(ours.stdout, host.stdout, `${label}: git ${args.join(' ')}: stdout`);
  if (unchanged) {
    assert.deepEqual(sessionState(root), before, `${label}: git ${args.join(' ')} wrote nothing`);
    assert.equal(user.exists(`home/user/config`), false, `${label}: nothing above the worktree`);
  }
  // Both sides end in the same state: the worktree, the index and HEAD.
  const copy = session.materialize(root.slice(1), join(work, `copy-${id}`));
  assert.deepEqual(diskState(copy).filter((line) => !line.startsWith('.git/') && line !== '.git/'),
    diskState(disk).filter((line) => !line.startsWith('.git/') && line !== '.git/'), `${label}: git ${args.join(' ')}: the worktree`);
  for (const probe of [['ls-files', '-s'], ['rev-parse', 'HEAD']]) {
    assert.equal(hostGit(copy, probe).stdout, hostGit(disk, probe).stdout, `${label}: git ${args.join(' ')}: git ${probe.join(' ')}`);
  }
}

if (process.argv[2] === 'malformed') {
  const malformed = {
    'no NUL before its id': ({ tree }) => tree(Buffer.from('a'.repeat(40))),
    'a truncated last entry': ({ tree, a }) => tree(Buffer.concat([treeBytes([['100644', 'a.txt', a]]), Buffer.from('100644 b')])),
    'a mode with a space first': ({ tree, a }) => tree(treeBytes([[' 100644', 'a.txt', a]])),
    'a mode that is not octal': ({ tree, a }) => tree(treeBytes([['10064x', 'a.txt', a]])),
    'an empty name': ({ tree, a }) => tree(treeBytes([['100644', '', a]])),
  };
  for (const [label, make] of Object.entries(malformed)) {
    for (const args of [['checkout', '-q', 'evil'], ['reset', '-q', '--hard', 'evil'], ['reset', '-q', 'evil'], ['checkout', 'evil', '--', '.'], ['diff', '--stat', 'evil']]) {
      console.log(`  ..  a tree with ${label}: git ${args.join(' ')}`);
      await same(label, make, args, { unchanged: true });
    }
    console.log(`  ok  a tree with ${label}: git's fatal error, nothing written`);
  }
  process.exit(0);
}

// The malformed trees, in a child watched for time and resident memory: a decoding that never ends fails here.
{
  const LIMIT_MS = 30_000;
  const LIMIT_RSS = 512 * 1024 * 1024;
  // Its scratch inside this one's, which goes with it however the child ends.
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'malformed'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: work } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const started = Date.now();
  let stopped = '';
  const watch = setInterval(() => {
    let rss = 0;
    try { rss = Number(/^VmRSS:\s+(\d+) kB$/m.exec(readFileSync(`/proc/${child.pid}/status`, 'utf8'))?.[1] ?? 0) * 1024; } catch { return; }
    if (rss > LIMIT_RSS) stopped = `at ${Math.round(rss / 1048576)} MiB resident`;
    else if (Date.now() - started > LIMIT_MS) stopped = `after ${LIMIT_MS / 1000} s`;
    if (stopped) child.kill('SIGKILL');
  }, 50);
  const code = await new Promise((resolve) => child.on('close', resolve));
  clearInterval(watch);
  process.stdout.write(stdout.split('\n').filter((line) => !line.startsWith('  ..  ')).join('\n'));
  const last = stdout.trimEnd().split('\n').at(-1) ?? '';
  assert.equal(stopped, '', `malformed trees: stopped ${stopped} in "${last.replace(/^ {2}\.\. {2}/, '')}": its decoding never ended`);
  assert.equal(code, 0, `malformed trees: the child failed:\n${stderr}`);
}

const sub = ({ tree, evil }, name) => tree(treeBytes([['40000', name, tree(treeBytes([['100644', 'config', evil]]))]]));
const refused = {
  '.GIT': (o) => o.tree(treeBytes([['40000', '.GIT', o.tree(treeBytes([['100644', 'config', o.evil]]))], ['100644', 'a.txt', o.evil]])),
  '.git/new': (o) => o.tree(treeBytes([['40000', '.git', o.tree(treeBytes([['100644', 'new', o.evil]]))], ['100644', 'a.txt', o.a]])),
  '..': (o) => sub(o, '..'),
  '.': (o) => sub(o, '.'),
  'git~1': (o) => sub(o, 'git~1'),
  '.git with a trailing space': (o) => sub(o, '.git '),
  'a backslash before .git': (o) => o.tree(treeBytes([['100644', 'x\\.git', o.evil]])),
  'a link named .gitmodules': (o) => o.tree(treeBytes([['120000', '.gitmodules', o.evil], ['100644', 'a.txt', o.a]])),
  'two refused paths and a change': (o) => o.tree(treeBytes([
    ['40000', '.GIT', o.tree(treeBytes([['100644', 'config', o.evil]]))], ['100644', 'a.txt', o.evil],
    ['40000', 'git~1', o.tree(treeBytes([['100644', 'x', o.evil]]))],
  ])),
};
for (const [label, make] of Object.entries(refused)) {
  for (const args of [['checkout', 'evil'], ['reset', '--hard', 'evil'], ['reset', 'evil']]) {
    await same(label, make, args, { unchanged: true });
  }
  await same(label, make, ['checkout', 'evil', '--', '.']);
  console.log(`  ok  a tree holding ${label}: checkout and reset refuse as git does, writing nothing; checkout -- . skips it`);
}

// A refused path and a local change the checkout would lose: each said as git says it.
await same('a local change', refused['.GIT'], ['checkout', 'evil'], { unchanged: true, prepare: (disk) => writeFileSync(join(disk, 'a.txt'), 'local\n') });
console.log('  ok  a refused path and a local change: both refusals, as git says them');

// What the settings let through goes through, as in git.
const allowed = {
  'git~1, core.protectNTFS off': [(o) => sub(o, 'git~1'), ['-c', 'core.protectNTFS=false']],
  '.g\u200cit, core.protectHFS off': [(o) => sub(o, '.g\u200cit'), []],
  '.gitmodules as a file': [(o) => o.tree(treeBytes([['100644', '.gitmodules', o.evil], ['100644', 'a.txt', o.a]])), []],
  'a backslash a name starts with, .git after it': [(o) => o.tree(treeBytes([['100644', '\\.git', o.evil], ['100644', 'a.txt', o.a]])), []],
};
for (const [label, [make, config]] of Object.entries(allowed)) {
  for (const args of [['checkout', '-q', 'evil'], ['reset', '-q', '--hard', 'evil']]) await same(label, make, [...config, ...args]);
  console.log(`  ok  ${label}: checked out, as git does`);
}
for (const args of [['checkout', 'evil'], ['reset', '--hard', 'evil']]) {
  await same('.g\u200cit, core.protectHFS on', (o) => sub(o, '.g\u200cit'), ['-c', 'core.protectHFS=true', ...args], { unchanged: true });
}
console.log('  ok  .g\u200cit under core.protectHFS: refused, as git does');

// A clone of a repository whose tree holds a refused path.
{
  const served = join(work, 'served');
  mkdirSync(served);
  const source = repository(join(work, 'clone-source'), refused['two refused paths and a change']);
  cpSync(join(source, '.git'), join(served, 'repo.git'), { recursive: true });
  sh(join(served, 'repo.git'), ['config', 'core.bare', 'true']);
  sh(join(served, 'repo.git'), ['symbolic-ref', 'HEAD', 'refs/heads/evil']);
  const server = startGitHttpServer(served);
  try {
    for (const flags of [[], ['--filter=blob:none']]) {
      const dest = `clone${flags.length}`;
      const host = await new Promise((resolve) => {
        const p = spawn('git', ['clone', ...flags, `${server.url}/repo.git`, join(work, dest)], { cwd: work, env: GIT_ENV });
        let stderr = '';
        p.stderr.on('data', (chunk) => { stderr += chunk; });
        p.on('close', (code) => resolve({ code, stderr }));
      });
      const ours = await session.git('/home/user', ['clone', ...flags, `${server.url}/repo.git`, dest]);
      const lines = (text) => text.split('\n').filter((line) => line && !line.startsWith('Cloning into') && !line.startsWith('[git]'));
      assert.equal(ours.code, host.code, `clone ${flags.join(' ')}: exit (git's: ${host.stderr}; ours: ${ours.stderr})`);
      assert.deepEqual(lines(ours.stderr), lines(host.stderr), `clone ${flags.join(' ')}: git's errors`);
      assert.deepEqual(sessionState(`/home/user/${dest}`).filter((line) => !line.startsWith('.git/')), [], `clone ${flags.join(' ')}: nothing checked out`);
      assert.equal(user.exists(`home/user/${dest}/.git/index`), false, `clone ${flags.join(' ')}: no index, as git leaves none`);
      for (const probe of [['rev-parse', 'HEAD'], ['ls-tree', '-r', 'HEAD']]) {
        assert.equal(hostGit(session.materialize(`home/user/${dest}`, join(work, `${dest}-copy`)), probe).stdout,
          hostGit(join(work, dest), probe).stdout, `clone ${flags.join(' ')}: git ${probe.join(' ')}`);
      }
      console.log(`  ok  clone ${flags.join(' ')}: git's error, the repository kept, nothing checked out`);
    }
  } finally {
    server.stop();
  }
}

// A clone checks out under the settings its command runs with: `-c` and the
// user's global config, never the config of the repository it is run in.
// Both planners: an unfiltered clone's (its stored pack) and a filtered one's.
{
  const served = join(work, 'served-settings');
  mkdirSync(served);
  const serve = (name, make) => {
    const source = repository(join(work, `settings-${name}`), make);
    cpSync(join(source, '.git'), join(served, `${name}.git`), { recursive: true });
    sh(join(served, `${name}.git`), ['config', 'core.bare', 'true']);
    sh(join(served, `${name}.git`), ['symbolic-ref', 'HEAD', 'refs/heads/evil']);
  };
  serve('hfs', (o) => sub(o, '.g\u200cit'));
  serve('ntfs', (o) => sub(o, 'git~1'));
  // A repository the clone is run in, whose own config would let git~1 through.
  sh(work, ['init', '-q', join(work, 'cwd-repo')]);
  sh(join(work, 'cwd-repo'), ['config', 'core.protectNTFS', 'false']);
  user.mkdir('home/user/cwd-repo', { recursive: true });
  assert.equal((await session.git('/home/user/cwd-repo', ['init', '-q'])).code, 0);
  assert.equal((await session.git('/home/user/cwd-repo', ['config', 'core.protectNTFS', 'false'])).code, 0);
  const server = startGitHttpServer(served);
  let n = 0;
  try {
    const cases = [
      ['core.protectHFS=true on the command line refuses .g\u200cit', 'hfs', ['-c', 'core.protectHFS=true'], {}, '/home/user', work],
      ['core.protectHFS=true in the user\'s ~/.gitconfig refuses .g\u200cit', 'hfs', [], { HOME: '/home/user' }, '/home/user', work],
      ['core.protectNTFS=false on the command line lets git~1 through', 'ntfs', ['-c', 'core.protectNTFS=false'], {}, '/home/user', work],
      ['the config of the repository a clone is run in is not the clone\'s', 'ntfs', [], {}, '/home/user/cwd-repo', join(work, 'cwd-repo')],
    ];
    for (const [label, name, settings, env, cwd, hostCwd] of cases) {
      for (const flags of [[], ['--filter=blob:none']]) {
        const dest = `settings-${++n}`;
        const global = env.HOME !== undefined;
        if (global) user.writeFile('home/user/.gitconfig', '[core]\n\tprotectHFS = true\n');
        const hostArgs = [...settings, ...(global ? ['-c', 'core.protectHFS=true'] : []), 'clone', ...flags, `${server.url}/${name}.git`, join(work, dest)];
        const host = await new Promise((resolve) => {
          const p = spawn('git', hostArgs, { cwd: hostCwd, env: GIT_ENV });
          let stderr = '';
          p.stderr.on('data', (chunk) => { stderr += chunk; });
          p.on('close', (code) => resolve({ code, stderr }));
        });
        const ours = await session.git(cwd, [...settings, 'clone', ...flags, `${server.url}/${name}.git`, `/home/user/${dest}`], env);
        if (global) user.unlink('home/user/.gitconfig');
        const lines = (text) => text.split('\n').filter((line) => line && !line.startsWith('Cloning into') && !line.startsWith('[git]'));
        const what = `${label} (clone ${flags.join(' ')})`;
        assert.equal(ours.code, host.code, `${what}: exit (git's: ${host.stderr}; ours: ${ours.stderr})`);
        assert.deepEqual(lines(ours.stderr), lines(host.stderr), `${what}: git's errors`);
        const checkedOut = (dir) => readdirSync(dir).filter((entry) => entry !== '.git').sort();
        assert.deepEqual(sessionState(`/home/user/${dest}`).filter((line) => !line.startsWith('.git/')).map((line) => line.split(' ')[0].replace(/\/$/, '')).filter((path) => !path.includes('/')).sort(),
          checkedOut(join(work, dest)), `${what}: what is checked out`);
      }
      console.log(`  ok  ${label}, in both planners`);
    }
  } finally {
    server.stop();
  }
}

console.log(`git-tree-safety-matches-git: ok (${cases} cases)`);
