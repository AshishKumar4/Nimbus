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
 *   - every published package's prepublishOnly, as
 *     `bun ../../scripts/dist-integrity.mjs --publish`, which also refuses
 *     a package directory that differs from HEAD
 *
 * A FAILED BUILD IS NOT DRIFT
 *   A package build starts by deleting its dist (clean-dist.mjs), so a step
 *   that fails leaves the tree without it. Reported as drift, or committed
 *   by whoever commits what the gate rebuilt, that deletion reached a
 *   release branch twice (a worktree with no node_modules, whose global tsc
 *   rejected --noCheck). So a build runs as a transaction: when a step
 *   fails, every file under the output roots is put back as it was before
 *   the build, and the gate throws BuildFailure (exit 2 on the CLI), never
 *   a drift report (exit 1). And in a bun workspace it refuses to build at
 *   all with any toolchain but the workspace's own: node_modules installed,
 *   and the tsc each package resolves being the lockfile's.
 *
 * ONE GATE PER CHECKOUT AT A TIME
 *   Two gates on one checkout would read each other's half-built tree: B
 *   snapshots while A has cleaned dist, and B's rollback then deletes A's
 *   rebuilt output as "added". Every entry point (the gate, rebuildDrift,
 *   runBuildFixpoint, the generated-source guard) takes the checkout lock
 *   (scripts/lib/checkout-lock.mjs: flock(2) on a file in the checkout's
 *   git dir) before its first snapshot and holds it through build,
 *   rollback and verification. A second gate waits for the first; the
 *   kernel releases the lock when its process ends, however it ends.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkoutLockFd, holdsCheckoutLock, withCheckoutLock } from './lib/checkout-lock.mjs';
import { filesUnder, trackedFileDigests } from './lib/fs-walk.mjs';
import { BuildFailure, diffSnapshots, transaction } from './lib/output-transaction.mjs';

export { BuildFailure, diffSnapshots, withCheckoutLock };

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Packages whose compiled output a deploy carries.
 *
 * Ordered, and `core` precedes `worker` for the same reason the fixpoint
 * below runs `bundle` before the final `build`: `bundle:shims` reads DIST,
 * so a worker bundled before core has compiled resolves against a dist that
 * does not exist yet — or worse, an old one.
 */
export const BUILT_PACKAGES = ['config', 'platform', 'core', 'fabric', 'loom', 'sdk', 'react', 'cli', 'worker'];

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

// ── Fixpoint record (warm cache) ───────────────────────────────────────
//
// Rebuilding every package to prove dist is the fixpoint of src costs a
// full build on every run. The record below makes the common case —
// nothing relevant changed since the last verified build — cost a
// fingerprint plus a digest walk, without weakening the gate:
//
//   - After a successful full fixpoint run (the rebuild moved nothing
//     AND the staged-asset check passed), the gate writes
//     dist-fixpoint.json at the repo root: a fingerprint of every build
//     INPUT plus the sha256 of every build OUTPUT.
//   - On the next run, if the live inputs fingerprint identically AND
//     every live output hashes identically, the tree is byte-for-byte a
//     state this gate already verified. Rebuilding would be a pure
//     function applied to unchanged inputs, so the rebuild is skipped.
//   - Any mismatch — a changed src, an edited dist, a new bun or node,
//     a missing or foreign record — falls through to the full rebuild,
//     exactly as today. `--no-cache` forces it unconditionally.
//
// Why this cannot go stale silently: the record is a tracked file, so a
// build commit includes it; a tree whose inputs or outputs differ from
// the record rebuilds (and either throws on drift or writes a fresh
// record). There is no path where the gate reports "verified" for bytes
// it did not either just build or previously verify byte-identical.
//
// INPUT_ROOTS below names every input the fixpoint build can read: each
// built package's sources and scripts, the manifests and tsconfigs that
// configure compilation, the orchestrator itself, the lockfile pinning
// the toolchain's dependencies, and the root configs the packages
// extend. A package's src also covers the generated sources the bundlers
// write back (shim artifact, runtime catalog): when a bundler
// regenerates one, the fingerprint moves and the next run rebuilds cold.
// (Kept as line comments: a block comment cannot spell a glob like
// packages/<name>/src without its star-slash closing the comment.)
//
// Deliberately NOT inputs: staged assets and dist output. Those are
// outputs — digesting them whole before and after is the invariant
// itself, and the outputs map in the record covers them.

