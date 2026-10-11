#!/usr/bin/env bun
// `git clone --depth N` (N = 1, 2, 3) on a server with filter and wants by
// id (the fast path), against host git cloning the same repository at the
// same depth: the same objects (every blob of the N commits, not only the
// worktree's), the same shallow file, and git fsck --full clean. Red
// before: at depth 2 and 3 the older commits' blobs were never fetched
// ("broken link from tree ... to blob ...").

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startGitHttpServer } from './lib/git-http-server.mjs';
import { createFacetSession, hostGit as hostGitIn, hostObjects as hostObjectsIn } from './lib/facet-session.mjs';

const work = mkdtempSync(join(tmpdir(), 'nimbus-clone-depth-'));
const hostGit = (cwd, args) => hostGitIn(work, cwd, args);
const hostObjects = (dir) => hostObjectsIn(work, dir);
const session = await createFacetSession(work);

try {
  // Five commits: each changes one file, adds one, and removes one, in a nested tree.
  const source = join(work, 'source');
  hostGit(work, ['init', '-q', '-b', 'main', source]);
  for (let commit = 0; commit < 5; commit++) {
    mkdirSync(join(source, 'dir', `sub${commit % 2}`), { recursive: true });
    writeFileSync(join(source, 'changing.txt'), `version ${commit}\n`);
    writeFileSync(join(source, 'dir', `sub${commit % 2}`, `added-${commit}.txt`), `added in ${commit}\n`);
    if (commit >= 2) rmSync(join(source, 'dir', `sub${commit % 2}`, `added-${commit - 2}.txt`));
    hostGit(source, ['add', '-A']);
    hostGit(source, ['commit', '-q', '-m', `c${commit}`]);
  }
  const served = join(work, 'served');
  mkdirSync(served);
  hostGit(work, ['clone', '-q', '--bare', source, join(served, 'repo.git')]);
  const server = startGitHttpServer(served);
  try {
    for (const depth of [1, 2, 3]) {
      const host = join(work, `host-${depth}`);
      hostGit(work, ['clone', '-q', '--depth', String(depth), 'file://' + join(served, 'repo.git'), host]);
      const name = `depth-${depth}`;
      const cloned = await session.git('/home/user', ['clone', '--depth', String(depth), server.url + '/repo.git', name]);
      assert.equal(cloned.code, 0, `depth ${depth}: ${cloned.stderr}`);
      const ours = session.materialize('home/user/' + name, join(work, 'ours-' + name));
      assert.deepEqual(session.sessionObjects('home/user/' + name).objects, hostObjects(host), `depth ${depth}: the objects host git holds`);
      assert.equal(readFileSync(join(ours, '.git/shallow'), 'utf8'), readFileSync(join(host, '.git/shallow'), 'utf8'), `depth ${depth}: the shallow file`);
      const fsck = spawnSync('git', ['fsck', '--full', '--no-dangling'], { cwd: ours, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
      assert.equal(fsck.status, 0, `depth ${depth}: git fsck --full: ${fsck.stdout}${fsck.stderr}`);
      assert.equal(hostGit(ours, ['log', '--format=%H %T']), hostGit(host, ['log', '--format=%H %T']), `depth ${depth}: the history`);
      console.log(`  ok  --depth ${depth}: host git's objects and shallow file; fsck --full clean`);
    }
  } finally {
    server.stop();
  }
  console.log('git-clone-depth: ok');
} finally {
  rmSync(work, { recursive: true, force: true });
}
