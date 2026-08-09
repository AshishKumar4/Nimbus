#!/usr/bin/env bun
// cf-git-dependency-linkage — the Worker bundle resolves cf-git's bare
// imports (`ignore`, `diff`, `pify`, …) from packages/worker/node_modules,
// not from the copies bun nests under cf-git itself: cf-git lives at
// node_modules/.bun/<pkg>/node_modules/@ashishkumar472/cf-git, and node-style
// resolution never treats that store's own node_modules as a lookup root.
// packages/worker therefore *is* cf-git's effective dependency graph in
// production, and the entries it declares for cf-git's dependencies must stay
// within the ranges cf-git declares.
//
// They drifted once, and it took `git add` down on production: cf-git's
// GitIgnoreManager.isIgnored feeds ignore().add() the `null` that
// FileSystem.read returns for a missing .gitignore. ignore@5 skips a
// non-string pattern; ignore@7 dereferences it (`checkPattern(pattern.pattern)`)
// and throws "Cannot read properties of null (reading 'pattern')". Every repo
// without a .gitignore lost `git add`, `git status` and `git stash`.
//
// This test asserts the linkage two ways: the git operations that route
// through isIgnored must survive a repo with no .gitignore when cf-git runs
// against the module packages/worker actually supplies, and every mirrored
// range must satisfy cf-git's own.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolvePackageDir } from '../../packages/worker/scripts/resolve-package-dir.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workerDir = join(repoRoot, 'packages/worker');
const cfGitDir = resolvePackageDir('isomorphic-git', { start: workerDir });
const cfGitManifest = JSON.parse(readFileSync(join(cfGitDir, 'package.json'), 'utf8'));

// Resolution starts at a real file inside packages/worker so it walks the same
// node_modules chain the bundler walks for src/git/commands.ts.
const fromWorker = createRequire(join(workerDir, 'src/git/commands.ts'));

// ── 1. The operations that consult .gitignore, against the linked modules ──

/**
 * cf-git as the Worker bundle assembles it: bare specifiers rewritten to the
 * copies packages/worker resolves. Substituting the resolved module for the
 * specifier is precisely what the bundler does, so the imported namespace is
 * the one production runs.
 */
async function loadLinkedCfGit() {
  const original = readFileSync(fromWorker.resolve('isomorphic-git'), 'utf8');
  let relinked = 0;
  const source = original.replace(/from '([a-z0-9@][^']*)'/g, (whole, specifier) => {
    if (!Object.hasOwn(cfGitManifest.dependencies, specifier)) return whole;
    relinked++;
    return `from ${JSON.stringify(pathToFileURL(fromWorker.resolve(specifier)).href)}`;
  });
  assert.ok(relinked > 0, 'no cf-git dependency import was relinked — the probe proves nothing');

  const probe = join(cfGitDir, `.nimbus-linkage-${process.pid}-${randomUUID()}.mjs`);
  writeFileSync(probe, source);
  try {
    return await import(pathToFileURL(probe).href);
  } finally {
    rmSync(probe, { force: true });
  }
}

const git = await loadLinkedCfGit();
const fs = { promises: fsp };
const author = { name: 'nimbus', email: 'nimbus@example.com' };

/** A repository with no .gitignore anywhere — the shape that broke. */
async function freshRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'cf-git-linkage-'));
  await git.init({ fs, dir, defaultBranch: 'main' });
  writeFileSync(join(dir, 'tracked.txt'), 'contents\n');
  return dir;
}

for (const [name, run] of [
  ['add', (dir) => git.add({ fs, dir, filepath: 'tracked.txt' })],
  ['statusMatrix', (dir) => git.statusMatrix({ fs, dir })],
  ['status', (dir) => git.status({ fs, dir, filepath: 'tracked.txt' })],
  ['isIgnored', (dir) => git.isIgnored({ fs, dir, filepath: 'tracked.txt' })],
]) {
  const dir = await freshRepo();
  try {
    await run(dir);
  } catch (err) {
    assert.fail(`git.${name} failed on a repo with no .gitignore: ${err?.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The staged file has to reach a commit, not merely avoid throwing.
{
  const dir = await freshRepo();
  try {
    await git.add({ fs, dir, filepath: 'tracked.txt' });
    await git.commit({ fs, dir, message: 'initial', author });
    assert.deepEqual(await git.listFiles({ fs, dir }), ['tracked.txt']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A .gitignore present is the path that kept working throughout — it is the
// missing-file case that returns null, so keep both directions covered.
{
  const dir = await freshRepo();
  try {
    writeFileSync(join(dir, '.gitignore'), 'secret.txt\n');
    writeFileSync(join(dir, 'secret.txt'), 'shh\n');
    assert.equal(await git.isIgnored({ fs, dir, filepath: 'secret.txt' }), true);
    assert.equal(await git.isIgnored({ fs, dir, filepath: 'tracked.txt' }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 2. Every mirrored range stays inside the range cf-git declares ─────────

/**
 * cf-git pins with caret ranges and exact versions only. Anything else is a
 * form this check has never seen, so it fails rather than waving the pin
 * through unverified.
 */
function satisfies(version, range) {
  const parse = (text) => {
    const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(text);
    assert.ok(parts, `unsupported version "${text}" — teach this check the new form`);
    return parts.slice(1).map(Number);
  };
  const [vMajor, vMinor, vPatch] = parse(version);

  if (!range.startsWith('^')) {
    assert.ok(/^\d/.test(range), `unsupported range "${range}" — teach this check the new form`);
    return range === version;
  }
  const [rMajor, rMinor, rPatch] = parse(range.slice(1));
  // Caret on 0.x pins the minor; below 0.1.0 it pins the patch.
  if (rMajor !== vMajor) return false;
  if (rMajor === 0 && rMinor !== vMinor) return false;
  if (rMajor === 0 && rMinor === 0) return rPatch === vPatch;
  return vMinor > rMinor || (vMinor === rMinor && vPatch >= rPatch);
}

const workerManifest = JSON.parse(readFileSync(join(workerDir, 'package.json'), 'utf8'));
const mirrored = Object.keys(cfGitManifest.dependencies)
  .filter((dep) => Object.hasOwn(workerManifest.dependencies, dep));

assert.ok(
  mirrored.length >= 10,
  `expected packages/worker to mirror cf-git's dependency list, found ${mirrored.length}`,
);

for (const dep of mirrored) {
  const declared = cfGitManifest.dependencies[dep];
  const { version } = JSON.parse(
    readFileSync(join(resolvePackageDir(dep, { start: workerDir }), 'package.json'), 'utf8'),
  );
  assert.ok(
    satisfies(version, declared),
    `packages/worker supplies ${dep}@${version} to cf-git, which requires ${declared} ` +
      `(declared as "${workerManifest.dependencies[dep]}")`,
  );
}

console.log(`✓ cf-git dependency linkage (${mirrored.length} mirrored dependencies)`);
