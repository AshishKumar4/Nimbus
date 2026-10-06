#!/usr/bin/env bun
// git clone --no-shallow through the real facet (in-process) against git
// http-backend, beside host git clone --single-branch of the same
// repository: a history with merges, renames, a large file rewritten, an
// executable and a symlink.
//
// Pieces are made small (7 commits per trees request, 15 blobs per blobs
// request) and the decoding budget tiny, so every piece is split across
// invocations and resumed from its stored pack.
//
//   - the same objects as host git's clone, and git fsck --full clean;
//   - not shallow; HEAD, config, index and worktree as git's;
//   - every pack's idx equal to git index-pack's for it;
//   - one blobs request broken off mid-pack, one batch whose write to the
//     session is lost, and one trees piece that never answers, are each
//     retried as a fresh piece; a resumed piece whose pack was named but
//     whose answer was lost is run again from the outcome it recorded (its
//     pack cannot be fetched again).

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startGitHttpServer } from './lib/git-http-server.mjs';
import { createFacetSession, hostGit as hostGitIn, hostObjects as hostObjectsIn } from './lib/facet-session.mjs';

const work = mkdtempSync(join(tmpdir(), 'nimbus-history-'));
const hostGit = (cwd, args) => hostGitIn(work, cwd, args);
const hostObjects = (dir) => hostObjectsIn(work, dir);
const session = await createFacetSession(work);

