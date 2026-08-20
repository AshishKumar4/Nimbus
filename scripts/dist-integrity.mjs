#!/usr/bin/env bun
/**
 * dist-integrity — the single definition of "the bytes this deploy ships
 * were built from the source in this tree".
 *
 * WHY THIS EXISTS
 *   `packages/worker/package.json` resolves `.` to `src` under the
 *   `workspace` condition and to `dist/index.js` under `import`/`main`.
 *   Tests and local tooling therefore read SOURCE and pass, while wrangler
 *   bundles DIST and ships it. Nothing in between compares the two, and
 *   `wrangler deploy` has no opinion at all. Twice in one week that gap
 *   nearly shipped:
 *
 *     - a run of commits (7b2eae9, c2e4277, b9397d1) carried a
 *       security-relevant fix in `src` and nothing in `dist`, so deploying
 *       any of them without a rebuild ships a Worker missing a fix its own
 *       source contains;
 *     - `fix/runtime-catalog-integrity`'s committed dist predated its own
 *       last commits — no RUNTIME_CATALOG_SHA256 import, no digest
 *       chaining, `dist/runtime-catalog.generated.js` absent entirely —
 *       which would have shipped a cross-tenant trust root that existed
 *       only in src.
 *
 *   Both were caught by somebody happening to rebuild. That is the failure
 *   mode this module removes: remembering is what failed, so the check is
 *   the build.
 *
 * THE INVARIANT
 *
 *   Rebuilding must change nothing.
 *
 *   Stated with no reference to git, because it is a property of the
 *   deployable bytes and not of anybody's commit hygiene. It is verified
 *   the only way it can be verified without trusting that someone ran
 *   something: digest every file the build can write, run the build, digest
 *   them again, and refuse the deploy if anything moved.
 *
 *   That one assertion covers the whole family at once, with no model of
 *   what "should" have changed:
 *     - a committed dist older than its src  → the rebuild rewrites it;
 *     - a hand-edited generated file         → the rebuild reverts it;
 *     - the wrong build order                → `bundle:shims` reads dist,
 *       so a bundle-before-build leaves a shim artifact built from the
 *       PREVIOUS dist, and the fixpoint below rewrites it.
 *
 *   It is also immune to mtimes, which matters: the narrow guard this
 *   generalises (tests/unit/lib/generated-freshness.mjs) compared mtimes
 *   and so failed on every fresh worktree, where checkout order alone
 *   makes a generated file look older than its source. A gate that cries
 *   wolf on a fresh clone gets switched off, which is worse than no gate.
 *
 * THE ORDER
 *   `bundle:shims` compiles the ~230 KiB node-compat shim artifact by
 *   importing `dist/runtime/node-shims.js` — dist, not src — and writes
 *   back into `src`. So dist must exist before the bundlers run, and the
 *   bundlers' output must then be carried into dist. build → bundle →
 *   build is the shortest sequence that reaches a fixpoint; a single build
 *   pass hides exactly the drift this module is looking for.
 *
 * WHAT IT DOES NOT CLAIM
 *   Nothing here is about commits. A tree with uncommitted src changes
 *   deploys fine once the rebuild has caught dist up — the deployed bytes
 *   match the deployed source, which is the whole invariant. The dist
 *   delta against HEAD is reported (dist is tracked, so it wants
 *   committing) but it is not a violation, because a gate that refused
 *   every dirty worktree would be turned off within a week.
 *
 * Used by:
 *   - apps/hosted-demo/package.json  predeploy / deploy:production
 *   - apps/probe/package.json        predeploy
 *   - tests/behavioral/_throwaway-target.mjs, _staging-target.mjs
 *   - tests/unit/dist-integrity.mjs  (the mechanism, red and green)
 *   - `bun scripts/dist-integrity.mjs` (CLI)
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Packages whose compiled output a deploy carries.
 *
 * Ordered, and `core` precedes `worker` for the same reason the fixpoint
 * below runs `bundle` before the final `build`: `bundle:shims` reads DIST,
 * so a worker bundled before core has compiled resolves against a dist that
 * does not exist yet — or worse, an old one.
 */
export const BUILT_PACKAGES = ['config', 'platform', 'core', 'fabric', 'loom', 'sdk', 'worker'];

