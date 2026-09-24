#!/usr/bin/env bun
// The git bundle is built only from cf-git carrying exactly the tracked patch,
// and installing never writes into bun's cache.
//
// Each case lays out a throwaway repository the way bun's isolated linker
// does (a store entry under node_modules/.bun, linked from
// packages/worker/node_modules/isomorphic-git), with copies of the real
// scripts and patch, and runs the scripts there with node, as postinstall does.
//
// - bundle-git.mjs refuses a copy that is unpatched, or patched by another
//   revision of the patch (a worktree installed before the patch changed),
//   naming the store entry to remove; it bundles a patched copy.
// - patch-install-deps.mjs restores such a copy from bun's cached pristine
//   index.js and patches it, or refuses with the command when the cache has
//   none. A copy hardlinked to the cache, as bun installs it, is patched
//   without the cache file changing.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { blobId, patchImages } from '../../packages/worker/scripts/cf-git-patch.mjs';
import { resolvePackageDir } from '../../packages/worker/scripts/resolve-package-dir.mjs';

const repoRoot = resolve(import.meta.dirname, '../..');
const worker = join(repoRoot, 'packages/worker');
const patchFile = join(worker, 'patches/@ashishkumar472+cf-git+1.0.5.patch');
const installed = realpathSync(resolvePackageDir('isomorphic-git', { start: worker }));
const storeSiblings = dirname(dirname(installed));
const images = patchImages(patchFile);
const scratch = mkdtempSync(join(tmpdir(), 'nimbus-cf-git-patch-'));

// The installed copy is patched (the suite runs after install); its pristine index.js is the patch reversed.
assert.ok(blobId(join(installed, 'index.js')).startsWith(images.post), 'this checkout\'s cf-git is not patched');
const pristineDir = join(scratch, 'pristine');
mkdirSync(pristineDir);
cpSync(join(installed, 'index.js'), join(pristineDir, 'index.js'));
const reversed = spawnSync('git', ['apply', '--no-index', '--unidiff-zero', '--reverse', patchFile], {
  cwd: pristineDir, encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: scratch },
});
assert.equal(reversed.status, 0, reversed.stderr);
const pristine = readFileSync(join(pristineDir, 'index.js'));
const patched = readFileSync(join(installed, 'index.js'));
assert.ok(blobId(join(pristineDir, 'index.js')).startsWith(images.pre));
// Another revision of the patch: the current one with one more change.
const foreign = Buffer.concat([patched, Buffer.from('// an older revision of the patch\n')]);

let cases = 0;
/** A throwaway repository whose cf-git index.js holds `index` (or is a hardlink to `linkTo`). */
function layout(name, { index, linkTo }) {
  const root = join(scratch, name);
  const scripts = join(root, 'packages/worker/scripts');
  mkdirSync(scripts, { recursive: true });
  for (const script of ['bundle-git.mjs', 'cf-git-patch.mjs', 'resolve-package-dir.mjs', 'patch-install-deps.mjs']) {
    cpSync(join(worker, 'scripts', script), join(scripts, script));
  }
  mkdirSync(join(root, 'packages/worker/patches'));
  cpSync(patchFile, join(root, 'packages/worker/patches/@ashishkumar472+cf-git+1.0.5.patch'));
  mkdirSync(join(root, 'packages/worker/src'));
  const siblings = join(root, 'node_modules/.bun/@ashishkumar472+cf-git@1.0.5/node_modules');
  const copy = join(siblings, '@ashishkumar472/cf-git');
  mkdirSync(copy, { recursive: true });
  for (const entry of readdirSync(installed)) {
    if (entry !== 'index.js') cpSync(join(installed, entry), join(copy, entry), { recursive: true });
  }
  if (linkTo) linkSync(linkTo, join(copy, 'index.js'));
  else writeFileSync(join(copy, 'index.js'), index);
  // cf-git's own dependencies, as the store entry's siblings.
  for (const dep of readdirSync(storeSiblings)) {
    if (dep !== '@ashishkumar472') symlinkSync(join(storeSiblings, dep), join(siblings, dep));
  }
  symlinkSync(realpathSync(join(repoRoot, 'node_modules/esbuild')), join(root, 'node_modules/esbuild'));
  mkdirSync(join(root, 'packages/worker/node_modules'));
  symlinkSync(copy, join(root, 'packages/worker/node_modules/isomorphic-git'));
  return { root, copy, entry: dirname(siblings), generated: join(root, 'packages/worker/src/git-bundle.generated.ts') };
}

