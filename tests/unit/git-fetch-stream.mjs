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
//   - git fsck --full clean throughout;
//   - in a depth-1 clone, git fetch --deepen 2 then --unshallow leave the
//     shallow file, objects and history host git's do (a single stream);
//   - refs and the shallow file change only after the pack is stored: while
//     it is still arriving, another command sees the old tip and boundary;
//   - a fetch whose pack turns out corrupt fails, and leaves no temporary file.

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

    // A fetch whose pack is corrupt past its first pieces: it fails, and leaves no temporary file.
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const response = await realFetch(input, init);
      if (init?.method !== 'POST') return response;
      globalThis.fetch = realFetch;
      const body = new Uint8Array(await response.arrayBuffer());
      body[Math.floor(body.byteLength * 0.8)] ^= 0x55;
      return new Response(body, { status: response.status, headers: response.headers });
    };
    const writesBeforeBroken = session.requests.rangeWrites.length;
    const broken = await session.git('/home/user/repo', ['fetch']);
    globalThis.fetch = realFetch;
    assert.notEqual(broken.code, 0, 'a fetch of a corrupt pack succeeded');
    assert.ok(session.requests.rangeWrites.slice(writesBeforeBroken).some((write) => write.path.includes('/tmp_pack_')), 'the corrupt pack was stored in part');
    const leftovers = session.kernel.readdir('home/user/repo/.git/objects/pack').map((entry) => entry.name ?? entry).filter((name) => name.startsWith('tmp_'));
    assert.deepEqual(leftovers, [], 'the failed fetch left temporary files');

    const writesBefore = session.requests.rangeWrites.length;
    // What another command sees while the pack arrives: the refs and shallow file as they were.
    const durable = (path) => (session.kernel.exists(path) ? session.kernel.readFileString(path) : null);
    const seenDuringIngest = (repo) => {
      const seen = [];
      session.requests.onRangeWrite = (path) => {
        if (!path.includes('/objects/pack/tmp_pack_')) return;
        seen.push({ ref: durable(repo + '/.git/refs/remotes/origin/main'), shallow: durable(repo + '/.git/shallow') });
      };
      return seen;
    };
    const tipBefore = durable('home/user/repo/.git/refs/remotes/origin/main');
    const duringFetch = seenDuringIngest('home/user/repo');
    const fetched = await session.git('/home/user/repo', ['fetch']);
    session.requests.onRangeWrite = undefined;
    assert.ok(duringFetch.length >= 2, 'the fetch stored its pack in pieces');
    assert.ok(duringFetch.every((seen) => seen.ref === tipBefore),
      'refs/remotes/origin/main moved before the pack holding its commit was stored');
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
    hostGit(check, ['index-pack', '--rev-index', '-o', join(check, 'x.idx'), join(packDir, added[0])]);
    assert.deepEqual(readFileSync(join(check, 'x.idx')), readFileSync(join(packDir, added[0].replace(/pack$/, 'idx'))), 'idx equals git index-pack');
    assert.deepEqual(readFileSync(join(check, 'x.rev')), readFileSync(join(packDir, added[0].replace(/pack$/, 'rev'))), added[0] + ': rev');
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

    // Deepening a shallow clone, then unshallowing it.
    const shallow = await session.git('/home/user', ['clone', '--depth', '1', url, 'shallow']);
    assert.equal(shallow.code, 0, shallow.stderr);
    const hostShallow = join(work, 'host-shallow');
    hostGit(work, ['clone', '-q', '--depth', '1', '--single-branch', 'file://' + bare, hostShallow]);
    const step = async (args, label) => {
      const shallowBefore = durable('home/user/shallow/.git/shallow');
      const during = seenDuringIngest('home/user/shallow');
      const ran = await session.git('/home/user/shallow', ['fetch', ...args]);
      session.requests.onRangeWrite = undefined;
      assert.equal(ran.code, 0, label + ': ' + ran.stderr);
      assert.ok(during.length > 0 && during.every((seen) => seen.shallow === shallowBefore),
        label + ': .git/shallow changed before the pack holding the new parents was stored');
      hostGit(hostShallow, ['fetch', '-q', ...args]);
      const ours = session.materialize('home/user/shallow', mkdtempSync(join(work, 'deepen-')), '.git');
      assert.deepEqual(hostObjects(ours), hostObjects(hostShallow), label + ': the objects git holds');
      const shallowFile = (dir) => { try { return readFileSync(join(dir, '.git/shallow'), 'utf8'); } catch { return null; } };
      assert.equal(shallowFile(ours), shallowFile(hostShallow), label + ': .git/shallow');
      hostGit(ours, ['fsck', '--no-dangling', '--connectivity-only']);
    };
    await step(['--deepen', '2'], 'fetch --deepen 2');
    await step(['--unshallow'], 'fetch --unshallow');
    assert.equal((await session.git('/home/user/shallow', ['fetch', '--depth', '1', '--unshallow'])).code, 128);
  } finally {
    server.stop();
  }
  console.log('git-fetch-stream: ok');
} finally {
  rmSync(work, { recursive: true, force: true });
}
