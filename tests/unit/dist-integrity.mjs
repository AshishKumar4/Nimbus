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
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertDistMatchesSource,
  checkStagedAssets,
  rebuildDrift,
  runBuildFixpoint,
} from '../../scripts/dist-integrity.mjs';

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

console.log('dist-integrity: all cases passed');
