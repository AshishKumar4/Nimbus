#!/usr/bin/env bun
// dist-integrity — a deploy must not ship a `dist` its own `src` disagrees
// with.
//
// packages/worker resolves `.` to `src` under the `workspace` condition and
// to `dist/index.js` under `import`/`main`, so every test in this directory
// reads SOURCE while wrangler ships DIST, and nothing between them ever
// compared the two. Two commits' worth of near-misses in one week: a
// security-relevant fix that existed only in src, and a runtime-catalog
// trust root whose dist half was absent entirely.
//
// [1] stands over the real repo: what dist says it staged is what is
// staged. The rest exist so [1] cannot pass by doing nothing — they build
// a tree with the same topology as this one (a bundler that reads dist and
// writes back into src) and assert the gate REFUSES each way that tree can
// go wrong. Every red case below is asserted to fail; a gate that has
// never been observed refusing anything is not evidence.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BuildFailure,
  assertDistMatchesSource,
  checkStagedAssets,
  fingerprintBuildInputs,
  rebuildDrift,
  runBuildFixpoint,
  snapshotBuildOutputs,
  withCheckoutLock,
} from '../../scripts/dist-integrity.mjs';
import { assertGeneratedSourcesAreCurrent } from './lib/generated-freshness.mjs';

// ── [1] THE INVARIANT, over the real repo ────────────────────────────
// No rebuild here: this half needs none. It reads the compiled artifact
// constants under packages/worker/dist and the bytes under
// packages/worker/public that every deploy target serves, and asks whether
// they still describe each other. `bundle:shims` is why it matters — it is
// the one bundler that reads dist, so a bundle-before-build leaves this
// pair disagreeing.
{
  const { verified, unverified, violations } = await checkStagedAssets();
  assert.deepEqual(violations, [], 'dist points at assets that are not staged as it describes them');
  assert.ok(
    verified.some((line) => line.includes('NODE_SHIMS_ENTRY')),
    `the node-shims pointer must be among the verified assets, got:\n${verified.join('\n')}`,
  );
  console.log(`  ok  [1] real repo: ${verified.length} staged assets match dist (${unverified.length} carry no digest)`);
}

// ── A tree shaped like this one ──────────────────────────────────────
//
// One package. `build` compiles src → dist. `bundle` reads DIST — never
// src — stages a content-hashed asset and writes the pointer back into
// src, exactly as scripts/bundle-node-shims.mjs does. That is the whole
// reason build order can silently ship stale bytes, so the fixture keeps
// it rather than simplifying it away.

const BUILD_MJS = `
import { cpSync, rmSync } from 'node:fs';
rmSync('dist', { recursive: true, force: true });
cpSync('src', 'dist', { recursive: true });
`;

const BUNDLE_MJS = `
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Reads dist, like bundle:shims does. This is the trap.
const payload = readFileSync(join('dist', 'payload.js'), 'utf8');
const sha256 = createHash('sha256').update(payload, 'utf8').digest('hex');
const buildId = sha256.slice(0, 16);
const assetName = \`payload-\${buildId}.js\`;
const assetDir = join('public', '_assets', 'runtime');

mkdirSync(assetDir, { recursive: true });
for (const f of readdirSync(assetDir)) {
  if (f.startsWith('payload-') && f !== assetName) rmSync(join(assetDir, f));
}
writeFileSync(join(assetDir, assetName), payload);
writeFileSync(join('src', 'payload-artifact.generated.js'),
  \`export const PAYLOAD_ENTRY = "/_assets/runtime/\${assetName}";\\n\`
  + \`export const PAYLOAD_BUILD_ID = "\${buildId}";\\n\`
  + \`export const PAYLOAD_SHA256 = "\${sha256}";\\n\`);
`;

const STEPS = [
  { cwd: 'packages/worker', script: 'build', why: 'compile src → dist' },
  { cwd: 'packages/worker', script: 'bundle', why: 'stage assets — reads dist' },
  { cwd: 'packages/worker', script: 'build', why: 'carry the pointer into dist' },
];
const ROOTS = ['packages/worker'];

