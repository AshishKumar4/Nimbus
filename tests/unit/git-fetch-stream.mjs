#!/usr/bin/env bun
// git fetch and git pull through the real facet running the staged cf-git
// bundle (in-process), against git http-backend, beside host git doing the
// same: the fetched pack is stored as it arrives and indexed in the same
// pass (git/pack/facet-packs.ts through cf-git's packs seam), and objects
// are read by range.
//
//   - after git fetch: the same objects and refs as host git's fetch; the
//     new pack's idx equal to git index-pack's; the pack written in pieces;
//   - after git pull: the same worktree, HEAD and objects as host git's;
//   - git fsck --full clean throughout.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startGitHttpServer } from './lib/git-http-server.mjs';
import { createFacetSession, hostGit as hostGitIn, hostObjects as hostObjectsIn } from './lib/facet-session.mjs';

const work = mkdtempSync(join(tmpdir(), 'nimbus-fetch-stream-'));
const hostGit = (cwd, args) => hostGitIn(work, cwd, args);
const hostObjects = (dir) => hostObjectsIn(work, dir);
const session = await createFacetSession(work, { realGit: true });

try {
  const source = join(work, 'source');
  hostGit(work, ['init', '-q', '-b', 'main', source]);
  let seed = 5;
  const random = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  const text = (n) => Array.from({ length: n }, () => 'w' + Math.floor(random() * 400).toString(36)).join(' ') + '\n';
  const commit = (n, label) => {
    mkdirSync(join(source, 'src'), { recursive: true });
    for (let f = 0; f < 8; f++) if ((n + f) % 2 === 0) writeFileSync(join(source, `src/f${f}.txt`), text(400 + f * 50) + label + '\n');
    // Barely compressible, so a fetch of a few commits passes one 448 KiB append.
    writeFileSync(join(source, 'big.txt'), Buffer.from(crypto.getRandomValues(new Uint8Array(300_000))).toString('base64') + label + '\n');
    hostGit(source, ['add', '-A']);
    hostGit(source, ['commit', '-q', '-m', label]);
  };
  for (let n = 0; n < 3; n++) commit(n, 'first ' + n);
  const served = join(work, 'served');
  mkdirSync(served);
  const bare = join(served, 'repo.git');
  hostGit(work, ['clone', '-q', '--bare', source, bare]);
  hostGit(bare, ['config', 'uploadpack.allowFilter', 'true']);
  hostGit(bare, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  const server = startGitHttpServer(served);
  const url = server.url + '/repo.git';
  try {
    const cloned = await session.git('/home/user', ['clone', '--no-shallow', url, 'repo']);
    assert.equal(cloned.code, 0, cloned.stderr);
    const host = join(work, 'host');
    hostGit(work, ['clone', '-q', '--single-branch', 'file://' + bare, host]);

    // New history on the server.
    for (let n = 3; n < 6; n++) commit(n, 'second ' + n);
    hostGit(source, ['push', '-q', bare, 'main']);
    const packsBefore = new Set(readdirSync(join(session.materialize('home/user/repo', mkdtempSync(join(work, 'before-')), '.git'), '.git/objects/pack')));

    const writesBefore = session.requests.rangeWrites.length;
    const fetched = await session.git('/home/user/repo', ['fetch']);
    assert.equal(fetched.code, 0, fetched.stderr);
    hostGit(host, ['fetch', '-q']);
    const afterFetch = session.materialize('home/user/repo', mkdtempSync(join(work, 'fetch-')), '.git');
    assert.deepEqual(hostObjects(afterFetch), hostObjects(host), 'fetch: the objects git holds');
    assert.equal(hostGit(afterFetch, ['rev-parse', 'origin/main']), hostGit(host, ['rev-parse', 'origin/main']));
    hostGit(afterFetch, ['fsck', '--full', '--no-dangling']);
    const packDir = join(afterFetch, '.git/objects/pack');
    const added = readdirSync(packDir).filter((name) => name.endsWith('.pack') && !packsBefore.has(name));
    assert.equal(added.length, 1, 'one pack for the fetch');
    const check = mkdtempSync(join(work, 'check-'));
    hostGit(check, ['init', '-q']);
    hostGit(check, ['index-pack', '-o', join(check, 'x.idx'), join(packDir, added[0])]);
    assert.deepEqual(readFileSync(join(check, 'x.idx')), readFileSync(join(packDir, added[0].replace(/pack$/, 'idx'))), 'idx equals git index-pack');
    assert.ok(!readdirSync(packDir).some((name) => name.startsWith('tmp_')), 'no temporary packs left');
    // Stored as it arrived: ranged appends to a temporary pack, never one whole-file write.
    const appends = session.requests.rangeWrites.slice(writesBefore).filter((write) => write.path.includes('/objects/pack/tmp_pack_'));
    assert.ok(appends.length >= 2, 'the pack went out in pieces: ' + appends.length);
    assert.ok(Math.max(...appends.map((write) => write.bytes)) <= 512 * 1024);

    const pulled = await session.git('/home/user/repo', ['pull']);
    assert.equal(pulled.code, 0, pulled.stderr);
    hostGit(host, ['pull', '-q']);
    const out = session.materialize('home/user/repo', join(work, 'out'));
    assert.equal(hostGit(out, ['rev-parse', 'HEAD']), hostGit(host, ['rev-parse', 'HEAD']));
    for (const path of hostGit(host, ['ls-files']).trim().split('\n')) {
      assert.deepEqual(readFileSync(join(out, path)), readFileSync(join(host, path)), path);
    }
    hostGit(out, ['fsck', '--full', '--no-dangling']);
    assert.equal(hostGit(out, ['status', '--porcelain']), '');
  } finally {
    server.stop();
  }
  console.log('git-fetch-stream: ok');
} finally {
  rmSync(work, { recursive: true, force: true });
}
