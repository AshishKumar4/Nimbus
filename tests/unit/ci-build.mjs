#!/usr/bin/env bun
// scripts/ci/build.mjs: the build as one CI task, whose verdict and patch
// stand in for a local build. A patch that does not reproduce the tree the
// build left, or a verdict that calls a stale dist clean, would have every
// lane commit the wrong dist; so each case runs build.mjs on a fixture
// checkout and asserts what a lane gets: the rows, the exit status, and
// that applying the patch to a fresh clone of the commit gives exactly the
// tree the build made.
//
// The fixture's gate is a stand-in for scripts/dist-integrity.mjs with its
// contract: OUTPUT_ROOTS and FIXPOINT_RECORD exported, exit 0 when the tree
// is the fixpoint (recording it when the record is stale), 1 when its
// rebuild moved dist (recording nothing), 2 when the build failed.
//
// Then overlayCommit (scripts/ci/lib/armada.mjs): the commit a container
// gets is the lane's tree with the overlay files' bytes and modes, a new
// commit each time.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { armadaClient, overlayCommit } from '../../scripts/ci/lib/armada.mjs';
import { applyPatch } from '../../scripts/ci/remote-build.mjs';

const BUILD = join(import.meta.dirname, '..', '..', 'scripts', 'ci', 'build.mjs');

const GATE = `
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
export const OUTPUT_ROOTS = ['pkg'];
export const FIXPOINT_RECORD = 'record.json';
if (import.meta.main) {
  if (existsSync('pkg/src/broken')) { console.error('BUILD FAILED: pkg/src/broken'); process.exit(2); }
  const src = readFileSync('pkg/src/a.txt', 'utf8');
  const dist = src.toUpperCase();
  const had = existsSync('pkg/dist/a.txt') ? readFileSync('pkg/dist/a.txt', 'utf8') : null;
  writeFileSync('pkg/dist/a.txt', dist);
  // A binary output, as staged wasm is.
  writeFileSync('pkg/dist/a.bin', Buffer.from([0, 255, ...Buffer.from(dist)]));
  if (existsSync('pkg/src/stray')) writeFileSync('elsewhere.txt', 'written outside the outputs');
  if (had !== dist) { console.error('refusing to deploy: rebuilding rewrote pkg/dist/a.txt'); process.exit(1); }
  const record = 'fixpoint of ' + dist;
  if (!existsSync('record.json') || readFileSync('record.json', 'utf8') !== record) writeFileSync('record.json', record);
  console.log('dist-integrity OK');
}
`;

const run = (cwd, command, args, options = {}) => spawnSync(command, args, { cwd, encoding: 'utf8', ...options });
const git = (cwd, ...args) => {
  const done = run(cwd, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...args]);
  assert.equal(done.status, 0, `git ${args.join(' ')}: ${done.stderr}`);
  return done.stdout.trim();
};