/** A fixture already at the fixpoint, so any later drift is the test's doing. */
async function fixtureAtFixpoint(payload = 'export const PAYLOAD = 1;\n') {
  const root = mkdtempSync(join(tmpdir(), 'dist-integrity-'));
  process.on('exit', () => rmSync(root, { recursive: true, force: true }));
  const pkg = join(root, 'packages', 'worker');
  mkdirSync(join(pkg, 'src'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({
    name: 'fixture-worker',
    type: 'module',
    scripts: { build: 'node build.mjs', bundle: 'node bundle.mjs' },
  }));
  writeFileSync(join(pkg, 'build.mjs'), BUILD_MJS);
  writeFileSync(join(pkg, 'bundle.mjs'), BUNDLE_MJS);
  writeFileSync(join(pkg, 'src', 'payload.js'), payload);
  spawnSync('git', ['init', '-q'], { cwd: root });

  // The first build creates dist and the staged asset from nothing, so of
  // course it moves files. Reaching the fixpoint is setup; the gate then
  // confirms the tree really is at it, which is also the first proof it
  // passes on a tree that is genuinely current.
  runBuildFixpoint({ root, steps: STEPS });
  await assertDistMatchesSource({ root, roots: ROOTS, steps: STEPS });
  return { root, pkg };
}

/** Run the gate and return the refusal, or throw if it let the tree past. */
async function refusal(root, what) {
  try {
    await assertDistMatchesSource({ root, roots: ROOTS, steps: STEPS });
  } catch (error) {
    return error.message;
  }
  throw new assert.AssertionError({ message: `the gate accepted ${what}` });
}

// ── [2] GREEN: a tree at the fixpoint deploys ────────────────────────
{
  const { root } = await fixtureAtFixpoint();
  const drift = rebuildDrift({ root, roots: ROOTS, steps: STEPS });
  assert.deepEqual(drift, { changed: [], added: [], removed: [] },
    'rebuilding a current tree must move nothing');
  console.log('  ok  [2] a tree whose dist is the fixpoint of its src passes');
}

// ── [3] RED: the incident — src changed, committed dist did not ──────
// 7b2eae9/c2e4277/b9397d1 in one line: the fix is in src, dist predates it,
// and a deploy from that tree ships a Worker missing it.
{
  const { root, pkg } = await fixtureAtFixpoint();
  writeFileSync(join(pkg, 'src', 'payload.js'), 'export const PAYLOAD = 2; // the fix\n');

  const message = await refusal(root, 'a src change with a stale dist');
  assert.match(message, /did not match its source/);
  assert.match(message, /packages\/worker\/dist\/payload\.js/,
    `the refusal must name the stale dist file, got:\n${message}`);
  assert.ok(
    readFileSync(join(pkg, 'dist', 'payload.js'), 'utf8').includes('the fix'),
    'and the rebuild must have left the tree correct, so the retry is one command',
  );
  console.log('  ok  [3] refuses a src change whose dist was never rebuilt');
}

// ── [4] RED: the wrong build order ───────────────────────────────────
// `bundle` before `build` reads the PREVIOUS dist, so the staged asset and
// its pointer are internally consistent and both a generation behind.
// Nothing about that tree looks wrong; only rebuilding in the right order
// shows it.
{
  const { root, pkg } = await fixtureAtFixpoint();
  writeFileSync(join(pkg, 'src', 'payload.js'), 'export const PAYLOAD = 3;\n');
  spawnSync('bun', ['run', '--cwd', 'packages/worker', 'bundle'], { cwd: root });
  spawnSync('bun', ['run', '--cwd', 'packages/worker', 'build'], { cwd: root });

  // The trap: this tree passes the pointer check, because the pointer and
  // the staged bytes agree with each other. They are just both stale.
  const pointer = await checkStagedAssets({ root });
  assert.deepEqual(pointer.violations, [],
    'a wrong-order build leaves a self-consistent pointer — which is why the pointer check alone is not the gate');

  const message = await refusal(root, 'a bundle-before-build tree');
  assert.match(message, /payload-artifact\.generated\.js/,
    `the refusal must name the stale generated pointer, got:\n${message}`);
  console.log('  ok  [4] refuses a bundle-before-build tree the pointer check calls consistent');
}

// ── [5] RED: bundled, never rebuilt — dist points at a deleted asset ─
// The single-pass build. `bundle` stages the new asset and deletes the old
// one, but dist still carries the old pointer, so the Worker fetches an
// asset that is not there.
{
  const { root, pkg } = await fixtureAtFixpoint();
  writeFileSync(join(pkg, 'src', 'payload.js'), 'export const PAYLOAD = 4;\n');
  spawnSync('bun', ['run', '--cwd', 'packages/worker', 'build'], { cwd: root });
  spawnSync('bun', ['run', '--cwd', 'packages/worker', 'bundle'], { cwd: root });

  const { violations } = await checkStagedAssets({ root });
  assert.equal(violations.length, 1, `expected one pointer violation, got:\n${violations.join('\n')}`);
  assert.match(violations[0], /which is not staged under/);
  console.log('  ok  [5] catches a dist pointer aimed at an asset that is not staged');
}

// ── [6] RED: the staged asset was edited after it was staged ─────────
{
  const { root, pkg } = await fixtureAtFixpoint();
  const assetDir = join(pkg, 'public', '_assets', 'runtime');
  const [asset] = readdirSync(assetDir);
  writeFileSync(join(assetDir, asset), 'export const PAYLOAD = 99; // tampered\n');

  const { violations } = await checkStagedAssets({ root });
  assert.equal(violations.length, 1, `expected one digest violation, got:\n${violations.join('\n')}`);
  assert.match(violations[0], /hashes to .* — dist points at bytes other than the ones on disk/);
  console.log('  ok  [6] catches staged bytes that are not the ones dist digested');
}

// ── [7] RED: a hand-edited generated file ────────────────────────────
{
  const { root, pkg } = await fixtureAtFixpoint();
  const generated = join(pkg, 'dist', 'payload-artifact.generated.js');
  writeFileSync(generated, `${readFileSync(generated, 'utf8')}export const HAND_EDITED = true;\n`);

  const message = await refusal(root, 'a hand-edited generated file');
  assert.match(message, /payload-artifact\.generated\.js/);
  console.log('  ok  [7] refuses a hand-edited generated file');
}

// ── [8] RED: discovery that finds nothing must not read as a pass ────
// The failure this whole file is a reaction to is a check that looked
// green while examining nothing.
{
  const root = mkdtempSync(join(tmpdir(), 'dist-integrity-empty-'));
  process.on('exit', () => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'packages', 'worker', 'dist'), { recursive: true });
  const { verified, violations } = await checkStagedAssets({ root });
  assert.deepEqual(verified, []);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /refusing to report a pass for a check that examined nothing/);
  console.log('  ok  [8] a check that verified no asset reports a violation, not a pass');
}

