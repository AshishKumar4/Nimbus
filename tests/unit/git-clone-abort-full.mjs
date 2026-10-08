#!/usr/bin/env bun
// A full clone that fails late, with a hundred packs and their staged
// files in .git, is aborted cleanly: the abort deletes .git file by file
// (and the destination it made: git-clone-abort-worktree).
// As one recursive delete it passed a write group's row limit live (vscode
// --no-shallow: "transaction exceeds logicalRows limit"), leaving the clone
// marked "still being cloned". Red before: .git remained.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startGitHttpServer } from './lib/git-http-server.mjs';
import { createFacetSession, hostGit as hostGitIn } from './lib/facet-session.mjs';

const work = mkdtempSync(join(tmpdir(), 'nimbus-abort-full-'));
const hostGit = (cwd, args) => hostGitIn(work, cwd, args);
const session = await createFacetSession(work);

try {
  const source = join(work, 'source');
  hostGit(work, ['init', '-q', '-b', 'main', source]);
  for (let commit = 0; commit < 60; commit++) {
    writeFileSync(join(source, `f${commit % 5}.txt`), `version ${commit}\n`.repeat(20));
    hostGit(source, ['add', '-A']);
    hostGit(source, ['commit', '-q', '-m', `c${commit}`]);
  }
  const served = join(work, 'served');
  mkdirSync(served);
  hostGit(work, ['clone', '-q', '--bare', source, join(served, 'repo.git')]);
  hostGit(join(served, 'repo.git'), ['config', 'uploadpack.allowFilter', 'true']);
  hostGit(join(served, 'repo.git'), ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  const server = startGitHttpServer(served);
  // After 50 requests every one is refused: the last blob pieces fail.
  const realFetch = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = async (input, init) => {
    if (init?.method === 'POST' && ++posts > 50) return new Response('refused', { status: 403 });
    return realFetch(input, init);
  };
  try {
    const cloned = await session.git('/home/user', ['clone', '--no-shallow', server.url + '/repo.git', 'repo'], {
      NIMBUS_GIT_HISTORY_BLOBS_PER_BATCH: '1',
    });
    assert.notEqual(cloned.code, 0, 'the clone fails');
    assert.match(cloned.stderr, /HTTP 403/);
    assert.ok(posts > 50);
    assert.equal(session.kernel.exists('home/user/repo/.git'), false, 'the abort removed .git: ' + cloned.stderr.slice(-300));
  } finally {
    globalThis.fetch = realFetch;
    server.stop();
  }
  console.log('git-clone-abort-full: ok');
} finally {
  rmSync(work, { recursive: true, force: true });
}