/**
 * The build, in the only order that reaches a fixpoint.
 *
 * Each step is a package script, so this list stays a description of the
 * order rather than a second copy of the build. Adding a bundler to
 * `packages/worker`'s `bundle` script needs no change here.
 */
export const BUILD_FIXPOINT = [
  ...BUILT_PACKAGES.map((pkg) => ({
    cwd: `packages/${pkg}`,
    script: 'build',
    why: 'compile src → dist',
  })),
  {
    cwd: 'packages/worker',
    script: 'bundle',
    why: 'stage assets and regenerate sources — bundle:shims reads dist',
  },
  {
    cwd: 'packages/worker',
    script: 'build',
    why: 'carry the regenerated sources into dist',
  },
];

/** Everything the build can write. Digested whole, before and after. */
export const OUTPUT_ROOTS = BUILT_PACKAGES.map((pkg) => `packages/${pkg}`);

/** Where a `/_assets/...` path resolves on disk for every deploy target. */
export const STAGED_ASSETS_DIR = join('packages', 'worker', 'public');

// ── The invariant ────────────────────────────────────────────────────

/**
 * sha256 of every file under `roots` that git would carry — tracked plus
 * untracked-and-not-ignored, so a bundler that stages a brand-new asset
 * shows up as an addition rather than going unseen.
 *
 * Content, never mtime: a fresh worktree's mtimes say nothing about what
 * its bytes are.
 */
export function snapshotBuildOutputs({ root = REPO_ROOT, roots = OUTPUT_ROOTS } = {}) {
  const listed = spawnSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...roots],
    { cwd: root, encoding: 'buffer', maxBuffer: 1 << 28 },
  );
  if (listed.status !== 0) {
    throw new Error(`git ls-files failed: ${listed.stderr?.toString() ?? listed.error?.message}`);
  }

  const digests = new Map();
  for (const rel of listed.stdout.toString('utf8').split('\0')) {
    if (!rel) continue;
    let bytes;
    try {
      bytes = readFileSync(join(root, rel));
    } catch {
      // A tracked file that is not on disk. Absence is a state the diff
      // below reports, so it belongs out of the map rather than in it.
      continue;
    }
    digests.set(rel, createHash('sha256').update(bytes).digest('hex'));
  }
  return digests;
}

/** What the build did to the tree, as three sorted path lists. */
export function diffSnapshots(before, after) {
  const changed = [];
  const added = [];
  const removed = [];
  for (const [path, digest] of after) {
    const prior = before.get(path);
    if (prior === undefined) added.push(path);
    else if (prior !== digest) changed.push(path);
  }
  for (const path of before.keys()) if (!after.has(path)) removed.push(path);
  return { changed: changed.sort(), added: added.sort(), removed: removed.sort() };
}

/**
 * Run the build and report what it moved. The whole invariant in one
 * call, and the only thing three different callers need from it: the
 * deploy gate below, the generated-source guard the unit suite uses
 * (tests/unit/lib/generated-freshness.mjs), and the tests that prove this
 * refuses. It returns the drift rather than throwing so each caller can
 * say what a change MEANS in its own terms.
 */
export function rebuildDrift({
  root = REPO_ROOT, roots = OUTPUT_ROOTS, steps = BUILD_FIXPOINT, log = () => {},
} = {}) {
  const before = snapshotBuildOutputs({ root, roots });
  log(`digested ${before.size} build outputs under ${roots.join(', ')}`);
  runBuildFixpoint({ root, steps, log });
  return diffSnapshots(before, snapshotBuildOutputs({ root, roots }));
}

export function runBuildFixpoint({ root = REPO_ROOT, steps = BUILD_FIXPOINT, log = () => {} } = {}) {
  for (const step of steps) {
    log(`${step.cwd} → ${step.script} (${step.why})`);
    const result = spawnSync('bun', ['run', '--cwd', step.cwd, step.script], {
      cwd: root,
      encoding: 'utf8',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      process.stderr.write(result.stdout || '');
      process.stderr.write(result.stderr || '');
      throw new Error(`build step \`bun run --cwd ${step.cwd} ${step.script}\` exited ${result.status}`);
    }
  }
}

// ── Staged assets ────────────────────────────────────────────────────

/**
 * Digest constants are hex, or SRI-shaped where a browser reads them.
 * Both name the same bytes.
 */
function normalizeDigest(value) {
  const hex = /^(?:sha256-)?([0-9a-f]{64})$/.exec(value);
  return hex ? hex[1] : null;
}

/** Every `.generated.js` under a package's dist, deepest first. */
function generatedModules(distDir) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.generated.js')) found.push(path);
    }
  };
  walk(distDir);
  return found.sort();
}

