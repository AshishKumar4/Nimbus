#!/usr/bin/env bun
// git clone from a server that offers no filter and takes no wants by id
// (git http-backend with its defaults), through the real facet (in-process),
// beside host git cloning the same URL. The server sends one pack; it is
// stored and indexed as it arrives, its decoding continues from the stored
// bytes when it passes the budget (made tiny here, so it resumes many
// times), the checkout is planned from the stored pack, and the batches
// read their blobs from it: the same batches and finish as the fast path's.
//
//   - depth 1 and --no-shallow: the same objects, HEAD, config, shallow,
//     tags (git follows those of what it fetched), index and worktree as
//     host git's clone, git fsck --full clean;
//   - the pack's idx equal to git index-pack's; no temporary pack left;
//   - no pack read longer than a page: nothing reads the pack whole;
//   - --filter is refused before anything is written, with the reason.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startGitHttpServer } from './lib/git-http-server.mjs';
import { createFacetSession, hostGit as hostGitIn, hostObjects as hostObjectsIn } from './lib/facet-session.mjs';

const work = mkdtempSync(join(tmpdir(), 'nimbus-stream-clone-'));
const hostGit = (cwd, args) => hostGitIn(work, cwd, args);
const hostObjects = (dir) => hostObjectsIn(work, dir);
const session = await createFacetSession(work);