// ── [9] Content, not mtime: a fresh checkout must not fail ───────────
// The guard this generalises compared mtimes and failed on every fresh
// worktree, where checkout order alone makes a generated file look older
// than its source. Touching sources into the future changes nothing here.
{
  const { root, pkg } = await fixtureAtFixpoint();
  const future = new Date(Date.now() + 60 * 60 * 1000);
  spawnSync('touch', ['-d', future.toISOString(), join(pkg, 'src', 'payload.js')]);

  const drift = rebuildDrift({ root, roots: ROOTS, steps: STEPS });
  assert.deepEqual(drift, { changed: [], added: [], removed: [] },
    'an mtime in the future is not staleness');
  console.log('  ok  [9] mtimes do not decide — a fresh checkout is not a violation');
}

// ── [10] The digest the gate reports is the file on disk ─────────────
// Guards the one line everything else trusts.
{
  const { root, pkg } = await fixtureAtFixpoint();
  const assetDir = join(pkg, 'public', '_assets', 'runtime');
  const [asset] = readdirSync(assetDir);
  const onDisk = createHash('sha256').update(readFileSync(join(assetDir, asset))).digest('hex');
  const { verified } = await checkStagedAssets({ root });
  assert.equal(verified.length, 1);
  assert.ok(verified[0].includes(onDisk.slice(0, 16)),
    `the reported digest must be the file's own, got: ${verified[0]}`);
  console.log('  ok  [10] the verified digest is the staged file\'s own sha256');
}

// ── [11] A failed build is a build failure, never drift ─────────────
// A package build starts by deleting its dist. In a worktree with no
// node_modules a global tsc without --noCheck then failed, the deletion was
// left behind, and a loop that commits what the gate rebuilt committed it,
// twice, onto a release branch. Here the build removes dist, rewrites a
// generated source and adds a file, then fails, over a tree that holds both
// committed files and uncommitted ones (src changed and rebuilt, not yet
// committed). The gate must throw BuildFailure, not a drift report, and
// leave every file, and git's view of the tree, exactly as it found them.
{
  const { root, pkg } = await fixtureAtFixpoint();
  const git = (...args) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root, encoding: 'utf8' });
  // A module whose dist stays as committed: put back from HEAD, not a copy.
  writeFileSync(join(pkg, 'src', 'static.js'), 'export const STATIC = true;\n');
  runBuildFixpoint({ root, steps: STEPS });
  git('add', '-A');
  git('commit', '-qm', 'at the fixpoint');
  // Uncommitted but consistent: src changed, and the tree rebuilt to match.
  writeFileSync(join(pkg, 'src', 'payload.js'), 'export const PAYLOAD = 2;\n');
  runBuildFixpoint({ root, steps: STEPS });
  writeFileSync(join(pkg, 'build.mjs'), `
import { rmSync, writeFileSync } from 'node:fs';
rmSync('dist', { recursive: true, force: true });
writeFileSync('src/payload-artifact.generated.js', 'half-written');
writeFileSync('src/scratch.js', 'left by the failed build');
console.error('tsc: error TS5023: Unknown compiler option --noCheck.');
process.exit(1);
`);
  const status = () => git('status', '--porcelain', '--untracked-files=all').stdout;
  const bytesBefore = snapshotBuildOutputs({ root, roots: ROOTS });
  const statusBefore = status();

  let thrown;
  try {
    await assertDistMatchesSource({ root, roots: ROOTS, steps: STEPS });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof BuildFailure, `a failed build must throw BuildFailure, got: ${thrown?.stack ?? 'no error'}`);
  assert.match(thrown.message, /^BUILD FAILED — `bun run --cwd packages\/worker build` exited 1\. This is a failed build, not drift/);
  assert.doesNotMatch(thrown.message, /did not match its source/, 'a failed build must not read as drift');
  assert.deepEqual(snapshotBuildOutputs({ root, roots: ROOTS }), bytesBefore, 'every file is as it was before the build');
  assert.equal(readFileSync(join(pkg, 'dist', 'static.js'), 'utf8'), 'export const STATIC = true;\n', 'a committed dist file is back');
  assert.match(thrown.message, /packages\/worker\/dist\/static\.js/, 'the report names what was put back');
  assert.equal(status(), statusBefore, 'git sees the tree it saw before the build');

  // rebuildDrift, which callers read drift from, throws too: there is no drift to return.
  assert.throws(() => rebuildDrift({ root, roots: ROOTS, steps: STEPS }), BuildFailure);
  assert.deepEqual(snapshotBuildOutputs({ root, roots: ROOTS }), bytesBefore);
  console.log('  ok  [11] a failed build throws BuildFailure and leaves every file as it was');
}

// ── [12] A workspace builds only with its own toolchain ──────────────
// The same tree as a bun workspace: no node_modules is refused before
// anything runs, and so is a tsc that is not the version bun.lock pins.
{
  const { root, pkg } = await fixtureAtFixpoint();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true, workspaces: ['packages/*'] }));
  writeFileSync(join(root, 'bun.lock'), '{\n  "packages": {\n    "typescript": ["typescript@5.9.3", "", {}, "sha512-x"],\n  }\n}\n');
  const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ ...manifest, devDependencies: { typescript: '^5.7.0' } }));
  const bytesBefore = snapshotBuildOutputs({ root, roots: ROOTS });
  const refused = async () => {
    try {
      await assertDistMatchesSource({ root, roots: ROOTS, steps: STEPS });
    } catch (error) {
      assert.ok(error instanceof BuildFailure, String(error?.stack));
      return error.message;
    }
    throw new assert.AssertionError({ message: 'the gate built without the workspace toolchain' });
  };
  assert.match(await refused(), /^refusing to build — .* has no node_modules/);

  // An install whose tsc is not the pinned one: a stale install, or a global stand-in.
  const ts = join(root, 'node_modules', 'typescript');
  mkdirSync(join(ts, 'bin'), { recursive: true });
  writeFileSync(join(ts, 'package.json'), JSON.stringify({ name: 'typescript', version: '5.4.5' }));
  writeFileSync(join(ts, 'bin', 'tsc'), '#!/bin/sh\nexit 1\n');
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
  symlinkSync('../typescript/bin/tsc', join(root, 'node_modules', '.bin', 'tsc'));
  assert.match(await refused(), /tsc is .* \(typescript 5\.4\.5\), but bun\.lock pins typescript 5\.9\.3/);
  assert.deepEqual(snapshotBuildOutputs({ root, roots: ROOTS }), bytesBefore, 'a refused build touches nothing');
  console.log('  ok  [12] a workspace without node_modules, or with a tsc other than the pinned one, is refused before building');
}