/** Tracked file at the repo root holding the last verified fixpoint. */
export const FIXPOINT_RECORD = 'dist-fixpoint.json';

/** Format version of the record. Bump when the schema changes. */
export const FIXPOINT_RECORD_VERSION = 1;

export const INPUT_ROOTS = [
  ...BUILT_PACKAGES.map((pkg) => `packages/${pkg}/src`),
  ...BUILT_PACKAGES.map((pkg) => `packages/${pkg}/scripts`),
  'packages/worker/patches',
  ...BUILT_PACKAGES.map((pkg) => `packages/${pkg}/package.json`),
  ...BUILT_PACKAGES.map((pkg) => `packages/${pkg}/tsconfig.json`),
  'tsconfig.base.json',
  'tsconfig.json',
  'package.json',
  'bun.lock',
  'scripts/dist-integrity.mjs',
  'scripts/clean-dist.mjs',
];

/** The toolchain is an input: a new bun or node can change what the same src compiles to. */
function toolVersions() {
  let bun = 'unknown';
  let node = process.version || 'unknown';
  try {
    const r = spawnSync('bun', ['--version'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) bun = r.stdout.trim();
  } catch {
    // A missing bun fails the build below, loudly. Unknown here just
    // means this fingerprint never matches a recorded one.
  }
  try {
    const r = spawnSync('node', ['--version'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) node = r.stdout.trim();
  } catch {
    // process.version stands in.
  }
  return { bun, node };
}

/**
 * sha256 over (path, content-digest) pairs of every tracked-or-new file
 * under INPUT_ROOTS, folded with the toolchain versions. Content, never
 * mtime — same rule as the output snapshot.
 */
export function fingerprintBuildInputs({ root = REPO_ROOT } = {}) {
  const entries = [...trackedFileDigests(root, INPUT_ROOTS)];
  entries.sort(([a], [b]) => (a < b ? -1 : 1));
  const toolchain = toolVersions();
  const h = createHash('sha256');
  for (const [rel, digest] of entries) h.update(`${rel}\0${digest}\0`);
  h.update(`bun:${toolchain.bun}\0node:${toolchain.node}\0`);
  return { fingerprint: h.digest('hex'), files: entries.length, toolchain };
}

/**
 * Parse the committed record, or null when there is nothing usable: the
 * file is absent (never recorded, fresh clone without it), unreadable,
 * or written by a newer schema. Null is not an error — the caller
 * rebuilds, exactly as today.
 */
export function readFixpointRecord({ root = REPO_ROOT } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(join(root, FIXPOINT_RECORD), 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || parsed.version !== FIXPOINT_RECORD_VERSION) return null;
  if (typeof parsed.fingerprint !== 'string') return null;
  if (!parsed.outputs || typeof parsed.outputs !== 'object') return null;
  return parsed;
}

/** A progress logger that drops its line: the default for every `log` option. */
const silent = (_line) => {};

/**
 * The verified fixpoint as FIXPOINT_RECORD stores it.
 * @typedef {{ version: number, fingerprint: string, toolchain: object, roots: string[], outputs: Record<string, string> }} FixpointRecord
 */

/**
 * Is the live tree byte-for-byte a state this gate already verified?
 * The inputs must fingerprint identically (same src, scripts, configs,
 * lockfile, toolchain) AND every recorded output must hash identically
 * (nothing hand-edited, nothing added or removed). Reuses diffSnapshots
 * so "what moved" reads the same as the rebuild drift.
 */
/**
 * @param {{ root?: string, record: FixpointRecord, log?: (line: string) => void }} options
 */
export function verifyFixpointRecord({ root = REPO_ROOT, record, log = silent }) {
  const live = fingerprintBuildInputs({ root });
  if (live.fingerprint !== record.fingerprint) {
    return { ok: false, reason: 'build inputs changed since the recorded fixpoint' };
  }
  if (JSON.stringify(record.roots) !== JSON.stringify(OUTPUT_ROOTS)) {
    return { ok: false, reason: 'output root set changed since the recorded fixpoint' };
  }
  const drift = diffSnapshots(new Map(Object.entries(record.outputs)), snapshotBuildOutputs({ root }));
  const n = drift.changed.length + drift.added.length + drift.removed.length;
  if (n > 0) {
    const first = [...drift.changed, ...drift.added, ...drift.removed].slice(0, 3).join(', ');
    return { ok: false, reason: `build outputs changed since the recorded fixpoint (${n} file${n === 1 ? '' : 's'}: ${first}${n > 3 ? ', …' : ''})` };
  }
  log(`inputs (${live.files} files) and outputs match the recorded fixpoint`);
  return { ok: true };
}

/**
 * Write the record after a successful full fixpoint run. Serialized with
 * fixed key order and sorted outputs so an unchanged tree rewrites
 * byte-identical bytes. Written ONLY on the verified path — never after
 * drift, never after an asset violation.
 */
/**
 * @param {{ root?: string, fingerprint: ReturnType<typeof fingerprintBuildInputs>, outputs: Map<string, string>, log?: (line: string) => void }} options
 */
export function writeFixpointRecord({ root = REPO_ROOT, fingerprint, outputs, log = silent }) {
  const record = {
    version: FIXPOINT_RECORD_VERSION,
    fingerprint: fingerprint.fingerprint,
    toolchain: fingerprint.toolchain,
    roots: OUTPUT_ROOTS,
    outputs: Object.fromEntries([...outputs.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
  };
  writeFileSync(join(root, FIXPOINT_RECORD), `${JSON.stringify(record, null, 2)}\n`);
  log(`recorded verified fixpoint in ${FIXPOINT_RECORD} (${outputs.size} outputs, ${fingerprint.files} inputs)`);
}

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
  // A tracked file that is not on disk is left out of the map: absence is a
  // state the diff reports.
  return trackedFileDigests(root, roots);
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
  root = REPO_ROOT, roots = OUTPUT_ROOTS, steps = BUILD_FIXPOINT, log = silent,
} = {}) {
  return withCheckoutLock(root, () => {
    const before = snapshotBuildOutputs({ root, roots });
    log(`digested ${before.size} build outputs under ${roots.join(', ')}`);
    runBuildFixpoint({ root, steps, log, roots, before });
    return diffSnapshots(before, snapshotBuildOutputs({ root, roots }));
  }, { log });
}

/**
 * Run `steps` in order, as one transaction over `roots`
 * (scripts/lib/output-transaction.mjs): if a step fails, every file under
 * `roots` is put back as `before` (the snapshot taken when the build began)
 * had it, and BuildFailure is thrown.
 *
 * `roots` must cover everything `steps` can write. A `before` snapshot
 * must have been taken under the same checkout lock (withCheckoutLock).
 *
 * @param {{ root?: string, steps?: Array<{ cwd: string, script: string, why: string }>, log?: (line: string) => void,
 *   roots?: string[], before?: Map<string, string> }} [options]
 */
export function runBuildFixpoint({
  root = REPO_ROOT, steps = BUILD_FIXPOINT, log = silent, roots = OUTPUT_ROOTS, before,
} = {}) {
  if (before !== undefined && !holdsCheckoutLock(root)) {
    throw new Error('runBuildFixpoint: a `before` snapshot must be taken under withCheckoutLock, or another gate can move the tree between it and the build');
  }
  return withCheckoutLock(root, () => {
    assertWorkspaceToolchain({ root, steps });
    runSteps({ root, steps, log, roots, before: before ?? snapshotBuildOutputs({ root, roots }) });
  }, { log });
}

/** bubblewrap, which bounds a build step's processes (stepSandbox). */
const BWRAP = '/usr/bin/bwrap';

/**
 * Each build step runs as PID 1's child in a PID namespace of its own that
 * dies with this process (bwrap --unshare-pid --die-with-parent, as
 * run-bounded runs a test): when the gate dies, however it dies, the
 * namespace's init is killed and the kernel kills every process in it. So
 * nothing a step started (esbuild's service, which Node spawns with fds 0-2
 * only, among them) writes on after the checkout lock is released; the
 * lock's descriptor need only cover what cannot outlive it. The rest of
 * the system is the step's as before: the whole filesystem, the same user.
 */
function stepSandbox() {
  return [
    '--unshare-user', '--uid', String(process.getuid?.() ?? 0), '--gid', String(process.getgid?.() ?? 0), '--unshare-pid', '--die-with-parent',
    '--bind', '/', '/', '--proc', '/proc', '--dev-bind', '/dev', '/dev',
  ];
}

function runSteps({ root, steps, log, roots, before }) {
  if (!existsSync(BWRAP)) {
    throw new BuildFailure(`refusing to build — ${BWRAP} is not installed, and without it a build step could outlive the gate and write after its lock is released`);
  }
  transaction({ root, roots, before }, () => {
    for (const step of steps) {
      log(`${step.cwd} → ${step.script} (${step.why})`);
      const result = spawnSync(BWRAP, [...stepSandbox(), '--', 'bun', 'run', '--cwd', step.cwd, step.script], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, PATH: workspacePath(root, step.cwd) },
        // The checkout lock, held by the step too (scripts/lib/checkout-lock.mjs).
        stdio: ['ignore', 'pipe', 'pipe', checkoutLockFd(root)],
      });
      if (result.error || result.status !== 0) {
        process.stderr.write(result.stdout || '');
        process.stderr.write(result.stderr || '');
        const how = result.error ? `could not start (${result.error.message})`
          : result.status === null ? `was killed by ${result.signal}` : `exited ${result.status}`;
        return `\`bun run --cwd ${step.cwd} ${step.script}\` ${how}`;
      }
    }
    return null;
  });
}

