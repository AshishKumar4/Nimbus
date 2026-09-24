/**
 * The installed cf-git copies and whether each carries the tracked patch.
 *
 * `packages/worker/patches/@ashishkumar472+cf-git+1.0.5.patch` rewrites one
 * file, `index.js`. Its `index <pre>..<post>` header names the git blob ids of
 * that file before and after the patch, so a copy's state is exact: its
 * index.js hashes to <post> (patched), to <pre> (pristine), or to neither
 * (foreign: an older or newer revision of the patch, or a hand edit).
 *
 * patch-install-deps.mjs brings every copy to <post>; bundle-git.mjs refuses to
 * bundle a copy that is not at <post>, so a store patched by an older revision
 * can never regenerate the git bundle without the current fixes.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const CF_GIT_PATCH = resolve(__dirname, '..', 'patches', '@ashishkumar472+cf-git+1.0.5.patch');
/** Where bun's cache keeps the pristine package, below the cache directory. */
const CACHE_ENTRY = join('@ashishkumar472', 'cf-git@1.0.5@@@1');

/** The patch's pre- and post-image blob ids (abbreviated, as git writes them). */
export function patchImages(patch = CF_GIT_PATCH) {
  if (!existsSync(patch)) throw new Error(`Missing tracked cf-git patch: ${patch}`);
  const text = readFileSync(patch, 'utf8');
  if ((text.match(/^diff --git /gm) ?? []).length !== 1 || !/^diff --git a\/index\.js b\/index\.js$/m.test(text)) {
    throw new Error(`${patch}: expected a patch of index.js alone`);
  }
  const header = /^index ([0-9a-f]{7,40})\.\.([0-9a-f]{7,40})(?: \d+)?$/m.exec(text);
  if (!header) throw new Error(`${patch}: no 'index <pre>..<post>' header to verify an install against`);
  return { pre: header[1], post: header[2] };
}

/** `git hash-object` of a file. */
export function blobId(file) {
  const bytes = readFileSync(file);
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** 'patched' | 'pristine' | 'foreign' | 'missing', by index.js's blob id. */
export function cfGitState(dir, images = patchImages()) {
  const file = join(dir, 'index.js');
  if (!existsSync(file)) return 'missing';
  const id = blobId(file);
  if (id.startsWith(images.post)) return 'patched';
  if (id.startsWith(images.pre)) return 'pristine';
  return 'foreign';
}

/** node_modules trees at the repo root and one level into packages/* and apps/*. */
export function findNodeModules(base, depth = 0) {
  if (depth > 5 || !existsSync(base)) return [];
  const out = [];
  let entries;
  try { entries = readdirSync(base, { withFileTypes: true }); }
  catch { return []; }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name === 'node_modules') {
      out.push(join(base, ent.name));
    } else if (ent.name === 'packages' || ent.name === 'apps') {
      for (const sub of readdirSync(join(base, ent.name), { withFileTypes: true })) {
        if (sub.isDirectory()) out.push(...findNodeModules(join(base, ent.name, sub.name), depth + 1));
      }
    }
  }
  return out;
}

/** Real directories of every installed @ashishkumar472/cf-git@1.0.5, however bun laid it out. */
export function findCfGitDirs(repoRoot) {
  const dirs = new Set();
  for (const nm of findNodeModules(repoRoot)) {
    for (const packagePath of [
      join(nm, 'isomorphic-git', 'package.json'),
      join(nm, '@ashishkumar472', 'cf-git', 'package.json'),
      join(nm, '.bun', '@ashishkumar472+cf-git@1.0.5', 'node_modules', '@ashishkumar472', 'cf-git', 'package.json'),
    ]) {
      if (!existsSync(packagePath)) continue;
      const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
      if (pkg.name === '@ashishkumar472/cf-git' && pkg.version === '1.0.5') dirs.add(realpathSync(dirname(packagePath)));
    }
  }
  return dirs;
}

/** What to delete so `bun install` lays the copy out again: its store entry, else the package itself. */
export function storeEntry(dir) {
  const marker = `${sep}node_modules${sep}.bun${sep}`;
  const at = dir.lastIndexOf(marker);
  if (at < 0) return dir;
  return dir.slice(0, at + marker.length) + dir.slice(at + marker.length).split(sep)[0];
}

/** The command that reinstalls `dir` from bun's cache, for a refusal to name. */
export function reinstallCommand(dir, repoRoot) {
  return `rm -rf '${storeEntry(dir)}' && (cd '${repoRoot}' && bun install)`;
}

/**
 * Throw unless every installed copy carries exactly the tracked patch. `extra`
 * names a copy found another way (the one a bundler resolves), checked too.
 */
export function assertCfGitPatched(repoRoot, extra = []) {
  const images = patchImages();
  const dirs = findCfGitDirs(repoRoot);
  for (const dir of extra) dirs.add(realpathSync(dir));
  if (dirs.size === 0) throw new Error('No @ashishkumar472/cf-git@1.0.5 installation found');
  const wrong = [...dirs].map((dir) => [dir, cfGitState(dir, images)]).filter(([, state]) => state !== 'patched');
  if (wrong.length === 0) return dirs;
  throw new Error(
    'cf-git is not patched with the tracked patch (packages/worker/patches/@ashishkumar472+cf-git+1.0.5.patch, '
      + `index.js ${images.pre}..${images.post}), so a bundle built now would lack its fixes:\n`
      + wrong.map(([dir, state]) => `  ${dir}: ${state}\n    fix: ${reinstallCommand(dir, repoRoot)}`).join('\n'),
  );
}

/** bun's cache directory: $BUN_INSTALL_CACHE_DIR, else what `bun pm cache` reports, else bun's default. */
function bunCacheDir() {
  if (process.env.BUN_INSTALL_CACHE_DIR) return process.env.BUN_INSTALL_CACHE_DIR;
  const reported = spawnSync('bun', ['pm', 'cache'], { encoding: 'utf8' });
  if (reported.status === 0 && reported.stdout.trim()) return reported.stdout.trim();
  return join(process.env.BUN_INSTALL || join(homedir(), '.bun'), 'install', 'cache');
}

/** bun's cached, unpatched index.js for cf-git 1.0.5, or null when the cache holds no pristine copy. */
export function pristineIndexJs(images = patchImages()) {
  const file = join(bunCacheDir(), CACHE_ENTRY, 'index.js');
  if (!existsSync(file)) return null;
  return blobId(file).startsWith(images.pre) ? file : null;
}