// ── The rollback itself can fail ─────────────────────────────────────
// A failed build is rolled back from copies held outside the tree (every
// output git cannot give back) and from HEAD. Each case below breaks one
// part of that rollback; the gate must still try every other path, throw
// BuildFailure, keep the copies, and say where they are.

const git = (root, ...args) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root, encoding: 'utf8' });

/** A fixture at its fixpoint, committed, with two uncommitted outputs the gate must hold copies of. */
async function committedFixture() {
  const { root, pkg } = await fixtureAtFixpoint();
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'at the fixpoint');
  writeFileSync(join(pkg, 'dist', 'held-a.js'), 'export const A = 1;\n');
  writeFileSync(join(pkg, 'dist', 'held-b.js'), 'export const B = 1;\n');
  return { root, pkg };
}

/** Run `fn` with recovery copies kept under a directory of this case's own. */
async function withPrivateTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dist-integrity-tmp-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
  }
}

/** The gate's error over a failing build: it must be a BuildFailure. */
async function buildFailure(root) {
  try {
    await assertDistMatchesSource({ root, roots: ROOTS, steps: STEPS });
  } catch (error) {
    assert.ok(error instanceof BuildFailure, `a failed build must throw BuildFailure, got: ${error?.stack}`);
    return error.message;
  }
  throw new assert.AssertionError({ message: 'the gate accepted a failed build' });
}

/** The recovery directory the error names, which must still be there. */
function namedRecoveryDir(message) {
  const match = /copies the build needs are kept in (\S+)/.exec(message);
  assert.ok(match, `the error must name where the recovery copies are kept:\n${message}`);
  assert.ok(existsSync(match[1]), `the named recovery directory ${match[1]} must still exist`);
  return match[1];
}