/** Every string under `node`, with the export name that led to it. */
function collectAssetPaths(name, node, out) {
  if (typeof node === 'string') {
    if (node.startsWith('/_assets/')) out.push({ name, path: node });
    return out;
  }
  if (Array.isArray(node)) {
    for (const value of node) collectAssetPaths(name, value, out);
    return out;
  }
  if (node && typeof node === 'object') {
    for (const value of Object.values(node)) collectAssetPaths(name, value, out);
  }
  return out;
}

/** `NODE_SHIMS_ENTRY` → `NODE_SHIMS`, so its digest constant can be found. */
function digestPrefix(exportName) {
  return exportName.replace(/_(?:ENTRY|BUNDLE_PATH|ASSET_PATH|PATH)$/, '');
}

/**
 * Does the artifact metadata dist carries still describe what is staged?
 *
 * This reads the DEPLOYABLE side of both halves — the compiled
 * `dist/**\/*.generated.js` constants and the bytes under
 * `packages/worker/public` that every deploy target serves — so it asks a
 * question the build cannot answer about itself. `bundle:shims` is the
 * reason it exists: it is the one bundler that reads dist, so a
 * bundle-before-build leaves `dist/node-shims-artifact.generated.js`
 * pointing at a build id that is not the file on disk, and the Worker
 * fetches an asset that 404s or fails its sha check deep inside a session.
 *
 * Discovery is by VALUE — any exported string that looks like an asset
 * path — rather than by a list of constants somebody has to maintain. A
 * new staged artifact is covered the moment it is named. What has no
 * digest constant to check against is reported as `unverified` rather than
 * quietly skipped: a check that silently covers less than it appears to is
 * the specific kind of hollow signal this repo has too many of.
 */
export async function checkStagedAssets({ root = REPO_ROOT } = {}) {
  const publicDir = join(root, STAGED_ASSETS_DIR);
  const verified = [];
  const unverified = [];
  const violations = [];

  for (const modulePath of generatedModules(join(root, 'packages', 'worker', 'dist'))) {
    const label = modulePath.slice(modulePath.indexOf('/dist/') + 1);
    let exports;
    try {
      exports = await import(pathToFileURL(modulePath).href);
    } catch (error) {
      violations.push(`${label} does not load: ${error.message}`);
      continue;
    }

    const paths = [];
    for (const [name, value] of Object.entries(exports)) collectAssetPaths(name, value, paths);

    for (const { name, path } of paths) {
      let bytes;
      try {
        bytes = readFileSync(join(publicDir, path.slice(1)));
      } catch {
        violations.push(
          `${label} names ${name} = ${path}, which is not staged under ${STAGED_ASSETS_DIR} — ` +
          'the deployed Worker would fetch an asset that is not there',
        );
        continue;
      }

      const prefix = digestPrefix(name);
      const declared = [`${prefix}_SHA256`, `${prefix}_INTEGRITY`]
        .map((key) => (typeof exports[key] === 'string' ? { key, digest: normalizeDigest(exports[key]) } : null))
        .find((found) => found?.digest);
      if (!declared) {
        unverified.push(`${label}: ${name} = ${path} is staged, but declares no digest to check it against`);
        continue;
      }

      const actual = createHash('sha256').update(bytes).digest('hex');
      if (actual !== declared.digest) {
        violations.push(
          `${label} declares ${declared.key} = ${declared.digest.slice(0, 16)}… but the staged ` +
          `${path} hashes to ${actual.slice(0, 16)}… — dist points at bytes other than the ones on disk`,
        );
        continue;
      }

      const buildId = exports[`${prefix}_BUILD_ID`];
      if (typeof buildId === 'string' && buildId !== actual.slice(0, buildId.length)) {
        violations.push(
          `${label} declares ${prefix}_BUILD_ID = ${buildId}, which is not a prefix of the staged ` +
          `${path}'s digest ${actual.slice(0, 16)}… — cache layers would key on the wrong build`,
        );
        continue;
      }
      verified.push(`${label}: ${name} = ${path} (sha ${actual.slice(0, 16)}…)`);
    }

    // A digest constant with no asset path beside it names bytes this check
    // cannot reach — reported so the coverage gap is visible, not inferred.
    for (const [name, value] of Object.entries(exports)) {
      if (!/_(?:SHA256|INTEGRITY)$/.test(name) || typeof value !== 'string') continue;
      const prefix = digestPrefix(name.replace(/_(?:SHA256|INTEGRITY)$/, ''));
      if (paths.some(({ name: pathName }) => digestPrefix(pathName) === prefix)) continue;
      unverified.push(`${label}: ${name} declares a digest, but no exported constant names the asset it covers`);
    }
  }

  if (verified.length === 0 && violations.length === 0) {
    violations.push(
      `no staged asset was verified: nothing under packages/worker/dist names a /_assets/ path. ` +
      'Either dist was never built, or the artifact constants moved — refusing to report a pass ' +
      'for a check that examined nothing.',
    );
  }
  return { verified: verified.sort(), unverified: unverified.sort(), violations };
}

