// Each arm of a paired bench runs its side's whole code: its own copy of the
// side's tree (the repository at that side's commit), every module of it
// resolved inside that copy. Nothing of one side is the other's by accident,
// whatever a change touches: no hand-kept list of the modules a bench uses.
//
// An arm's tree is the side's files, hard-linked (each path its own module,
// so no arm shares a module, or its JIT state, with another arm or with the
// harness), with the harness's installed node_modules laid over it: a
// workspace package resolves to the arm's own copy (the install's links are
// relative), a third-party one to the harness's store, the same for every arm
// (and the same code, since the sides' lockfiles must match). The process
// loads no workspace package code of the harness's at all; while an arm is
// made, only that arm's modules (and the store's); and once the first arm is
// made, nothing but arms' modules and the store's (under node, which names an
// import's importer, each arm only its own). A guard watches every module
// the process loads (Bun's module registry, node's resolve hook), whoever
// loads it and however (an import, a require, a lazy import from a bundle, a
// third-party module's own), and the bench fails on one that breaks any of
// these (assertArmsInside).
import assert from 'node:assert/strict';
import {
  copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import * as nodeModule from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The harness: the repository this bench runs from, whose install every arm shares for third-party code. */
export const repository = resolve(fileURLToPath(new URL('../../../', import.meta.url)));

/**
 * A private copy of `root` (a side's tree) for one arm, removed by `cleanup`:
 * its files hard-linked (copied across filesystems), but no install and no
 * dot-directory (git's, build caches, a baseline's tree laid inside the
 * harness), then the harness's node_modules laid over it (linkInstall).
 * Throws when the side's lockfile is not the harness's: its third-party code
 * would be the harness's.
 */
export function armTree(root, cleanup, { harness = repository } = {}) {
  const side = resolve(root);
  const lock = (at) => (existsSync(join(at, 'bun.lock')) ? readFileSync(join(at, 'bun.lock'), 'utf8') : null);
  assert.equal(lock(side), lock(harness), `${side}: its bun.lock is not the harness's, so its third-party code would be the harness's; a paired bench needs both sides on one lockfile`);
  const tree = mkdtempSync(join(tmpdir(), 'nimbus-arm-'));
  cleanup(() => rmSync(tree, { recursive: true, force: true }));
  const copy = (from, to) => {
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      if (entry.isDirectory() && (entry.name === 'node_modules' || entry.name.startsWith('.'))) continue;
      const source = join(from, entry.name);
      const target = join(to, entry.name);
      if (entry.isDirectory()) {
        mkdirSync(target);
        copy(source, target);
      } else if (entry.isSymbolicLink()) {
        symlinkSync(readlinkSync(source), target);
      } else if (entry.isFile()) {
        try {
          linkSync(source, target);
        } catch (error) {
          if (error?.code !== 'EXDEV') throw error;
          copyFileSync(source, target);
        }
      }
    }
  };
  copy(side, tree);
  linkInstall(tree, harness);
  watch(harness, tree);
  return tree;
}

/**
 * The harness's node_modules directories (its root's and each workspace
 * package's), laid over `tree` as they are: their links as written (a
 * workspace package's are relative, so they lead into `tree`), the root's
 * store (.bun) linked to the harness's. Binaries are left out.
 */
function linkInstall(tree, harness) {
  const lay = (from, to) => {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      if (entry.name === '.bin') continue;
      const source = join(from, entry.name);
      const target = join(to, entry.name);
      if (entry.name === '.bun' && from === join(harness, 'node_modules')) symlinkSync(realpathSync(source), target);
      else if (entry.isSymbolicLink()) symlinkSync(readlinkSync(source), target);
      else if (entry.isDirectory() && entry.name.startsWith('@')) lay(source, target);
    }
  };
  const installs = [join(harness, 'node_modules')];
  for (const group of ['packages', 'apps']) {
    if (!existsSync(join(harness, group))) continue;
    for (const name of readdirSync(join(harness, group))) {
      const at = join(harness, group, name, 'node_modules');
      if (existsSync(at)) installs.push(at);
    }
  }
  for (const install of installs) {
    const owner = relative(harness, dirname(install));
    // A workspace package the side does not have has nothing to resolve from.
    if (owner !== '' && !existsSync(join(tree, owner))) continue;
    lay(install, join(tree, owner, 'node_modules'));
  }
}

