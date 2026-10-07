#!/usr/bin/env bun
// `git clone --sparse`, against host git doing the same over the same
// server (git http-backend), on a tree with files at the top and below,
// executable and symlinked files, a gitlink, and a blob both inside and
// outside the cone:
//   - fast path (a server with filter and wants by id), streamed path (one
//     without), and --filter=blob:none: the same worktree (the top's files
//     only), the same index (`ls-files -s -t`: every path, those outside the
//     cone skip-worktree with no stat, `ls-files --debug`), the same
//     info/sparse-checkout, config.worktree and config, and a clean status,
//     host git's and ours; without a filter every object, as git holds them
//     (fsck clean), with one the objects host git holds;
//   - git checkout of another commit: what changed outside the cone is
//     indexed skip-worktree and never written (nor fetched, partial), what
//     changed inside is written; the same index and worktree as host git;
//   - an edit inside the cone, add -A and commit: the tree host git writes;
//   - a merge: refused with a named message, nothing changed (it does not
//     read skip-worktree entries yet).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, lstatSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startGitHttpServer } from './lib/git-http-server.mjs';
import { createFacetSession, hostGit as hostGitIn, hostObjects as hostObjectsIn } from './lib/facet-session.mjs';

const work = mkdtempSync(join(tmpdir(), 'nimbus-sparse-clone-'));
const hostGit = (cwd, args) => hostGitIn(work, cwd, args);
const hostObjects = (dir) => hostObjectsIn(work, dir);
const session = await createFacetSession(work);
const { git, requests } = session;

/** A worktree as a sorted list: each path (but .git), its kind, mode and contents. */
function worktreeOf(dir) {
  const out = [];
  const walk = (rel) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      if (rel === '' && name === '.git') continue;
      const path = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(dir, path));
      if (st.isSymbolicLink()) out.push([path, 'link', readlinkSync(join(dir, path))]);
      else if (st.isDirectory()) { out.push([path, 'dir']); walk(path); }
      else out.push([path, (st.mode & 0o111) ? 'exec' : 'file', readFileSync(join(dir, path), 'utf8')]);
    }
  };
  walk('');
  return out;
}
/** The objects a partial clone lacks, as host git lists them (never fetching: no promisor remote it can reach). */
const missing = (dir) => spawnSync('git', ['-c', 'remote.origin.promisor=false', 'rev-list', '--objects', '--missing=print', '--all'], {
  cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_NO_LAZY_FETCH: '1' },
}).stdout.split('\n').filter((line) => line.startsWith('?')).sort();
/** `ls-files --debug`'s blocks for skip-worktree entries (flags 40004000): their stat, all zero in git's. */
const skipBlocks = (dir) => hostGit(dir, ['ls-files', '--debug']).split(/\n(?=\S)/).filter((block) => /flags: 40004000/.test(block)).join('\n');
const sameRepo = (ours, host, label, { configUrl }) => {
  assert.deepEqual(worktreeOf(ours), worktreeOf(host), `${label}: the worktree`);
  assert.equal(hostGit(ours, ['ls-files', '-s', '-t']), hostGit(host, ['ls-files', '-s', '-t']), `${label}: the index`);
  for (const file of ['info/sparse-checkout', 'config.worktree']) {
    assert.equal(readFileSync(join(ours, '.git', file), 'utf8'), readFileSync(join(host, '.git', file), 'utf8'), `${label}: .git/${file}`);
  }
  assert.equal(readFileSync(join(ours, '.git/config'), 'utf8').replace(configUrl, 'URL'), readFileSync(join(host, '.git/config'), 'utf8').replace(/url = .*/, 'url = URL'), `${label}: .git/config`);
  assert.equal(hostGit(ours, ['status', '--porcelain']), '', `${label}: host git's status of ours is clean`);
};