// ── The gate ─────────────────────────────────────────────────────────

/**
 * Refuse the deploy unless the deployable bytes are the build's fixpoint.
 *
 * Every deploy path calls this INSTEAD of building, so there is no
 * separate step to skip: the gate is how the tree gets built.
 */
export async function assertDistMatchesSource({
  root = REPO_ROOT, roots = OUTPUT_ROOTS, steps = BUILD_FIXPOINT, log = () => {},
} = {}) {
  const drift = rebuildDrift({ root, roots, steps, log });
  if (drift.changed.length + drift.added.length + drift.removed.length > 0) {
    throw new Error(staleDistReason(drift));
  }
  log('rebuilding changed nothing — dist is the fixpoint of src');

  const assets = await checkStagedAssets({ root });
  for (const note of assets.verified) log(`asset ok — ${note}`);
  for (const gap of assets.unverified) log(`asset unverified — ${gap}`);
  if (assets.violations.length > 0) {
    throw new Error(
      'refusing to deploy — what dist says it staged is not what is staged:\n' +
      assets.violations.map((v) => `  - ${v}`).join('\n'),
    );
  }
  log(`staged assets verified: ${assets.verified.length} matched, ${assets.unverified.length} carry no digest`);

  // Not a violation. dist is tracked, so a rebuild that legitimately
  // followed an uncommitted src change leaves output that wants
  // committing — but the deploy itself is correct, and refusing a dirty
  // worktree is how a gate gets turned off.
  const uncommitted = spawnSync('git', ['status', '--porcelain', '--', ...OUTPUT_ROOTS], {
    cwd: root, encoding: 'utf8',
  }).stdout.trim();
  if (uncommitted) {
    log('NOTE: build output differs from HEAD — dist is committed, so commit these too:');
    for (const line of uncommitted.split('\n')) log(`  ${line}`);
  }

  return { assets };
}

function staleDistReason({ changed, added, removed }) {
  const listing = [
    ...changed.map((p) => `  M ${p}`),
    ...added.map((p) => `  + ${p}`),
    ...removed.map((p) => `  - ${p}`),
  ];
  return (
    'refusing to deploy — the committed build output did not match its source.\n\n' +
    'Rebuilding in the correct order rewrote these files, so whatever was in the tree ' +
    'when this deploy started is NOT what src compiles to. Deploying it would have shipped ' +
    'a Worker missing changes its own source contains:\n' +
    `${listing.slice(0, 40).join('\n')}\n` +
    (listing.length > 40 ? `  … and ${listing.length - 40} more\n` : '') +
    '\nThe tree has now been rebuilt, so these files are correct where they sit. ' +
    'Review the diff, commit it — dist is tracked — and deploy again.'
  );
}

// ── CLI ──────────────────────────────────────────────────────────────

if (import.meta.main) {
  const log = (message) => console.error(`[dist-integrity] ${message}`);
  try {
    const { assets } = await assertDistMatchesSource({ log });
    console.log(
      'dist-integrity OK: the build output is the fixpoint of src; ' +
      `${assets.verified.length} staged assets match what dist points at`,
    );
  } catch (error) {
    console.error(`\n${error.message}\n`);
    process.exit(1);
  }
}