const root = mkdtempSync(join(tmpdir(), 'ci-build-'));
try {
  /** A checkout whose commit is the fixture with `files` over it, built clean first when `fixpoint`. */
  const checkout = (name, files, { fixpoint = true, gate = GATE } = {}) => {
    const dir = join(root, name);
    mkdirSync(join(dir, 'pkg', 'src'), { recursive: true });
    mkdirSync(join(dir, 'pkg', 'dist'), { recursive: true });
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, 'scripts', 'dist-integrity.mjs'), gate);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { typecheck: 'node check.js' } }));
    writeFileSync(join(dir, 'check.js'), "if (require('fs').existsSync('pkg/src/ill-typed')) { console.log('pkg/src/ill-typed(1,1): error TS2322: nope'); process.exit(2); }\n");
    writeFileSync(join(dir, 'pkg', 'src', 'a.txt'), 'one');
    git(dir, 'init', '-q');
    // Twice, as a lane would: the first builds dist, the second records it.
    if (fixpoint) for (let i = 0; i < 2; i++) run(dir, 'bun', ['scripts/dist-integrity.mjs']);
    for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', name);
    return dir;
  };
  const build = (dir, ...args) => {
    const out = join(dir, '..', `${dir.split('/').at(-1)}.verdict.json`);
    const done = run(dir, 'bun', [BUILD, '--out', out, ...args]);
    return { status: done.status, stderr: done.stderr, ...JSON.parse(readFileSync(out, 'utf8')) };
  };
  const rows = (verdict) => Object.fromEntries(verdict.rows.map((row) => [row.name, row.exitCode]));
  /** The tree a fresh clone of `dir`'s commit has once `patch` is applied: what a lane commits. */
  const patched = (dir, patch) => {
    const clone = join(root, `${dir.split('/').at(-1)}-clone`);
    git(root, 'clone', '-q', dir, clone);
    writeFileSync(join(root, 'p.patch'), patch);
    git(clone, 'apply', join(root, 'p.patch'));
    git(clone, 'add', '-A');
    git(clone, 'commit', '-qm', 'build: record the dist fixpoint');
    return clone;
  };
  const same = (a, b, path) => assert.deepEqual(readFileSync(join(a, path)), readFileSync(join(b, path)), path);

  {
    const dir = checkout('clean', {});
    const verdict = build(dir);
    assert.equal(verdict.status, 0, verdict.stderr);
    assert.deepEqual(rows(verdict), { 'dist-fixpoint': 0, typecheck: 0 });
    assert.equal(verdict.patch, null);
    assert.deepEqual(verdict.blobs, {});
    assert.equal(verdict.head, git(dir, 'rev-parse', 'HEAD'));
    console.log('  ok  a commit whose dist is the fixpoint: both rows green, no patch, exit 0');
  }
  {
    const dir = checkout('stale', { 'pkg/src/a.txt': 'two' });
    const verdict = build(dir);
    assert.equal(verdict.status, 1);
    assert.deepEqual(rows(verdict), { 'dist-fixpoint': 1, typecheck: 0 });
    assert.match(verdict.rows[0].output, /rebuilding rewrote pkg\/dist\/a\.txt[\s\S]*the gate again[\s\S]*dist-integrity OK/);
    const clone = patched(dir, verdict.patch);
    for (const path of ['pkg/dist/a.txt', 'pkg/dist/a.bin', 'record.json']) same(clone, dir, path);
    assert.equal(readFileSync(join(clone, 'pkg/dist/a.txt'), 'utf8'), 'TWO');
    assert.equal(readFileSync(join(clone, 'record.json'), 'utf8'), 'fixpoint of TWO', 'the patch carries the record the second run wrote');
    assert.equal(build(clone).status, 0, 'the patched commit is clean');
    assert.deepEqual(Object.keys(verdict.blobs).sort(), ['pkg/dist/a.bin', 'pkg/dist/a.txt', 'record.json'], 'the blobs name what the patch touches');
    for (const [path, entry] of Object.entries(verdict.blobs)) {
      assert.deepEqual(entry, { mode: '100644', blob: git(dir, 'hash-object', path) }, `${path}: the mode and blob the build left`);
    }
    console.log('  ok  a stale dist: the patch, applied to the commit, is the rebuilt tree and its record, and that tree builds clean');
  }
  {
    const dir = checkout('record', { 'record.json': 'an old record' });
    const verdict = build(dir);
    assert.equal(verdict.status, 1);
    assert.deepEqual(rows(verdict), { 'dist-fixpoint': 1, typecheck: 0 }, 'a gate that only rewrote the record still leaves a patch to commit');
    assert.match(verdict.patch, /^diff --git a\/record\.json/m);
    console.log('  ok  a stale record alone: a patch of the record, exit 1');
  }
  {
    const dir = checkout('ill-typed', { 'pkg/src/ill-typed': '' });
    const verdict = build(dir);
    assert.equal(verdict.status, 1);
    assert.deepEqual(rows(verdict), { 'dist-fixpoint': 0, typecheck: 2 });
    assert.match(verdict.rows[1].output, /error TS2322: nope/);
    console.log('  ok  a typecheck error: its row is red with the errors, exit 1');
  }
  {
    const dir = checkout('broken', { 'pkg/src/broken': '' });
    const verdict = build(dir);
    assert.equal(verdict.status, 1);
    assert.deepEqual(rows(verdict), { 'dist-fixpoint': 2, typecheck: 0 });
    assert.match(verdict.rows[0].output, /BUILD FAILED/);
    assert.equal(verdict.patch, null);
    console.log('  ok  a failed build: its row says so (2), no patch, exit 1');
  }
  {
    const dir = checkout('stray', { 'pkg/src/stray': '' });
    const verdict = build(dir);
    assert.equal(verdict.status, 1);
    assert.equal(rows(verdict)['dist-fixpoint'], 1);
    assert.match(verdict.rows[0].output, /wrote outside its outputs[\s\S]*elsewhere\.txt/);
    assert.doesNotMatch(verdict.patch ?? '', /elsewhere/);
    console.log('  ok  a build that writes outside its outputs is red and names the file, which the patch leaves out');
  }
  {
    // A build that moves an output: the patch, and the receipts, are a
    // removal and an addition, and remote-build applies it to the commit.
    const moving = `
import { existsSync, renameSync } from 'node:fs';
export const OUTPUT_ROOTS = ['pkg'];
export const FIXPOINT_RECORD = 'record.json';
if (import.meta.main && existsSync('pkg/dist/old.bin')) { renameSync('pkg/dist/old.bin', 'pkg/dist/new.bin'); process.exit(1); }
`;
    const dir = checkout('moved', { 'pkg/dist/old.bin': 'the same bytes, at a new path' }, { fixpoint: false, gate: moving });
    const sha = git(dir, 'rev-parse', 'HEAD');
    const verdict = build(dir);
    assert.equal(verdict.status, 1);
    assert.deepEqual(Object.keys(verdict.blobs).sort(), ['pkg/dist/new.bin', 'pkg/dist/old.bin']);
    assert.equal(verdict.blobs['pkg/dist/old.bin'], null, 'the old path is a removal');
    const clone = join(root, 'moved-clone');
    git(root, 'clone', '-q', dir, clone);
    writeFileSync(join(root, 'moved.patch'), verdict.patch);
    assert.match(applyPatch(clone, sha, join(root, 'moved.patch'), verdict.blobs), /applied the dist patch \(2 files\)/);
    assert.equal(readFileSync(join(clone, 'pkg/dist/new.bin'), 'utf8'), 'the same bytes, at a new path');
    assert.equal(git(clone, 'status', '--porcelain', '--', 'pkg/dist/old.bin'), 'D pkg/dist/old.bin');
    console.log('  ok  a moved output is a removal and an addition in the receipts, and remote-build applies its patch');
  }
  {
    const dir = checkout('dirty', {});
    writeFileSync(join(dir, 'pkg', 'src', 'a.txt'), 'uncommitted');
    const verdict = build(dir);
    assert.equal(verdict.status, 2);
    assert.deepEqual(rows(verdict), { checkout: 2 });
    assert.match(verdict.rows[0].output, /not clean[\s\S]*pkg\/src\/a\.txt/);
    console.log('  ok  a checkout that is not clean is not graded (2)');
  }
  {
    const dir = checkout('lane', {});
    const sha = git(dir, 'rev-parse', 'HEAD');
    const from = join(root, 'overlay-source');
    mkdirSync(join(from, 'scripts'), { recursive: true });
    writeFileSync(join(from, 'config.json'), '{"name":"x"}\n');
    writeFileSync(join(from, 'scripts', 'setup.sh'), '#!/bin/sh\n');
    chmodSync(join(from, 'scripts', 'setup.sh'), 0o755);
    writeFileSync(join(from, 'package.json'), '{"replaced":true}\n');
    const files = ['config.json', 'scripts/setup.sh', 'package.json'];
    const commit = overlayCommit(dir, sha, files, from);
    assert.notEqual(overlayCommit(dir, sha, files, from), commit, 'each call is a new commit, so no run reuses a pack armada stored for another');
    assert.equal(git(dir, 'rev-parse', `${commit}^`), sha);
    assert.equal(git(dir, 'show', `${commit}:package.json`), '{"replaced":true}');
    assert.match(git(dir, 'ls-tree', commit, 'scripts/setup.sh'), /^100755 /);
    assert.match(git(dir, 'ls-tree', commit, 'config.json'), /^100644 /);
    assert.equal(git(dir, 'diff', '--name-only', sha, commit), 'config.json\npackage.json\nscripts/setup.sh');
    assert.equal(git(dir, 'rev-parse', 'HEAD'), sha, 'no branch moved');
    assert.equal(git(dir, 'status', '--porcelain'), '', 'the worktree and its index are untouched');
    console.log('  ok  overlayCommit: the lane\'s tree with the overlay\'s bytes and modes, on no branch, new each time');
  }
  {
    // The pinned client: a clean checkout of the pin, and the pin on its repository's main.
    const upstream = join(root, 'armada.git');
    const seed = join(root, 'armada-seed');
    git(root, 'init', '-q', '--bare', '-b', 'main', upstream);
    git(root, 'init', '-q', '-b', 'main', seed);
    writeFileSync(join(seed, 'cli.ts'), '// a client\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-qm', 'client');
    const pin = git(seed, 'rev-parse', 'HEAD');
    git(seed, 'push', '-q', upstream, 'main');
    const client = join(root, 'armada-client');
    git(root, 'clone', '-q', upstream, client);
    assert.equal(armadaClient({ dir: client, repo: upstream, pin }), client, 'a clean checkout of a pin on main is the client');
    writeFileSync(join(client, 'cli.ts'), '// edited\n');
    assert.throws(() => armadaClient({ dir: client, repo: upstream, pin }), /must be a clean checkout .* with local changes/);
    git(client, 'checkout', '-q', '--', 'cli.ts');
    // Main rewritten under the pin: a new root commit, force-pushed.
    git(seed, 'checkout', '-q', '--orphan', 'rewritten');
    writeFileSync(join(seed, 'cli.ts'), '// rewritten\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-qm', 'rewritten');
    git(seed, 'push', '-q', '--force', upstream, 'rewritten:main');
    assert.throws(() => armadaClient({ dir: client, repo: upstream, pin }), /is not on main of .*: its history was rewritten under the pin/);
    console.log('  ok  the armada client is a clean checkout of the pin, and the pin must still be on its repository\'s main');
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log('ci-build OK');