// ── [13] RED: a recovery copy is gone; the rest are still restored ───
{
  await withPrivateTmp(async (tmp) => {
    const { root, pkg } = await committedFixture();
    // The failing build removes dist, and the copy held of held-a.js.
    writeFileSync(join(pkg, 'build.mjs'), `
import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
rmSync('dist', { recursive: true, force: true });
const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});
const tmp = process.env.TMPDIR;
for (const held of readdirSync(tmp).filter((name) => name.startsWith('dist-integrity-held-'))) {
  for (const copy of walk(join(tmp, held))) {
    if (readFileSync(copy, 'utf8') === 'export const A = 1;\\n') rmSync(copy);
  }
}
process.exit(1);
`);
    const before = snapshotBuildOutputs({ root, roots: ROOTS });
    const message = await buildFailure(root);
    const after = snapshotBuildOutputs({ root, roots: ROOTS });
    const missing = [...before.keys()].filter((path) => after.get(path) !== before.get(path));
    assert.deepEqual(missing, ['packages/worker/dist/held-a.js'], 'exactly the output whose copy was lost stays missing');
    assert.match(message, /could NOT be put back/);
    assert.ok(message.includes(missing[0]), 'the error names the file it could not restore');
    assert.match(message, /ENOENT/, 'the error says why');
    const kept = namedRecoveryDir(message);
    assert.ok(kept.startsWith(tmp));
    const keptCopies = spawnSync('find', [kept, '-type', 'f'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
      .map((copy) => readFileSync(copy, 'utf8'));
    assert.ok(keptCopies.includes('export const B = 1;\n'), 'the copies that were not lost are still kept');
  });
  console.log('  ok  [13] a lost recovery copy fails one file: the rest are restored, the copies kept and named');
}

// ── [14] RED: an added file cannot be removed ────────────────────────
// Directory permissions do not bind root, so the refusal cannot be staged there.
if (process.getuid?.() === 0) {
  console.log('  ok  [14] skipped: running as root, which a read-only directory does not stop');
} else {
  await withPrivateTmp(async () => {
    const { root, pkg } = await committedFixture();
    writeFileSync(join(pkg, 'build.mjs'), `
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/locked', { recursive: true });
writeFileSync('dist/locked/out.js', 'half-written');
chmodSync('dist/locked', 0o555);
process.exit(1);
`);
    const before = snapshotBuildOutputs({ root, roots: ROOTS });
    let message;
    try {
      message = await buildFailure(root);
    } finally {
      chmodSync(join(pkg, 'dist', 'locked'), 0o755);
    }
    const after = snapshotBuildOutputs({ root, roots: ROOTS });
    for (const [path, digest] of before) assert.equal(after.get(path), digest, `${path} is restored though another file could not be removed`);
    assert.match(message, /could NOT be put back/);
    assert.match(message, /packages\/worker\/dist\/locked\/out\.js/);
    assert.match(message, /EACCES/);
    namedRecoveryDir(message);
  });
  console.log('  ok  [14] an added file that cannot be removed fails alone: every other file is restored');
}

// ── [15] RED: the copies cannot be made at all ───────────────────────
// Nothing may run then: a build with no way back is not started.
{
  const { root, pkg } = await committedFixture();
  const notADirectory = join(root, 'not-a-directory');
  writeFileSync(notADirectory, '');
  writeFileSync(join(pkg, 'build.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('../../ran', ''); process.exit(1);\n");
  const before = snapshotBuildOutputs({ root, roots: ROOTS });
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = join(notADirectory, 'tmp');
  let message;
  try {
    message = await buildFailure(root);
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
  }
  assert.match(message, /^refusing to build — could not hold copies of the build outputs/);
  assert.ok(!existsSync(join(root, 'ran')), 'no build step ran');
  assert.deepEqual(snapshotBuildOutputs({ root, roots: ROOTS }), before);
  console.log('  ok  [15] when the recovery copies cannot be made, nothing is built');
}

// ── [16] RED: permissions come back too ──────────────────────────────
// A committed output chmodded 0600 is restored from HEAD, which knows only
// 0644 and 0755. And cli's build ends in `chmod +x dist/bin.js`: a build
// that dies after tsc rewrote bin.js byte for byte but before the chmod
// changed only its mode.
{
  await withPrivateTmp(async () => {
    const { root, pkg } = await fixtureAtFixpoint();
    writeFileSync(join(pkg, 'src', 'bin.js'), '#!/usr/bin/env node\n');
    writeFileSync(join(pkg, 'build.mjs'), BUILD_MJS + "import { chmodSync as chmod } from 'node:fs';\nchmod('dist/bin.js', 0o755);\n");
    runBuildFixpoint({ root, steps: STEPS });
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'at the fixpoint, bin.js executable');
    chmodSync(join(pkg, 'dist', 'payload.js'), 0o600);
    assert.equal(git(root, 'status', '--porcelain').stdout, '', 'git does not see a 0600 mode, so nothing is held');
    // tsc wrote the outputs again; the build died before its chmod +x.
    writeFileSync(join(pkg, 'build.mjs'), BUILD_MJS + 'process.exit(1);\n');
    const message = await buildFailure(root);
    const mode = (rel) => statSync(join(pkg, rel)).mode & 0o777;
    assert.equal(mode('dist/payload.js').toString(8), '600', 'restored from HEAD, with its own mode');
    assert.equal(mode('dist/bin.js').toString(8), '755', 'a mode-only change is put back');
    assert.match(message, /The tree is as it was before the build/);
    assert.match(message, /packages\/worker\/dist\/bin\.js/);
  });
  console.log('  ok  [16] a restore puts every mode back, from HEAD or a copy, and a mode-only change too');
}

// ── [17] A narrow regeneration holds copies of its own roots only ────
// generated-freshness regenerates packages/worker/src with one step. Its
// rollback must cover what that step can write, not hold a copy of every
// build output in the workspace (dist and staged WASM included).
{
  await withPrivateTmp(async () => {
    const root = mkdtempSync(join(tmpdir(), 'dist-integrity-freshness-'));
    process.on('exit', () => rmSync(root, { recursive: true, force: true }));
    const worker = join(root, 'packages', 'worker');
    mkdirSync(join(worker, 'src'), { recursive: true });
    writeFileSync(join(worker, 'src', 'facet.generated.ts'), 'export const FACET = 1;\n');
    writeFileSync(join(worker, 'facets.mjs'), `
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const tmp = process.env.TMPDIR;
const held = readdirSync(tmp).filter((name) => name.startsWith('dist-integrity-held-'));
// The copies, not the manifest every hold writes beside them.
writeFileSync('../../held-copies', String(held.reduce((n, dir) => n + readdirSync(join(tmp, dir)).filter((name) => name !== '.dist-integrity-held.json').length, 0)));
`);
    writeFileSync(join(worker, 'package.json'), JSON.stringify({ name: 'w', type: 'module', scripts: { 'bundle:facets': 'node facets.mjs' } }));
    git(root, 'init', '-q');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'generated sources current');
    // An uncommitted build output elsewhere in the workspace.
    mkdirSync(join(root, 'packages', 'core', 'dist'), { recursive: true });
    writeFileSync(join(root, 'packages', 'core', 'dist', 'big.wasm'), 'not the regeneration\'s');
    assertGeneratedSourcesAreCurrent({ root });
    assert.equal(readFileSync(join(root, 'held-copies'), 'utf8'), '0', 'nothing under packages/worker/src needed a copy, and nothing else may be held');
  });
  console.log('  ok  [17] the generated-sources guard holds copies only of what its step can write');
}

// ── [18] RED: two gates on one checkout ──────────────────────────────
// Gate A cleans dist and is rebuilding it when gate B starts; B's build
// then fails. Unlocked, B snapshotted a tree with no dist, and its rollback
// deleted A's rebuilt dist as "added", after A had passed. With the
// checkout lock, B waits for A before its first snapshot.
{
  const { root, pkg } = await fixtureAtFixpoint();
  const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
  manifest.scripts['slow-build'] = 'node slow-build.mjs';
  manifest.scripts['fail-build'] = 'node fail-build.mjs';
  writeFileSync(join(pkg, 'package.json'), JSON.stringify(manifest));
  // Each waits, bounded, for a file the orchestrator writes.
  const waitFor = (file) => `
const until = Date.now() + 60_000;
while (!existsSync(${JSON.stringify(file)})) {
  if (Date.now() > until) { console.error('gave up waiting for ${file}'); process.exit(3); }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}`;
  writeFileSync(join(pkg, 'slow-build.mjs'), `
import { cpSync, existsSync, rmSync, writeFileSync } from 'node:fs';
rmSync('dist', { recursive: true, force: true });
writeFileSync('../../cleaned', '');
${waitFor('../../go')}
cpSync('src', 'dist', { recursive: true });
`);
  writeFileSync(join(pkg, 'fail-build.mjs'), `
import { existsSync, writeFileSync } from 'node:fs';
writeFileSync('../../b-started', '');
${waitFor('../../a-done')}
process.exit(1);
`);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'two builds');
  const atFixpoint = snapshotBuildOutputs({ root, roots: ROOTS });

  const gateModule = new URL('../../scripts/dist-integrity.mjs', import.meta.url).href;
  writeFileSync(join(root, 'gate.mjs'), `
import { assertDistMatchesSource } from ${JSON.stringify(gateModule)};
const [root, script] = process.argv.slice(2);
try {
  await assertDistMatchesSource({
    root, roots: ['packages/worker'], steps: [{ cwd: 'packages/worker', script, why: script }],
    log: (line) => console.error(line),
  });
  console.log('RESULT ok');
} catch (error) {
  console.log('RESULT ' + error.name);
  console.error(error.message);
}
`);
  const gate = (script) => {
    const child = spawn(process.execPath, [join(root, 'gate.mjs'), root, script], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    const run = { out: '', err: '', done: null };
    child.stdout.on('data', (chunk) => { run.out += chunk; });
    child.stderr.on('data', (chunk) => { run.err += chunk; });
    run.done = new Promise((resolve) => child.on('exit', resolve));
    return run;
  };
  const until = async (what, predicate) => {
    for (const deadline = Date.now() + 60_000; !predicate();) {
      if (Date.now() > deadline) throw new assert.AssertionError({ message: `timed out waiting for ${what}` });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  const a = gate('slow-build');
  await until('gate A to clean dist', () => existsSync(join(root, 'cleaned')));
  const b = gate('fail-build');
  // B either gets in (unlocked: its build starts) or reports that it waits.
  await until('gate B to start or wait', () => existsSync(join(root, 'b-started')) || /waiting for the checkout lock/.test(b.err));
  const bWaited = !existsSync(join(root, 'b-started'));
  writeFileSync(join(root, 'go'), '');
  await a.done;
  assert.match(a.out, /RESULT ok/, `gate A passes:\n${a.out}${a.err}`);
  writeFileSync(join(root, 'a-done'), '');
  await b.done;
  assert.match(b.out, /RESULT BuildFailure/, `gate B's build fails:\n${b.out}${b.err}`);
  assert.ok(bWaited, 'gate B must wait for gate A before its first snapshot');
  assert.deepEqual(snapshotBuildOutputs({ root, roots: ROOTS }), atFixpoint, "A's rebuilt dist survives B's failed build");
  console.log('  ok  [18] two gates on one checkout: the second waits, and its rollback leaves the first\'s output');
}

// ── [19] RED: the generated-sources guard rolls back core's generated modules ─
// bundle:facets writes four core runtime modules (virtual-socket-kernel,
// supervisor-answering, wasi-instance, bash-runner .generated.ts) before
// steps that can still fail; a failed regeneration must put them back.
{
  const root = mkdtempSync(join(tmpdir(), 'dist-integrity-freshness-core-'));
  process.on('exit', () => rmSync(root, { recursive: true, force: true }));
  const worker = join(root, 'packages', 'worker');
  const kernel = join(root, 'packages', 'core', 'src', 'runtime', 'virtual-socket-kernel.generated.ts');
  mkdirSync(join(worker, 'src'), { recursive: true });
  mkdirSync(join(root, 'packages', 'core', 'src', 'runtime'), { recursive: true });
  writeFileSync(kernel, 'export const KERNEL = 1;\n');
  writeFileSync(join(worker, 'package.json'), JSON.stringify({ name: 'w', type: 'module', scripts: { 'bundle:facets': 'node facets.mjs' } }));
  writeFileSync(join(worker, 'facets.mjs'), `
import { writeFileSync } from 'node:fs';
writeFileSync('../core/src/runtime/virtual-socket-kernel.generated.ts', 'half-written');
process.exit(1);
`);
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'generated sources current');
  assert.throws(() => assertGeneratedSourcesAreCurrent({ root }), BuildFailure);
  assert.equal(readFileSync(kernel, 'utf8'), 'export const KERNEL = 1;\n', "the core module the failed regeneration rewrote is put back");
  console.log('  ok  [19] a failed regeneration puts back the core modules bundle:facets rewrote');
}

// ── [20] RED: a symlink comes back a symlink ─────────────────────────
// An untracked dist symlink that clean-dist deleted must be restored as the
// same link, not as a regular file holding its target's bytes; and a link
// and the file it points at are not "the same" to the verification.
{
  await withPrivateTmp(async () => {
    const { root, pkg } = await committedFixture();
    symlinkSync('payload.js', join(pkg, 'dist', 'link.js'));
    writeFileSync(join(pkg, 'build.mjs'), BUILD_MJS + 'process.exit(1);\n');
    const before = snapshotBuildOutputs({ root, roots: ROOTS });
    assert.match(before.get('packages/worker/dist/link.js'), /^link:payload\.js:[0-9a-f]{64}$/, 'a symlink is recorded by its target and the bytes behind it');
    const message = await buildFailure(root);
    const link = join(pkg, 'dist', 'link.js');
    assert.ok(lstatSync(link).isSymbolicLink(), 'dist/link.js is a symlink again');
    assert.equal(readlinkSync(link), 'payload.js');
    assert.deepEqual(snapshotBuildOutputs({ root, roots: ROOTS }), before);
    assert.match(message, /The tree is as it was before the build/);
  });
  console.log('  ok  [20] a deleted dist symlink is restored as the same link, and verified as one');
}

// ── [21] RED: nothing is written or chmodded through a symlink ────────
// A failing build replaces a held dist file with a symlink that leads out
// of the roots. The rollback must replace the link, never write the held
// copy through it or chmod what it points at.
{
  await withPrivateTmp(async () => {
    const { root, pkg } = await committedFixture();
    const outside = join(root, 'outside.txt');
    writeFileSync(outside, 'outside the roots\n');
    chmodSync(outside, 0o600);
    writeFileSync(join(pkg, 'build.mjs'), BUILD_MJS + `
import { symlinkSync as link } from 'node:fs';
link('../../../outside.txt', 'dist/held-a.js');
process.exit(1);
`);
    const message = await buildFailure(root);
    assert.equal(readFileSync(outside, 'utf8'), 'outside the roots\n', 'the file outside the roots is untouched');
    assert.equal((statSync(outside).mode & 0o777).toString(8), '600', 'and so is its mode');
    const held = join(pkg, 'dist', 'held-a.js');
    assert.ok(lstatSync(held).isFile(), 'dist/held-a.js is a regular file again');
    assert.equal(readFileSync(held, 'utf8'), 'export const A = 1;\n');
    assert.match(message, /The tree is as it was before the build/);
  });
  console.log('  ok  [21] a symlink planted by a failed build is replaced; nothing is written or chmodded through it');
}

// ── The checkout lock is the kernel's ────────────────────────────────
// flock(2) on a file in the git dir: released when its process ends,
// however it ends, the same in every PID namespace, and held by no process
// the gate starts.

/**
 * A fixture whose one step marks that it runs, then waits (bounded) for `go`
 * beside it. Meanwhile it, and a writer it starts as Node starts esbuild's
 * service (fds 0-2 only), each write a heartbeat beside the fixture.
 */
async function blockingFixture() {
  const { root, pkg } = await fixtureAtFixpoint();
  const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
  manifest.scripts['blocking-build'] = 'node blocking-build.mjs';
  writeFileSync(join(pkg, 'package.json'), JSON.stringify(manifest));
  const beat = (file) => `setInterval(() => require('node:fs').writeFileSync(${JSON.stringify(file)}, String(Date.now())), 20);`;
  writeFileSync(join(pkg, 'blocking-build.mjs'), `
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
spawn(process.execPath, ['-e', ${JSON.stringify(beat(join(root, 'beat-writer')))}], { stdio: ['ignore', 'inherit', 'inherit'] });
setInterval(() => writeFileSync('../../beat-step', String(Date.now())), 20);
writeFileSync('../../started', '');
const until = Date.now() + 120_000;
const wait = setInterval(() => { if (existsSync('../../go') || Date.now() > until) process.exit(0); }, 20);
`);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'a blocking build');
  const gateModule = new URL('../../scripts/dist-integrity.mjs', import.meta.url).href;
  writeFileSync(join(root, 'gate.mjs'), `
import { runBuildFixpoint } from ${JSON.stringify(gateModule)};
runBuildFixpoint({ root: process.argv[2], roots: ['packages/worker'], steps: [{ cwd: 'packages/worker', script: 'blocking-build', why: 'blocks' }] });
console.log('RESULT ok');
`);
  return { root, pkg };
}

/** Whether `file` (a heartbeat) went unwritten for `ms`. */
async function stillFor(file, ms) {
  const before = readFileSync(file, 'utf8');
  await new Promise((resolve) => setTimeout(resolve, ms));
  return readFileSync(file, 'utf8') === before;
}

/** Resolve once `predicate` holds, polling; fail loudly after a minute. */
async function until(what, predicate) {
  for (const deadline = Date.now() + 60_000; !predicate();) {
    if (Date.now() > deadline) throw new assert.AssertionError({ message: `timed out waiting for ${what}` });
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The lock, taken from this process with a short wait: the BuildFailure it throws when held, or null. */
function lockRefusal(root, waitMs) {
  try {
    withCheckoutLock(root, () => {}, { waitMs });
    return null;
  } catch (error) {
    assert.ok(error instanceof BuildFailure, String(error?.stack));
    return error.message;
  }
}

// ── [22] RED: a gate killed mid-build leaves no writer, and no lock ──
// Its build step, and what the step started as Node starts esbuild's service
// (fds 0-2 only, so no lock descriptor), die with it: the step's PID
// namespace dies with the gate. Only then is the lock free, with nothing to
// break. The killed gate's held copies stay, as a dead gate's do, in this
// case's own tmpdir.
{
  await withPrivateTmp(async () => {
    const { root } = await blockingFixture();
    const gate = spawn(process.execPath, [join(root, 'gate.mjs'), root], { cwd: root, stdio: 'ignore' });
    try {
      await until('the gate to start its step and the writer', () => ['started', 'beat-step', 'beat-writer'].every((file) => existsSync(join(root, file))));
      assert.match(lockRefusal(root, 500) ?? '', /has held the checkout lock .* for longer than/, 'the running gate holds the lock');
      gate.kill('SIGKILL');
      await new Promise((resolve) => gate.on('exit', resolve));
      for (const file of ['beat-step', 'beat-writer']) {
        let still = false;
        for (const deadline = Date.now() + 10_000; !still && Date.now() < deadline;) still = await stillFor(join(root, file), 300);
        assert.ok(still, `${file}: what the killed gate's step started stops writing`);
      }
      assert.equal(lockRefusal(root, 5_000), null, 'and the next gate takes the lock: nothing to break');
    } finally {
      writeFileSync(join(root, 'go'), '');
    }
  });
  console.log('  ok  [22] a gate killed mid-build takes its step and the writer the step started with it, then the lock is free');
}

// ── [23] RED: a gate in another PID namespace is waited for, not broken ─
// A gate may run in a PID namespace of its own (bwrap --unshare-pid): a pid
// written there names nothing outside it.
{
  assert.ok(existsSync('/usr/bin/bwrap'), 'this case needs bubblewrap (the CI image has it)');
  const { root } = await blockingFixture();
  const gate = spawn('/usr/bin/bwrap', [
    '--unshare-user', '--unshare-pid', '--die-with-parent', '--bind', '/', '/', '--proc', '/proc', '--dev-bind', '/dev', '/dev',
    '--', process.execPath, join(root, 'gate.mjs'), root,
  ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  gate.stdout.on('data', (chunk) => { out += chunk; });
  gate.stderr.on('data', (chunk) => { out += chunk; });
  const done = new Promise((resolve) => gate.on('exit', resolve));
  await until('the namespaced gate to start its step', () => existsSync(join(root, 'started')));
  const refused = lockRefusal(root, 1_500);
  writeFileSync(join(root, 'go'), '');
  assert.match(refused ?? '', /has held the checkout lock .* for longer than/, 'a gate in another PID namespace holds the lock for as long as it runs');
  await done;
  assert.match(out, /RESULT ok/, `the namespaced gate finishes:\n${out}`);
  assert.equal(lockRefusal(root, 5_000), null, 'and once it ends, the lock is free');
  console.log('  ok  [23] a gate in another PID namespace holds the lock until it ends, and is never broken');
}

// ── [24] RED: new bytes behind an unchanged input symlink are a change ─
// The fixpoint record skips the rebuild when the inputs fingerprint the same.
{
  const root = mkdtempSync(join(tmpdir(), 'dist-integrity-input-link-'));
  process.on('exit', () => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'packages', 'worker', 'src'), { recursive: true });
  mkdirSync(join(root, 'shared'));
  writeFileSync(join(root, 'shared', 'real.ts'), 'export const REAL = 1;\n');
  symlinkSync('../../../shared/real.ts', join(root, 'packages', 'worker', 'src', 'linked.ts'));
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'a source symlink');
  const first = fingerprintBuildInputs({ root }).fingerprint;
  writeFileSync(join(root, 'shared', 'real.ts'), 'export const REAL = 2;\n');
  assert.notEqual(fingerprintBuildInputs({ root }).fingerprint, first, 'the build reads the new bytes, so the fingerprint moves');
  console.log('  ok  [24] new bytes behind an unchanged source symlink move the input fingerprint');
}

// ── [25] RED: what a build that dies mid-way leaves is enough to recover ─
// The copies are in place before the first step: a dirty symlink as the same
// link, and a manifest of every path's mode or link and the HEAD.
{
  await withPrivateTmp(async () => {
    const { root, pkg } = await committedFixture();
    symlinkSync('payload.js', join(pkg, 'dist', 'link.js'));
    chmodSync(join(pkg, 'dist', 'held-a.js'), 0o640);
    // What the build sees of its held copies, as a process that died now would leave them.
    writeFileSync(join(pkg, 'build.mjs'), `
import { lstatSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const tmp = process.env.TMPDIR;
const [held] = readdirSync(tmp).filter((name) => name.startsWith('dist-integrity-held-'));
const link = join(tmp, held, 'packages/worker/dist/link.js');
writeFileSync('../../held-seen.json', JSON.stringify({
  link: lstatSync(link).isSymbolicLink() ? readlinkSync(link) : null,
  manifest: JSON.parse(readFileSync(join(tmp, held, '.dist-integrity-held.json'), 'utf8')),
}));
process.exit(1);
`);
    await buildFailure(root);
    const seen = JSON.parse(readFileSync(join(root, 'held-seen.json'), 'utf8'));
    assert.equal(seen.link, 'payload.js', 'the dirty symlink is held as the same link');
    assert.equal(seen.manifest.head, git(root, 'rev-parse', 'HEAD').stdout.trim(), 'the manifest names the HEAD the other files are');
    assert.deepEqual(seen.manifest.entries['packages/worker/dist/link.js'], { link: 'payload.js' });
    assert.deepEqual(seen.manifest.entries['packages/worker/dist/held-a.js'], { mode: 0o640 });
  });
  console.log('  ok  [25] before the first step, the held copies carry dirty symlinks as links, and a manifest of every mode and link');
}

// ── [26] RED: a lock whose holder cannot be described is released, as a BuildFailure ─
// The lock file is /dev/full here, so writing the holder's description fails.
{
  const { root } = await fixtureAtFixpoint();
  const gitDir = spawnSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  const lock = join(gitDir, 'nimbus-dist-integrity.lock');
  rmSync(lock, { force: true });
  symlinkSync('/dev/full', lock);
  assert.match(lockRefusal(root, 500) ?? 'taken', /could not describe the holder/, 'the failure is a BuildFailure that says what failed');
  rmSync(lock);
  assert.equal(lockRefusal(root, 500), null, 'and this process can take the lock again');
  console.log('  ok  [26] a lock whose holder cannot be described is released, and the gate refuses as a failed build');
}

console.log('dist-integrity: all cases passed');