function run(root, script, env = {}) {
  const r = spawnSync('node', [join(root, 'packages/worker/scripts', script)], {
    cwd: root, encoding: 'utf8', env: { ...process.env, ...env },
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

/** A bun cache directory holding cf-git 1.0.5 with `index`. */
function cache(name, index) {
  const dir = join(scratch, name);
  mkdirSync(join(dir, '@ashishkumar472/cf-git@1.0.5@@@1'), { recursive: true });
  writeFileSync(join(dir, '@ashishkumar472/cf-git@1.0.5@@@1/index.js'), index);
  return { dir, index: join(dir, '@ashishkumar472/cf-git@1.0.5@@@1/index.js') };
}

try {
  // ── bundle-git.mjs builds only from the tracked patch ──
  for (const [state, index] of [['pristine', pristine], ['foreign', foreign]]) {
    const repo = layout(`bundle-${state}`, { index });
    const r = run(repo.root, 'bundle-git.mjs');
    assert.notEqual(r.code, 0, `bundle-git bundled a ${state} cf-git: ${r.out}`);
    assert.ok(r.out.includes(`${repo.copy}: ${state}`), r.out);
    assert.ok(r.out.includes(`fix: rm -rf '${repo.entry}' && (cd '${repo.root}' && bun install)`), r.out);
    assert.equal(existsSync(repo.generated), false, `a ${state} cf-git reached the generated bundle`);
    cases++;
  }
  const good = layout('bundle-patched', { index: patched });
  const built = run(good.root, 'bundle-git.mjs');
  assert.equal(built.code, 0, built.out);
  assert.match(readFileSync(good.generated, 'utf8'), /export const GIT_BUNDLE_CODE/);
  cases++;

  // ── patch-install-deps.mjs: a copy hardlinked to bun's cache, as bun installs it ──
  const linkedCache = cache('cache-linked', pristine);
  const linked = layout('install-linked', { linkTo: linkedCache.index });
  assert.equal(statSync(linkedCache.index).nlink, 2);
  const patchedLinked = run(linked.root, 'patch-install-deps.mjs', { BUN_INSTALL_CACHE_DIR: linkedCache.dir });
  assert.equal(patchedLinked.code, 0, patchedLinked.out);
  assert.ok(blobId(join(linked.copy, 'index.js')).startsWith(images.post), 'the hardlinked copy was not patched');
  assert.ok(blobId(linkedCache.index).startsWith(images.pre), 'patching wrote through the hardlink into bun\'s cache');
  assert.notEqual(statSync(join(linked.copy, 'index.js')).ino, statSync(linkedCache.index).ino);
  cases++;

  // ── a copy patched by another revision is restored from the cache, then patched ──
  const restoreCache = cache('cache-restore', pristine);
  const stale = layout('install-foreign', { index: foreign });
  const restored = run(stale.root, 'patch-install-deps.mjs', { BUN_INSTALL_CACHE_DIR: restoreCache.dir });
  assert.equal(restored.code, 0, restored.out);
  assert.ok(blobId(join(stale.copy, 'index.js')).startsWith(images.post), 'the foreign copy was not brought to the tracked patch');
  assert.ok(blobId(restoreCache.index).startsWith(images.pre), 'the restore changed bun\'s cache');
  assert.notEqual(statSync(join(stale.copy, 'index.js')).ino, statSync(restoreCache.index).ino, 'the restore linked the cache file');
  assert.equal(run(stale.root, 'bundle-git.mjs').code, 0, 'a restored copy still refused to bundle');
  cases++;

  // ── with no pristine copy in the cache it refuses, naming the command ──
  const emptyCache = join(scratch, 'cache-empty');
  mkdirSync(emptyCache);
  const stranded = layout('install-no-cache', { index: foreign });
  const refused = run(stranded.root, 'patch-install-deps.mjs', { BUN_INSTALL_CACHE_DIR: emptyCache });
  assert.notEqual(refused.code, 0, refused.out);
  assert.ok(refused.out.includes(`rm -rf '${stranded.entry}' && (cd '${stranded.root}' && bun install)`), refused.out);
  assert.equal(readFileSync(join(stranded.copy, 'index.js')).equals(foreign), true, 'a refusal changed the copy');
  cases++;

  console.log(`cf-git-patch-state: ${cases} cases; bundles only from index.js ${images.post}, never writes bun's cache`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