/**
 * Under node: each module resolution the process made from this module's
 * loading on, [the importer's file or null, the file it resolved to].
 */
const resolutions = [];
if (typeof Bun === 'undefined') {
  nodeModule.registerHooks({
    resolve(specifier, context, next) {
      const result = next(specifier, context);
      if (result.url.startsWith('file:')) {
        resolutions.push([context.parentURL?.startsWith('file:') ? fileURLToPath(context.parentURL) : null, fileURLToPath(result.url)]);
      }
      return result;
    },
  });
}

/**
 * What the guard watches from the first arm on: the harness repository's
 * root and its third-party store (realpaths, with a trailing separator), and
 * where the modules loaded before that end (mark).
 */
let watched = null;
/** Every arm's tree (a realpath, with a trailing separator). */
const trees = new Set();
/** Each bundle emitted for an arm (importBundle): its file's realpath, and the arm's tree. */
const bundles = new Map();
/** Each module the guard has already named in an offence (it names one once). */
const reported = new Set();

function watch(harness, tree) {
  const root = realpathSync(harness) + sep;
  if (watched === null) {
    watched = { root, store: realpathSync(join(harness, 'node_modules', '.bun')) + sep, before: mark() };
  }
  assert.equal(watched.root, root, 'one harness per process');
  trees.add(realpathSync(tree) + sep);
}

/** Where the modules loaded so far end: Bun's registry (require.cache holds every module of any kind loaded), node's resolutions. */
function mark() {
  return typeof Bun === 'undefined' ? resolutions.length : new Set(Object.keys(require.cache));
}

const real = (path) => (existsSync(path) ? realpathSync(path) : path);

/** Each module loaded since `from` (a mark): [the importer's file, or null where it is not known, the module's file], realpaths. */
function loadedSince(from) {
  if (typeof Bun === 'undefined') return resolutions.slice(from).map(([parent, path]) => [parent === null ? null : real(parent), real(path)]);
  return Object.keys(require.cache).filter((path) => path.startsWith('/') && !from.has(path)).map((path) => [null, real(path)]);
}

/** The arm tree `path` belongs to (its own, or one whose bundle it is), or null. */
function ownerOf(path) {
  return bundles.get(path) ?? [...trees].find((tree) => path.startsWith(tree)) ?? null;
}

/** The third-party store of this repository's own install: the bench tooling's (esbuild), the same as the harness's when it is this repository. */
const toolStore = existsSync(join(repository, 'node_modules', '.bun')) ? realpathSync(join(repository, 'node_modules', '.bun')) + sep : null;

/** Third-party code: the harness's store, or the bench tooling's. */
const inStore = (path) => (watched !== null && path.startsWith(watched.store)) || (toolStore !== null && path.startsWith(toolStore));

/** Throws, naming each offence (`found`: [the module's path, what it did]) whose module it has not named before. */
function offences(found, what) {
  const fresh = [];
  for (const [path, text] of found) {
    if (reported.has(path)) continue;
    reported.add(path);
    fresh.push(text);
  }
  assert.deepEqual(fresh, [], what);
}

/**
 * Throws, naming each, when a module loaded since `from` (a mark) while one
 * arm (`tree`) was being made lies outside that arm's tree and bundles and
 * the harness's store: it would be shared with another arm, or the harness.
 */
function assertOwnLoads(tree, from) {
  const own = realpathSync(tree) + sep;
  offences(loadedSince(from).filter(([, path]) => ownerOf(path) !== own && !inStore(path)).map(([, path]) => [path, `${path}, loaded while making the arm ${own}`]),
    "while an arm is made, it loads only its own tree's modules and the harness's third-party store");
}

/**
 * Throws, naming each it has not named before, when the process has loaded
 * workspace package code of the harness repository's (its packages/) at any
 * time; since the first arm was made, any module outside every arm's tree
 * and bundles and the harness's third-party store (the harness's own, an
 * unrelated checkout's); or (under node, which names each import's importer)
 * a module an arm's code imported from outside its own tree and bundles and
 * the store (another arm's).
 */
