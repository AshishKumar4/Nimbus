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
// (and the same code, since the sides' lockfiles must match). A guard records
// every module an arm's code resolves, and the bench fails if one lies outside
// that arm's tree and the store (assertArmsInside).
import assert from 'node:assert/strict';
import {
  copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
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
  guarded.add(realpathSync(tree) + sep);
  store ??= realpathSync(join(harness, 'node_modules', '.bun')) + sep;
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

/** Every arm tree's realpath (with a trailing separator), and the harness's third-party store's. */
const guarded = new Set();
let store = null;
/** What an arm's code imported: [specifier, importer, resolved path or null when only the specifier is known]. */
const edges = [];
/** While the guard resolves recorded edges itself: Bun's resolver runs the resolve hook for those too. */
let checking = false;

/** The arm tree `path` lies in, if any. */
const armOf = (path) => [...guarded].find((tree) => path.startsWith(tree) || path + sep === tree);

if (typeof Bun !== 'undefined') {
  // Bun's resolve hook cannot ask for the resolution it would make: the edge is resolved when checked.
  Bun.plugin({
    name: 'paired-arm-guard',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (!checking && args.importer && armOf(args.importer)) edges.push([args.path, args.importer, null]);
        return undefined;
      });
    },
  });
} else {
  nodeModule.registerHooks({
    resolve(specifier, context, next) {
      const result = next(specifier, context);
      if (context.parentURL?.startsWith('file:') && result.url.startsWith('file:')) {
        const importer = fileURLToPath(context.parentURL);
        if (armOf(importer)) edges.push([specifier, importer, fileURLToPath(result.url)]);
      }
      return result;
    },
  });
}

/** The file a recorded edge resolved to (realpath), or null for a builtin. */
function resolved([specifier, importer, path]) {
  if (path !== null) return realpathSync(path);
  if (/^(node|bun):/.test(specifier)) return null;
  // Resolved from the importer's directory (Bun names a module's importer by its file or, in some versions, its directory).
  const at = Bun.resolveSync(specifier, statSync(importer).isDirectory() ? importer : dirname(importer));
  return at.startsWith('/') ? realpathSync(at) : null;
}

/**
 * Throws, naming each, when some module an arm's code resolved lies outside
 * that arm's tree and the harness's third-party store.
 */
export function assertArmsInside() {
  const outside = [];
  checking = true;
  try {
    for (const edge of edges.splice(0)) {
      const at = resolved(edge);
      if (at === null) continue;
      const tree = armOf(realpathSync(edge[1]));
      if (at.startsWith(tree) || (store !== null && at.startsWith(store))) continue;
      outside.push(`${edge[1]} imports ${edge[0]}, which resolves to ${at}, outside its arm's tree ${tree}`);
    }
  } finally {
    checking = false;
  }
  assert.deepEqual(outside, [], 'every module of an arm resolves inside its own tree');
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
    .filter((at) => !at.startsWith(own) && !(store !== null && at.startsWith(store)));
  assert.deepEqual(outside, [], `every input of a bundle of ${tree} lies inside it`);
}

/**
 * An arm's code bundled on its own (esbuild, `options` run in `tree`, the
 * arm's tree), so no arm shares a module, or its JIT state, with another:
 * every input checked to lie inside the tree (assertBundleInside), the bundle
 * written to `file` and imported.
 */
export async function importBundle(tree, options, file) {
  const { build } = await import('esbuild');
  const workingDir = options.absWorkingDir ?? tree;
  const bundled = await build({ ...options, absWorkingDir: workingDir, bundle: true, write: false, metafile: true });
  assertBundleInside(tree, bundled.metafile, workingDir);
  writeFileSync(file, bundled.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}

/**
 * `modules` (paths under `sources.source`, the package source they are
 * measured from) and `helpers` (paths from the tree's root: the test
 * harnesses a bench drives them with) of one arm: its tree of `root`
 * (armTree), each imported from it, checked to resolve only inside it.
 */
export async function loadIsolatedCore(root, cleanup, { sources, modules, helpers = [], harness }) {
  const tree = armTree(root, cleanup, { harness });
  const files = [...modules.map((path) => [path, join(tree, sources.source, path)]), ...helpers.map((path) => [path, join(tree, path)])];
  const loaded = Object.fromEntries(await Promise.all(files.map(async ([path, file]) => [path, await import(pathToFileURL(file).href)])));
  assertArmsInside();
  return loaded;
}
