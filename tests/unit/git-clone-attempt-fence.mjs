#!/usr/bin/env bun
// A clone piece that hangs is run again, but the hung one may still be
// running: its late writes must not land. Through the real facet
// (in-process) against git http-backend, one batch's facet call runs on
// with its answer withheld, its pack's second ranged write held until its
// retry has stored the same pack; then it resumes, and the clone finishes
// only once it has run to its end. Before the retry, the runner hands
// the clone's lease to a new owner (SqliteVFS.rotateExclusiveMutation) and
// loads a facet that writes as it, so the late writer's authority is gone.
//
//   - the clone succeeds, with the batch retried on a second facet;
//   - the late writer's resumed writes are refused (ESTALE);
//   - afterwards the repository is git's: objects, idx (git index-pack),
//     fsck --full, index and worktree, no temporary pack, no staging.
//
// Red before the fence: the late writer re-created its discarded temporary
// pack with a hole where its first write had been, and renamed it over the
// retry's pack of the same name.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startGitHttpServer } from './lib/git-http-server.mjs';
import { createFacetSession, hostGit as hostGitIn, hostObjects as hostObjectsIn } from './lib/facet-session.mjs';

const work = mkdtempSync(join(tmpdir(), 'nimbus-attempt-fence-'));
const hostGit = (cwd, args) => hostGitIn(work, cwd, args);
const hostObjects = (dir) => hostObjectsIn(work, dir);
const session = await createFacetSession(work);

try {
  const source = join(work, 'source');
  hostGit(work, ['init', '-q', '-b', 'main', source]);
  mkdirSync(join(source, 'data'));
  // Incompressible, so each batch's pack takes several ranged writes.
  for (let f = 0; f < 12; f++) writeFileSync(join(source, `data/f${f}.bin`), Buffer.from(crypto.getRandomValues(new Uint8Array(400_000))));
  hostGit(source, ['add', '-A']);
  hostGit(source, ['commit', '-q', '-m', 'data']);
  const served = join(work, 'served');
  mkdirSync(served);
  hostGit(work, ['clone', '-q', '--bare', source, join(served, 'repo.git')]);
  const server = startGitHttpServer(served);
  const host = join(work, 'host');
  hostGit(work, ['clone', '-q', '--depth', '1', 'file://' + join(served, 'repo.git'), host]);

  // The second batch call runs on unanswered; its second pack write waits for the clone to end.
  session.requests.stallPhaseAt = { phase: 'clone-batch', at: 2, seen: 0 };
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  let held = null;
  let batchCalls = 0;
  session.requests.onPhase = async (body) => {
    // The batch after the retry: the late writer resumes. Finish waits for it to end.
    if (body.phase === 'clone-batch' && ++batchCalls === 4) release();
    if (body.phase === 'clone-finish') await session.requests.stalled[0];
  };
  session.requests.onRangeWrite = (path, offset) => {
    if (held !== null || session.requests.stalled.length === 0) return;
    if (!/\/tmp_pack_[0-9a-f-]{36}_\d+$/.test(path) || offset === 0) return;
    held = path;
    return released;
  };
  try {
    const cloned = await session.git('/home/user', ['clone', '--depth', '1', server.url + '/repo.git', 'repo'], {
      NIMBUS_GIT_BLOBS_PER_BATCH: '3',
      NIMBUS_GIT_BATCH_CONCURRENCY: '1',
      NIMBUS_GIT_PIECE_TIMEOUT_MS: '1500',
    });
    assert.equal(cloned.code, 0, cloned.stderr);
    assert.ok(held !== null, 'the stalled batch never wrote its pack in pieces');
    assert.ok(session.requests.attempts.includes(2), 'the stalled batch was not retried');

    const late = await session.requests.stalled[0];

    const out = session.materialize('home/user/repo', join(work, 'out'));
    assert.deepEqual(hostObjects(out), hostObjects(host), 'the objects git clone holds');
    hostGit(out, ['fsck', '--full', '--no-dangling']);
    const packDir = join(out, '.git/objects/pack');
    assert.deepEqual(readdirSync(packDir).filter((name) => name.startsWith('tmp_')), [], 'no temporary pack');
    for (const pack of readdirSync(packDir).filter((name) => name.endsWith('.pack'))) {
      const check = mkdtempSync(join(work, 'check-'));
      hostGit(check, ['init', '-q']);
      hostGit(check, ['index-pack', '--rev-index', '-o', join(check, 'x.idx'), join(packDir, pack)]);
      assert.deepEqual(readFileSync(join(check, 'x.idx')), readFileSync(join(packDir, pack.replace(/pack$/, 'idx'))), pack);
      assert.deepEqual(readFileSync(join(check, 'x.rev')), readFileSync(join(packDir, pack.replace(/pack$/, 'rev'))), pack + ': rev');
    }
    assert.ok(!readdirSync(join(out, '.git')).includes('nimbus-clone'), 'no staging left');
    assert.equal(hostGit(out, ['ls-files', '-s']), hostGit(host, ['ls-files', '-s']));
    assert.equal(hostGit(out, ['status', '--porcelain']), '');
    assert.equal(late.success, false, 'the late writer finished as if it still held the clone');
    assert.ok(session.requests.refusals.some((code) => /ESTALE/.test(code)), 'its writes were not refused: ' + session.requests.refusals);
    assert.ok(session.requests.loads >= 2, 'the retry ran on the facet it was loaded with: ' + session.requests.loads + ' load(s)');
  } finally {
    release();
    server.stop();
  }
  console.log('git-clone-attempt-fence: ok');
} finally {
  rmSync(work, { recursive: true, force: true });
}