try {
  const source = join(work, 'source');
  hostGit(work, ['init', '-q', '-b', 'main', source]);
  let seed = 23;
  const random = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  const text = (n) => Array.from({ length: n }, () => 'w' + Math.floor(random() * 300).toString(36)).join(' ') + '\n';
  mkdirSync(join(source, 'src/deep/er'), { recursive: true });
  mkdirSync(join(source, 'src/er'), { recursive: true });
  writeFileSync(join(source, 'run.sh'), '#!/bin/sh\necho 0\n');
  chmodSync(join(source, 'run.sh'), 0o755);
  symlinkSync('src/f0.txt', join(source, 'link'));
  writeFileSync(join(source, 'empty.txt'), '');
  for (let commit = 0; commit < 12; commit++) {
    for (let f = 0; f < 40; f++) {
      if ((commit + f) % 4 === 0) writeFileSync(join(source, `src/${f % 3 ? 'deep/' : ''}${f % 5 ? '' : 'er/'}f${f}.txt`), text(60 + f * 7) + `rev ${commit}\n`);
    }
    if (commit % 5 === 0) writeFileSync(join(source, 'big.bin'), Buffer.from(crypto.getRandomValues(new Uint8Array(1_500_000))));
    hostGit(source, ['add', '-A']);
    hostGit(source, ['commit', '-q', '-m', `c${commit}`]);
    if (commit === 4) {
      hostGit(source, ['tag', 'old-light']);
      hostGit(source, ['tag', '-a', '-m', 'old', 'old-annotated']);
    }
  }
  hostGit(source, ['tag', 'light']);
  hostGit(source, ['tag', '-a', '-m', 'release', 'annotated']);
  const served = join(work, 'served');
  mkdirSync(served);
  const bare = join(served, 'repo.git');
  hostGit(work, ['clone', '-q', '--bare', source, bare]);
  // http-backend's defaults: no filter, no wants by id.
  const server = startGitHttpServer(served, { plain: true });
  const url = server.url + '/repo.git';
  const env = { NIMBUS_GIT_HISTORY_BUDGET_UNITS: '300000', NIMBUS_GIT_BLOBS_PER_BATCH: '20' };
  try {
    for (const [name, flags, hostFlags] of [
      ['shallow', ['--depth', '1'], ['--depth', '1']],
      ['full', ['--no-shallow'], ['--single-branch']],
    ]) {
      const phasesBefore = session.requests.phases.length;
      const readsBefore = session.requests.rangeReads.length;
      const cloned = await session.git('/home/user', ['clone', ...flags, url, name], env);
      assert.equal(cloned.code, 0, name + ': ' + cloned.stderr);
      const phases = session.requests.phases.slice(phasesBefore);
      const count = (phase) => phases.filter((p) => p === phase).length;
      assert.equal(count('clone-prepare'), 1, name + ': ' + phases);
      assert.ok(count('clone-history:resume') >= 2, name + ': the pack resumed from its stored bytes: ' + phases);
      assert.equal(count('clone-history:checkout-plan'), 1, name + ': ' + phases);
      assert.ok(count('clone-batch') >= 2, name + ': the checkout ran in batches: ' + phases);
      assert.equal(count('clone-finish'), 1, name + ': ' + phases);
      assert.equal(count('clone-history:piece'), 0, name + ': no history pieces: the one pack holds it');

      const host = join(work, 'host-' + name);
      hostGit(work, ['clone', '-q', ...hostFlags, 'file://' + bare, host]);
      const out = session.materialize('home/user/' + name, join(work, 'out-' + name));
      assert.deepEqual(hostObjects(out), hostObjects(host), name + ': the objects git clone holds');
      hostGit(out, ['fsck', '--full', '--no-dangling']);
      assert.equal(hostGit(out, ['rev-parse', 'HEAD', 'origin/main', 'origin/HEAD']), hostGit(host, ['rev-parse', 'HEAD', 'origin/main', 'origin/HEAD']));
      assert.equal(hostGit(out, ['symbolic-ref', 'HEAD']), 'refs/heads/main\n');
      const configOf = (dir) => readFileSync(join(dir, '.git/config'), 'utf8').replace(/url = .*/, 'url = X');
      assert.equal(configOf(out), configOf(host), name + ': config');
      const shallowOf = (dir) => statSync(join(dir, '.git/shallow'), { throwIfNoEntry: false }) && readFileSync(join(dir, '.git/shallow'), 'utf8');
      assert.equal(shallowOf(out), shallowOf(host), name + ': shallow');
      assert.equal(hostGit(out, ['show-ref', '--tags']), hostGit(host, ['show-ref', '--tags']), name + ': tags');
      // Refs where git puts them: packed-refs byte for byte, the same loose refs.
      assert.deepEqual(readFileSync(join(out, '.git/packed-refs')), readFileSync(join(host, '.git/packed-refs')), name + ': packed-refs');
      const looseRefs = (dir) => hostGit(dir, ['for-each-ref', '--format=%(refname)']).trim().split('\n')
        .filter((ref) => statSync(join(dir, '.git', ref), { throwIfNoEntry: false }) !== undefined);
      assert.deepEqual(looseRefs(out), looseRefs(host), name + ': loose refs');
      assert.equal(hostGit(out, ['ls-files', '-s']), hostGit(host, ['ls-files', '-s']), name + ': index');
      assert.equal(hostGit(out, ['status', '--porcelain']), '', name + ': status clean');
      for (const path of hostGit(host, ['ls-files']).trim().split('\n')) {
        if (path === 'link') continue;
        assert.deepEqual(readFileSync(join(out, path)), readFileSync(join(host, path)), path);
      }
      assert.equal(session.kernel.readlink('home/user/' + name + '/link'), 'src/f0.txt');
      assert.equal(statSync(join(out, 'run.sh')).mode & 0o111, 0o111, 'run.sh is executable');
      assert.ok(!readdirSync(join(out, '.git')).includes('nimbus-clone'), 'staging removed');
      assert.ok(!existsSync(join(out, '.git/nimbus-clone-job')), 'marker removed');

      const packDir = join(out, '.git/objects/pack');
      const packs = readdirSync(packDir);
      assert.deepEqual(packs.filter((n) => n.startsWith('tmp_')), [], 'no temporary pack left');
      assert.equal(packs.filter((n) => n.endsWith('.pack')).length, 1, name + ': one pack');
      for (const pack of packs.filter((n) => n.endsWith('.pack'))) {
        const check = mkdtempSync(join(work, 'check-'));
        hostGit(check, ['init', '-q']);
        hostGit(check, ['index-pack', '--rev-index', '-o', join(check, 'x.idx'), join(packDir, pack)]);
        assert.deepEqual(readFileSync(join(check, 'x.idx')), readFileSync(join(packDir, pack.replace(/pack$/, 'idx'))), pack);
      assert.deepEqual(readFileSync(join(check, 'x.rev')), readFileSync(join(packDir, pack.replace(/pack$/, 'rev'))), pack + ': rev');
      }
      const packReads = session.requests.rangeReads.slice(readsBefore).filter((read) => read.path.endsWith('.pack'));
      assert.ok(packReads.length > 0, 'blobs were read back from the stored pack');
      const longest = Math.max(...packReads.map((read) => read.length));
      assert.ok(longest <= 4 * 1024 * 1024, name + ': a pack read of ' + longest + ' bytes');
    }
    assert.equal(hostGit(join(work, 'out-full'), ['log', '-p', '--format=%H']), hostGit(join(work, 'host-full'), ['log', '-p', '--format=%H']), 'log -p over every blob of history');

    // --filter needs a server that filters and sends objects by id.
    for (const filter of ['blob:none', 'tree:0']) {
      const refused = await session.git('/home/user', ['clone', '--depth', '1', '--filter=' + filter, url, 'partial'], env);
      assert.notEqual(refused.code, 0, 'a partial clone of a server without filter succeeded');
      assert.match(refused.stderr, /does not support --filter/);
      assert.equal(session.kernel.exists('home/user/partial'), false, 'the refused clone left its directory');
    }
    hostGit(bare, ['config', 'uploadpack.allowFilter', 'true']);
    const noById = await session.git('/home/user', ['clone', '--depth', '1', '--filter=blob:none', url, 'partial'], env);
    assert.notEqual(noById.code, 0);
    assert.match(noById.stderr, /does not send objects by id/);
    assert.equal(session.kernel.exists('home/user/partial'), false);
  } finally {
    server.stop();
  }

  // An empty remote: git clone --filter still records the promisor remote.
  {
    const emptyServed = join(work, 'empty-served');
    mkdirSync(emptyServed);
    hostGit(emptyServed, ['init', '-q', '--bare', '-b', 'main', 'empty.git']);
    const emptyServer = startGitHttpServer(emptyServed, { plain: true });
    try {
      const cloned = await session.git('/home/user', ['clone', '--filter=blob:none', emptyServer.url + '/empty.git', 'empty'], env);
      assert.equal(cloned.code, 0, cloned.stderr);
      const host = join(work, 'host-empty');
      hostGit(work, ['clone', '-q', '--single-branch', '--filter=blob:none', 'file://' + join(emptyServed, 'empty.git'), host]);
      const out = session.materialize('home/user/empty', join(work, 'out-empty'));
      // (git --single-branch writes no fetch refspec for an empty remote; Nimbus keeps the branch's.)
      for (const key of ['remote.origin.promisor', 'remote.origin.partialclonefilter', 'core.repositoryformatversion']) {
        assert.equal(hostGit(out, ['config', key]), hostGit(host, ['config', key]), key);
      }
    } finally {
      emptyServer.stop();
    }
  }
  console.log('git-stream-clone: ok');
} finally {
  rmSync(work, { recursive: true, force: true });
}