try {
  const source = join(work, 'source');
  hostGit(work, ['init', '-q', '-b', 'main', source]);
  const write = (path, text) => { mkdirSync(join(source, path, '..'), { recursive: true }); writeFileSync(join(source, path), text); };
  write('README.md', 'top\n');
  write('same.txt', 'shared blob\n');
  write('run.sh', '#!/bin/sh\necho run\n');
  hostGit(source, ['update-index', '--chmod=+x', '--add', 'run.sh']);
  write('a/x.txt', 'a x\n');
  write('a/same.txt', 'shared blob\n');
  write('a/b/y.txt', 'a b y\n');
  write('c/z.txt', 'c z\n');
  symlinkSync('README.md', join(source, 'link'));
  symlinkSync('../README.md', join(source, 'c/up'));
  hostGit(source, ['add', '-A']);
  hostGit(source, ['update-index', '--chmod=+x', 'run.sh']);
  hostGit(source, ['update-index', '--add', '--cacheinfo', '160000,1234567890123456789012345678901234567890,sub']);
  hostGit(source, ['commit', '-q', '-m', 'first']);
  // The second commit changes one file inside the cone and two outside, and adds a directory.
  write('README.md', 'top, again\n');
  write('a/x.txt', 'a x, again\n');
  write('c/z.txt', 'c z, again\n');
  write('d/new.txt', 'new\n');
  hostGit(source, ['add', '-A']);
  hostGit(source, ['commit', '-q', '-m', 'second']);
  const first = hostGit(source, ['rev-parse', 'HEAD~1']).trim();

  const served = join(work, 'served');
  mkdirSync(served);
  hostGit(work, ['clone', '-q', '--bare', source, join(served, 'fast.git')]);
  hostGit(join(served, 'fast.git'), ['config', 'uploadpack.allowFilter', 'true']);
  hostGit(join(served, 'fast.git'), ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  hostGit(work, ['clone', '-q', '--bare', source, join(served, 'stream.git')]);
  const server = startGitHttpServer(served);
  // Without filter or wants by id (http-backend's defaults): the streamed clone.
  const plainServer = startGitHttpServer(served, { plain: true });
  try {
    // A depth-2 clone has the first commit to check out: the streamed one holds its blobs, the partial
    // one fetches what it needs; the fast one at depth 1.
    const cases = [
      { name: 'fast', at: server, repo: 'fast.git', args: ['--depth', '1'], checkout: false },
      { name: 'stream', at: plainServer, repo: 'stream.git', args: ['--depth', '2'], checkout: true },
      { name: 'partial', at: server, repo: 'fast.git', args: ['--depth', '2', '--filter=blob:none'], checkout: true },
    ];
    for (const { name, at, repo, args, checkout } of cases) {
      const url = at.url + '/' + repo;
      const host = join(work, 'host-' + name);
      // Host git from the same repository, by file:// (the http server is this process's: a
      // synchronous host git over it would wait on itself).
      hostGit(work, ['clone', '-q', '--sparse', ...args, 'file://' + join(served, repo), host]);
      const cloned = await git('/home/user', ['clone', '--sparse', ...args, url, name]);
      assert.equal(cloned.code, 0, `${name}: ${cloned.stderr}`);
      const ours = session.materialize('home/user/' + name, join(work, 'ours-' + name));
      sameRepo(ours, host, name, { configUrl: url });
      assert.match(hostGit(ours, ['ls-files', '-t']), /^S a\/x\.txt$/m, `${name}: outside the cone is skip-worktree`);
      assert.equal(skipBlocks(ours), skipBlocks(host), `${name}: skip-worktree entries, with no stat`);
      const status = await git('/home/user/' + name, ['status', '--porcelain']);
      assert.equal(status.code, 0, status.stderr);
      assert.equal(status.stdout, '', `${name}: our status is clean`);
      if (name === 'partial') {
        assert.deepEqual(session.sessionObjects('home/user/' + name).objects, hostObjects(host), 'partial: the objects host git holds');
        assert.deepEqual(missing(ours), missing(host), 'partial: the objects host git lacks');
      } else {
        const fsck = spawnSync('git', ['fsck', '--full', '--no-dangling'], { cwd: ours, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
        assert.equal(fsck.status, 0, `${name}: git fsck --full: ${fsck.stdout}${fsck.stderr}`);
        assert.deepEqual(session.sessionObjects('home/user/' + name).objects, hostObjects(host), `${name}: every object host git holds`);
      }
      console.log(`  ok  clone --sparse (${name}): host git's worktree, index, sparse files and config; status clean`);

      // checkout of the first commit, and back: outside the cone indexed, not written.
      const fetchesBefore = requests.fetchObjects;
      for (const [rev, label] of checkout ? [[first, 'first'], ['main', 'main']] : []) {
        const moved = await git('/home/user/' + name, ['checkout', rev]);
        assert.equal(moved.code, 0, `${name} checkout ${label}: ${moved.stderr}`);
        hostGit(host, ['checkout', '-q', rev]);
        const after = session.materialize('home/user/' + name, join(work, `ours-${name}-${label}`));
        assert.deepEqual(worktreeOf(after), worktreeOf(host), `${name} checkout ${label}: the worktree`);
        assert.equal(hostGit(after, ['ls-files', '-s', '-t']), hostGit(host, ['ls-files', '-s', '-t']), `${name} checkout ${label}: the index`);
        assert.equal(hostGit(after, ['status', '--porcelain']), '', `${name} checkout ${label}: clean`);
      }
      if (checkout && name === 'partial') {
        assert.ok(requests.fetchObjects - fetchesBefore <= 2, 'partial: the checkouts fetch only what the cone writes');
        assert.deepEqual(missing(session.materialize('home/user/' + name, join(work, 'ours-partial-missing'))), missing(host),
          `partial: after the checkouts, the same objects missing as host git (${requests.fetchObjects - fetchesBefore} fetches)`);
      }
      if (checkout) console.log(`  ok  checkout in the sparse clone (${name}): host git's index and worktree, outside the cone unwritten`);

      // A merge in a sparse checkout is refused, named, before anything is touched (the merge
      // does not read skip-worktree entries yet): HEAD, the index and the worktree as they were.
      if (name === 'stream') {
        const ident = { GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b' };
        for (const args of [['checkout', first], ['checkout', '-b', 'side']]) {
          const step = await git('/home/user/' + name, args, ident);
          assert.equal(step.code, 0, `${args.join(' ')}: ${step.stderr}`);
        }
        session.kernel.writeFile('home/user/' + name + '/run.sh', '#!/bin/sh\necho side\n');
        const sideCommit = await git('/home/user/' + name, ['commit', '-q', '-a', '-m', 'side'], ident);
        assert.equal(sideCommit.code, 0, sideCommit.stderr);
        const before = session.materialize('home/user/' + name, join(work, `ours-${name}-before-merge`));
        const merged = await git('/home/user/' + name, ['merge', 'main'], ident);
        assert.equal(merged.code, 128, `merge: refused: ${merged.stderr}`);
        assert.equal(merged.stderr, 'fatal: merging in a sparse checkout is not supported yet; nothing was changed\n');
        const after = session.materialize('home/user/' + name, join(work, `ours-${name}-after-merge`));
        assert.deepEqual(worktreeOf(after), worktreeOf(before), 'merge refused: the worktree as it was');
        for (const args of [['ls-files', '-s', '-t'], ['rev-parse', 'HEAD', 'side']]) {
          assert.equal(hostGit(after, args), hostGit(before, args), `merge refused: ${args.join(' ')} as it was`);
        }
        assert.equal((await git('/home/user/' + name, ['checkout', 'main'], ident)).code, 0);
        console.log('  ok  merge in the sparse clone (stream): refused, named, nothing changed');
      }

      // An edit inside the cone, add -A, commit: host git's tree.
      writeFileSync(join(host, 'README.md'), 'edited\n');
      hostGit(host, ['add', '-A']);
      const hostTree = hostGit(host, ['write-tree']).trim();
      session.kernel.writeFile('home/user/' + name + '/README.md', 'edited\n');
      const added = await git('/home/user/' + name, ['add', '-A']);
      assert.equal(added.code, 0, added.stderr);
      const committed = await git('/home/user/' + name, ['commit', '-q', '-m', 'edit'], {
        GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b',
      });
      assert.equal(committed.code, 0, committed.stderr);
      const ourTree = hostGit(session.materialize('home/user/' + name, join(work, `ours-${name}-commit`)), ['rev-parse', 'HEAD^{tree}']).trim();
      assert.equal(ourTree, hostTree, `${name}: add -A and commit keep every skip-worktree path`);
      console.log(`  ok  add -A and commit in the sparse clone (${name}): host git's tree`);
    }
  } finally {
    server.stop();
    plainServer.stop();
  }
  console.log('git-sparse-clone: ok');
} finally {
  rmSync(work, { recursive: true, force: true });
}