export function assertArmsInside() {
  if (watched === null) return;
  const packages = `${watched.root}packages${sep}`;
  const ever = typeof Bun === 'undefined' ? loadedSince(0) : Object.keys(require.cache).filter((path) => path.startsWith('/')).map((path) => [null, real(path)]);
  const since = loadedSince(watched.before);
  offences([
    ...ever.filter(([, path]) => path.startsWith(packages) && !inStore(path)).map(([, path]) => [path, path]),
    ...since.filter(([, path]) => ownerOf(path) === null && !inStore(path)).map(([, path]) => [path, path]),
    ...since.filter(([parent, path]) => {
      const owner = parent === null ? null : ownerOf(parent);
      return owner !== null && ownerOf(path) !== owner && !inStore(path);
    }).map(([parent, path]) => [path, `${path}, imported by ${parent}, another arm's`]),
  ], "a bench loads no workspace package code of the harness's, and once its arms are made, nothing but its arms' own modules (each arm its own) and the harness's third-party store, none of the harness repository's");
}

/**
 * Throws, naming each, when some input of an esbuild bundle of `tree`'s code
 * (`metafile`, its inputs relative to `workingDir`) lies outside that tree
 * and the harness's third-party store.
 */
export function assertBundleInside(tree, metafile, workingDir) {
  const own = realpathSync(tree) + sep;
  const outside = Object.keys(metafile.inputs)
    // Not a file: esbuild's stdin (named or not), or another namespace's.
    .filter((input) => !input.startsWith('<') && !input.includes(':') && existsSync(resolve(workingDir, input)))
    .map((input) => realpathSync(resolve(workingDir, input)))
    .filter((at) => !at.startsWith(own) && !inStore(at));
  assert.deepEqual(outside, [], `every input of a bundle of ${tree} lies inside it`);
}

/**
 * An arm's code bundled on its own (esbuild, `options` run in `tree`, the
 * arm's tree), so no arm shares a module, or its JIT state, with another:
 * every input checked to lie inside the tree (assertBundleInside), the bundle
 * written to `file`, owned by the arm, and imported, what that loads checked
 * to be the arm's. What it loads later, a lazy import, the guard watches
 * (assertArmsInside).
 */
export async function importBundle(tree, options, file) {
  const { build } = await import('esbuild');
  const workingDir = options.absWorkingDir ?? tree;
  const bundled = await build({ ...options, absWorkingDir: workingDir, bundle: true, write: false, metafile: true });
  assertBundleInside(tree, bundled.metafile, workingDir);
  writeFileSync(file, bundled.outputFiles[0].text);
  bundles.set(realpathSync(file), realpathSync(tree) + sep);
  const from = mark();
  const loaded = await import(pathToFileURL(file).href);
  assertOwnLoads(tree, from);
  return loaded;
}

/**
 * The modules at `paths` (from the root of `tree`, an arm's tree) imported
 * together, what that loads checked to be the arm's own (or the harness's
 * third-party store).
 */
export async function armImports(tree, paths) {
  const from = mark();
  const loaded = await Promise.all(paths.map((path) => import(pathToFileURL(join(tree, path)).href)));
  assertOwnLoads(tree, from);
  assertArmsInside();
  return loaded;
}

/**
 * `modules` (paths under `sources.source`, the package source they are
 * measured from) and `helpers` (paths from the tree's root: the test
 * harnesses a bench drives them with) of one arm: its tree of `root`
 * (armTree), each imported from it, checked to be the arm's own.
 */
export async function loadIsolatedCore(root, cleanup, { sources, modules, helpers = [], harness }) {
  const tree = armTree(root, cleanup, { harness });
  const paths = [...modules.map((path) => [path, join(sources.source, path)]), ...helpers.map((path) => [path, path])];
  const loaded = await armImports(tree, paths.map(([, path]) => path));
  return Object.fromEntries(paths.map(([path], index) => [path, loaded[index]]));
}