/**
 * PATH for a step: the package's and the workspace's node_modules/.bin
 * ahead of everything else, as `bun run` orders them, so no other tsc on
 * the machine can stand in for the workspace's.
 */
function workspacePath(root, cwd) {
  const bins = [join(root, cwd, 'node_modules', '.bin'), join(root, 'node_modules', '.bin')];
  return [...bins, process.env.PATH ?? ''].join(delimiter);
}

/**
 * In a bun workspace, refuse to build with anything but its own toolchain:
 * node_modules must be installed, and every step's package that compiles
 * with TypeScript must resolve a tsc inside the workspace that is the
 * version bun.lock pins. A global tsc (one without --noCheck, say) or an
 * install older than the lockfile otherwise fails mid-build, or builds
 * different bytes. A tree that is not a workspace (a unit fixture) has
 * nothing to check.
 *
 * @param {{ root?: string, steps?: Array<{ cwd: string }> }} [options]
 */
export function assertWorkspaceToolchain({ root = REPO_ROOT, steps = BUILD_FIXPOINT } = {}) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch {
    return;
  }
  if (!manifest?.workspaces) return;
  const install = 'run `bun install --frozen-lockfile` at the repo root, then build again';
  if (!existsSync(join(root, 'node_modules'))) {
    throw new BuildFailure(`refusing to build — ${root} has no node_modules, so its build would run whatever tsc is on PATH; ${install}`);
  }
  let pinned = null;
  for (const cwd of new Set(steps.map((step) => step.cwd))) {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(join(root, cwd, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    if (!pkg?.devDependencies?.typescript && !pkg?.dependencies?.typescript) continue;
    pinned ??= lockedTypescript(root);
    const bin = [join(root, cwd, 'node_modules', '.bin', 'tsc'), join(root, 'node_modules', '.bin', 'tsc')].find((p) => existsSync(p));
    if (!bin) throw new BuildFailure(`refusing to build — ${cwd} compiles with tsc, and no tsc is installed in the workspace for it; ${install}`);
    const binary = realpathSync(bin);
    const inside = relative(realpathSync(root), binary);
    const installed = JSON.parse(readFileSync(join(dirname(binary), '..', 'package.json'), 'utf8')).version;
    if (inside.startsWith('..') || installed !== pinned) {
      throw new BuildFailure(
        `refusing to build — ${cwd}'s tsc is ${binary} (typescript ${installed}), but bun.lock pins typescript ${pinned}; ${install}`,
      );
    }
  }
}

/** The typescript version bun.lock resolves for the workspace. */
function lockedTypescript(root) {
  let lock = '';
  try {
    lock = readFileSync(join(root, 'bun.lock'), 'utf8');
  } catch {
    // Reported below.
  }
  const match = /^ {4}"typescript": \["typescript@([^"]+)"/m.exec(lock);
  if (!match) throw new BuildFailure(`refusing to build — ${join(root, 'bun.lock')} pins no typescript, so the workspace's tsc cannot be told from any other`);
  return match[1];
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

/** Every `.generated.js` under a package's dist, sorted. */
function generatedModules(distDir) {
  return filesUnder(distDir).filter((rel) => rel.endsWith('.generated.js')).map((rel) => join(distDir, rel)).sort();
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
 *
 * `useCache` (default true; `--no-cache` on the CLI) consults the
 * fixpoint record first: when the live inputs and outputs are
 * byte-identical to a previously verified state, the rebuild is skipped
 * and the staged-asset check runs over the recorded bytes. `--no-cache`
 * forces the rebuild — it distrusts the record, it does not stop the
 * successful rebuild from refreshing it. Anything else rebuilds exactly
 * as before. Unit fixtures pass custom roots/steps and bypass the record
 * entirely — they verify a different tree.
 */
export function assertDistMatchesSource({
  root = REPO_ROOT, roots = OUTPUT_ROOTS, steps = BUILD_FIXPOINT, log = silent, useCache = true,
} = {}) {
  // Held from before the first read of the tree through the last.
  return withCheckoutLock(root, () => verifyUnderLock({ root, roots, steps, log, useCache }), { log });
}

async function verifyUnderLock({ root, roots, steps, log, useCache }) {
  const defaultScope = roots === OUTPUT_ROOTS && steps === BUILD_FIXPOINT;
  assertWorkspaceToolchain({ root, steps });
  // An output whose source is gone would ship, and load. The record cannot
  // vouch for a file no build writes, so the cached path checks first; a
  // rebuild clears every dist (its removals are drift) and checks after.
  const refuseOrphans = () => {
    const orphans = orphanedOutputs({ root });
    if (orphans.length > 0) throw new Error(orphanReason(orphans));
  };
  if (useCache && defaultScope) {
    refuseOrphans();
    const record = readFixpointRecord({ root });
    if (record) {
      const verdict = verifyFixpointRecord({ root, record, log });
      if (verdict.ok) {
        log(`fixpoint verified from ${FIXPOINT_RECORD} — inputs and outputs unchanged, skipping rebuild`);
        const assets = await checkFixpointAssets({ root, log });
        logUncommittedOutputs({ root, log });
        return { assets, cached: true };
      }
      log(`fixpoint record stale (${verdict.reason}) — rebuilding to verify`);
    } else {
      log('no usable fixpoint record — rebuilding to verify');
    }
  }
  const drift = rebuildDrift({ root, roots, steps, log });
  if (drift.changed.length + drift.added.length + drift.removed.length > 0) {
    throw new Error(staleDistReason(drift));
  }
  log('rebuilding changed nothing — dist is the fixpoint of src');
  if (defaultScope) refuseOrphans();

  const assets = await checkFixpointAssets({ root, log });
  if (defaultScope) {
    writeFixpointRecord({
      root,
      fingerprint: fingerprintBuildInputs({ root }),
      outputs: snapshotBuildOutputs({ root, roots }),
      log,
    });
  }
  logUncommittedOutputs({ root, log });

  return { assets, cached: false };
}

/** The staged-asset half of the gate. Throws on violation; shared by both paths. */
async function checkFixpointAssets({ root = REPO_ROOT, log = silent } = {}) {
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
  return assets;
}

function logUncommittedOutputs({ root = REPO_ROOT, log = silent } = {}) {
  // Not a violation. dist is tracked, so a rebuild that legitimately
  // followed an uncommitted src change leaves output that wants
  // committing — but the deploy itself is correct, and refusing a dirty
  // worktree is how a gate gets turned off. The record is listed too: it
  // is tracked, so a build commit includes it, and an uncommitted record
  // is a fixpoint the next checkout cannot verify from.
  const uncommitted = spawnSync('git', ['status', '--porcelain', '--', ...OUTPUT_ROOTS, FIXPOINT_RECORD], {
    cwd: root, encoding: 'utf8',
  }).stdout.trim();
  if (uncommitted) {
    log('NOTE: build output differs from HEAD — dist is committed, so commit these too:');
    for (const line of uncommitted.split('\n')) log(`  ${line}`);
  }
}

/** What a package's source file may be named, for an output stem. */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx'];
/** tsc's outputs for one source, longest suffix first. */
const OUTPUT_SUFFIXES = ['.d.ts.map', '.d.mts.map', '.d.cts.map', '.js.map', '.mjs.map', '.cjs.map', '.d.ts', '.d.mts', '.d.cts', '.js', '.mjs', '.cjs'];

/**
 * Build outputs nothing in the tree produces any more, by path.
 *
 * - `packages/<pkg>/dist/**`: a compiled file whose source (same path under
 *   src/, any source extension) is gone. tsc never deletes an output, and a
 *   package's `./*.js` export would still serve the old module.
 * - `packages/worker/public/_assets`: a versioned asset (`<family>/<x.y.z>/…`
 *   or `<name>-<x.y.z>.<ext>`) that no generated artifact under
 *   packages/worker/src names: a bundle for a version the worker no longer
 *   ships.
 */
export function orphanedOutputs({ root = REPO_ROOT, packages = BUILT_PACKAGES } = {}) {
  const orphans = [];
  for (const pkg of packages) {
    const base = join(root, 'packages', pkg);
    for (const rel of filesUnder(join(base, 'dist'))) {
      const suffix = OUTPUT_SUFFIXES.find((s) => rel.endsWith(s));
      if (suffix === undefined) {
        orphans.push(`packages/${pkg}/dist/${rel}`);
        continue;
      }
      const stem = rel.slice(0, -suffix.length);
      if (!SOURCE_EXTENSIONS.some((ext) => existsSync(join(base, 'src', stem + ext)))) orphans.push(`packages/${pkg}/dist/${rel}`);
    }
  }
  const assets = join(root, STAGED_ASSETS_DIR, '_assets');
  const generatedDir = join(root, 'packages', 'worker', 'src');
  if (existsSync(assets) && existsSync(generatedDir)) {
    const named = readdirSync(generatedDir)
      .filter((name) => name.endsWith('.generated.ts'))
      .map((name) => readFileSync(join(generatedDir, name), 'utf8'))
      .join('\n');
    const versioned = /^(?:(.+?)\/(\d+\.\d+\.\d+[^/]*)\/|([^/]+?)-(\d+\.\d+\.\d+[^/]*?)\.[a-z0-9]+$)/;
    for (const rel of filesUnder(assets)) {
      const match = versioned.exec(rel);
      if (match === null) continue;
      const key = match[1] !== undefined ? `_assets/${match[1]}/${match[2]}/` : `_assets/${rel}`;
      if (!named.includes(key)) orphans.push(`${STAGED_ASSETS_DIR}/_assets/${rel}`);
    }
  }
  return orphans.sort();
}

function orphanReason(orphans) {
  return (
    'refusing — build outputs with no source in this tree (a deleted module still shipped, and importable):\n' +
    `${orphans.slice(0, 60).map((p) => `  ${p}`).join('\n')}\n` +
    (orphans.length > 60 ? `  … and ${orphans.length - 60} more\n` : '') +
    '\nEvery build clears its dist first, so `bun scripts/dist-integrity.mjs --no-cache` removes a ' +
    'compiled orphan (and reports the removal); remove a stale versioned asset by hand. Commit the removals.'
  );
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
  const useCache = !process.argv.includes('--no-cache');
  // `--publish`: a package's prepublishOnly, run from its directory. npm packs
  // that directory as it stands, so beyond the fixpoint it must hold exactly
  // what HEAD holds: a consistent but uncommitted src+dist edit would
  // otherwise ship bytes git never saw.
  try {
    const { assets, cached } = await withCheckoutLock(REPO_ROOT, async () => {
      if (process.argv.includes('--publish')) {
        const dirty = spawnSync('git', ['status', '--porcelain', '--untracked-files=all', '--', '.'], {
          encoding: 'utf8',
        });
        if (dirty.status !== 0 || dirty.stdout.trim()) {
          console.error(
            `\nrefusing to publish — ${process.cwd()} differs from HEAD:\n${dirty.stdout}${dirty.stderr}`
            + 'Commit or discard these, then publish again.\n',
          );
          process.exit(1);
        }
      }
      return assertDistMatchesSource({ log, useCache });
    }, { log });
    console.log(
      'dist-integrity OK: the build output is the fixpoint of src; ' +
      `${assets.verified.length} staged assets match what dist points at` +
      (cached ? ' (verified from fixpoint record, no rebuild)' : ''),
    );
  } catch (error) {
    console.error(`\n${error.message}\n`);
    // 2: the build did not run or did not finish (nothing to commit);
    // 1: it ran, and the tree is not its fixpoint.
    process.exit(error instanceof BuildFailure ? 2 : 1);
  }
}