try {
  const source = join(work, 'source');
  hostGit(work, ['init', '-q', '-b', 'main', source]);
  let seed = 11;
  const random = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  const text = (n) => Array.from({ length: n }, () => 'w' + Math.floor(random() * 300).toString(36)).join(' ') + '\n';
  mkdirSync(join(source, 'src/a'), { recursive: true });
  mkdirSync(join(source, 'src/b'), { recursive: true });
  writeFileSync(join(source, 'run.sh'), '#!/bin/sh\necho 0\n');
  chmodSync(join(source, 'run.sh'), 0o755);
  symlinkSync('src/a/f0.txt', join(source, 'link'));
  for (let commit = 0; commit < 30; commit++) {
    for (let f = 0; f < 6; f++) {
      if ((commit + f) % 3 === 0) writeFileSync(join(source, `src/${f % 2 ? 'a' : 'b'}/f${f}.txt`), text(150 + f * 40) + `rev ${commit}\n`);
    }
    if (commit % 7 === 0) writeFileSync(join(source, 'big.txt'), text(30_000) + `rev ${commit}\n`);
    if (commit === 12) hostGit(source, ['mv', 'src/b/f0.txt', 'src/b/renamed.txt']);
    hostGit(source, ['add', '-A']);
    hostGit(source, ['commit', '-q', '-m', `c${commit}`]);
    if (commit === 3) hostGit(source, ['tag', 'v0-light']);
    if (commit === 8) hostGit(source, ['tag', '-a', '-m', 'v1', 'v1']);
    if (commit % 10 === 5) {
      // A side branch merged back.
      hostGit(source, ['checkout', '-q', '-b', `side${commit}`]);
      writeFileSync(join(source, `side${commit}.txt`), text(80));
      hostGit(source, ['add', '-A']);
      hostGit(source, ['commit', '-q', '-m', `side ${commit}`]);
      hostGit(source, ['checkout', '-q', 'main']);
      hostGit(source, ['merge', '-q', '--no-ff', '-m', `merge ${commit}`, `side${commit}`]);
    }
  }
  const served = join(work, 'served');
  mkdirSync(served);
  hostGit(work, ['clone', '-q', '--bare', source, join(served, 'repo.git')]);
  hostGit(join(served, 'repo.git'), ['config', 'uploadpack.allowFilter', 'true']);
  hostGit(join(served, 'repo.git'), ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  hostGit(join(served, 'repo.git'), ['repack', '-adq']);
  const server = startGitHttpServer(served);
  const host = join(work, 'host');
  hostGit(work, ['clone', '-q', '--single-branch', 'file://' + join(served, 'repo.git'), host]);

  // The fourth upload-pack POST after the clone starts breaks off after its first bytes, once.
  const realFetch = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = async (input, init) => {
    const response = await realFetch(input, init);
    if (init?.method !== 'POST' || ++posts !== 4) return response;
    const reader = response.body.getReader();
    const first = await reader.read();
    void reader.cancel();
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(first.value);
        queueMicrotask(() => controller.error(new Error('connection reset')));
      },
    }), { status: response.status, headers: response.headers });
  };
  // A wave of the first batch (prepare publishes three) loses its connection.
  session.requests.failWaveAt = 5;
  // The second history invocation hangs; after the piece timeout it runs again.
  session.requests.hangPhaseAt = { phase: 'clone-history', at: 2, seen: 0 };
  // The first resumed history pack's naming lands, its answer does not.
  let lostRename = null;
  session.requests.loseRename = (from, to) => {
    if (lostRename !== null || !/\/tmp_pack_[^/]*_(commits|trees|blobs)-[^/]*$/.test(from) || !to.endsWith('.pack')) return false;
    const resumes = session.requests.phases.filter((phase) => phase === 'clone-history:resume').length;
    if (resumes === 0 || session.requests.phases.at(-1) !== 'clone-history:resume') return false;
    lostRename = from;
    return true;
  };
  try {
    const cloned = await session.git('/home/user', ['clone', '--no-shallow', server.url + '/repo.git', 'repo'], {
      NIMBUS_GIT_HISTORY_COMMITS_PER_CHUNK: '7',
      NIMBUS_GIT_HISTORY_BLOBS_PER_BATCH: '15',
      NIMBUS_GIT_HISTORY_BUDGET_UNITS: '200000',
      NIMBUS_GIT_PIECE_TIMEOUT_MS: '2000',
    });
    assert.equal(cloned.code, 0, cloned.stderr);
    const phases = session.requests.phases;
    const count = (name) => phases.filter((phase) => phase === name).length;
    assert.ok(count('clone-history:piece') > 5, 'history ran in pieces: ' + phases.join(','));
    assert.ok(count('clone-history:resume') > 5, 'pieces resumed from their stored packs: ' + phases.join(','));
    assert.equal(count('clone-history:plan'), 1);
    assert.equal(posts > 4, true);
    const attempts = session.requests.attempts;
    assert.ok(lostRename !== null, 'no resumed pack was named');
    assert.ok(attempts.filter((attempt) => attempt >= 2).length >= 4, 'each of the four faults was followed by another attempt: ' + attempts);
    assert.ok(session.requests.phases.indexOf('clone-batch') !== session.requests.phases.lastIndexOf('clone-batch'),
      'the batch whose wave was lost ran again');

    const out = session.materialize('home/user/repo', join(work, 'out'));
    assert.deepEqual(hostObjects(out), hostObjects(host), 'the objects git clone holds');
    hostGit(out, ['fsck', '--full', '--no-dangling']);
    assert.equal(statSync(join(out, '.git/shallow'), { throwIfNoEntry: false }), undefined, 'not shallow');
    assert.ok(!readdirSync(join(out, '.git')).includes('nimbus-clone'), 'staging removed');
    assert.equal(hostGit(out, ['rev-parse', 'HEAD', 'origin/main']), hostGit(host, ['rev-parse', 'HEAD', 'origin/main']));
    assert.equal(hostGit(out, ['rev-list', '--count', 'HEAD']), hostGit(host, ['rev-list', '--count', 'HEAD']));
    assert.equal(hostGit(out, ['show-ref', '--tags']), hostGit(host, ['show-ref', '--tags']), 'tags');
    assert.equal(hostGit(out, ['ls-files', '-s']), hostGit(host, ['ls-files', '-s']));
    const configOf = (dir) => readFileSync(join(dir, '.git/config'), 'utf8').replace(/url = .*/, 'url = X');
    assert.equal(configOf(out), configOf(host));
    for (const path of hostGit(host, ['ls-files']).trim().split('\n')) {
      if (path === 'link') continue;
      assert.deepEqual(readFileSync(join(out, path)), readFileSync(join(host, path)), path);
    }
    assert.equal(session.kernel.readlink('home/user/repo/link'), 'src/a/f0.txt');

    const packDir = join(out, '.git/objects/pack');
    assert.deepEqual(readdirSync(packDir).filter((name) => name.startsWith('tmp_')), [], 'retried pieces left no temporary pack');
    for (const pack of readdirSync(packDir).filter((name) => name.endsWith('.pack'))) {
      const check = mkdtempSync(join(work, 'check-'));
      hostGit(check, ['init', '-q']);
      hostGit(check, ['index-pack', '--rev-index', '-o', join(check, 'x.idx'), join(packDir, pack)]);
      assert.deepEqual(readFileSync(join(check, 'x.idx')), readFileSync(join(packDir, pack.replace(/pack$/, 'idx'))), pack);
      assert.deepEqual(readFileSync(join(check, 'x.rev')), readFileSync(join(packDir, pack.replace(/pack$/, 'rev'))), pack + ': rev');
    }
    assert.equal(hostGit(out, ['log', '-p', '--format=%H']), hostGit(host, ['log', '-p', '--format=%H']), 'log -p, every blob of history');
  } finally {
    globalThis.fetch = realFetch;
    server.stop();
  }
  console.log('git-history-clone: ok');
} finally {
  rmSync(work, { recursive: true, force: true });
}
