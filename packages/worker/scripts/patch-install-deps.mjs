/**
 * postinstall fix-ups for Nimbus' dependency graph: links the nested
 * dependencies cf-git expects, and applies the tracked cf-git patch to every
 * installed copy.
 */

import {
  copyFileSync,
  existsSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CF_GIT_PATCH,
  cfGitState,
  findCfGitDirs,
  findNodeModules,
  patchImages,
  pristineIndexJs,
  reinstallCommand,
} from './cf-git-patch.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// The script lives at packages/worker/scripts/. Walk up to the repo
// root so we can patch every node_modules tree below it.
const repoRoot = resolve(__dirname, '..', '..', '..');
const nmDirs = findNodeModules(repoRoot);
const cfGitDirs = findCfGitDirs(repoRoot);

for (const nm of nmDirs) {
  const igPkgPath = join(nm, 'isomorphic-git', 'package.json');
  if (!existsSync(igPkgPath)) continue;
  try {
    const igDir = dirname(igPkgPath);
    // Symlink missing nested deps so wrangler's esbuild can resolve them.
    const igNm = join(igDir, 'node_modules');
    if (existsSync(igNm)) {
      const needed = ['clean-git-ref', 'is-git-ref-name-valid', 'crc-32', 'sha.js', 'simple-get', 'minimisted'];
      // Walk up to find the nearest node_modules with each needed pkg.
      for (const need of needed) {
        const target = join(igNm, need);
        if (existsSync(target)) continue;
        // Search up the dir chain.
        let search = dirname(nm);
        let found = null;
        while (search !== '/') {
          const candidate = join(search, 'node_modules', need);
          if (existsSync(candidate)) { found = candidate; break; }
          search = dirname(search);
        }
        if (!found) continue;
        // Compute relative symlink target (path-from-symlink-dir-to-target).
        const rel = relative(igNm, found);
        try {
          symlinkSync(rel, target);
          console.log(`[patch] cf-git dep linked: ${target} → ${rel}`);
        } catch (e) {
          // Common when symlink already exists or two processes race.
          if (!String(e?.message).includes('EEXIST')) {
            console.warn(`[patch] cf-git symlink failed: ${need} — ${e?.message}`);
          }
        }
      }
    }
  } catch (e) {
    console.warn(`[patch] cf-git dependency links skipped at ${igPkgPath}:`, e?.message);
  }
}

const images = patchImages();
if (cfGitDirs.size === 0) {
  throw new Error('No @ashishkumar472/cf-git@1.0.5 installation found to patch');
}

function gitApply(cwd) {
  const result = spawnSync('git', ['apply', '--no-index', '--unidiff-zero', CF_GIT_PATCH], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(cwd) },
  });
  if (result.status === 0) return;
  const why = result.error?.message || result.stderr?.trim() || result.stdout?.trim() || 'unknown error';
  throw new Error(`Failed to apply the cf-git patch at ${cwd}: ${why}`);
}

// Each copy's index.js is identified by its blob id against the patch's
// `index <pre>..<post>` header. bun's isolated linker hardlinks installed
// files from its cache, so nothing here writes into an existing index.js:
// git apply writes its result as a new file in place of the old one (a new
// inode; tests/unit/cf-git-patch-state.mjs holds it), and a restore unlinks the installed file before copying.
for (const cfGitDir of cfGitDirs) {
  const state = cfGitState(cfGitDir, images);
  if (state === 'patched') {
    console.log(`[patch] cf-git patch already applied: ${cfGitDir}`);
    continue;
  }
  if (state !== 'pristine') {
    // Another revision of the patch (or a hand edit): start again from bun's cached copy.
    const pristine = pristineIndexJs(images);
    if (state === 'missing' || !pristine) {
      throw new Error(
        `cf-git at ${cfGitDir} is neither pristine nor patched with the tracked patch (index.js ${images.pre}..${images.post}), `
          + `and bun's cache holds no pristine copy to restore. Reinstall it: ${reinstallCommand(cfGitDir, repoRoot)}`,
      );
    }
    const indexJs = join(cfGitDir, 'index.js');
    unlinkSync(indexJs);
    copyFileSync(pristine, indexJs);
    console.log(`[patch] cf-git index.js restored from bun's cache (${pristine}): ${cfGitDir}`);
  }
  gitApply(cfGitDir);
  if (cfGitState(cfGitDir, images) !== 'patched') {
    throw new Error(`cf-git at ${cfGitDir} does not match the tracked patch's post-image ${images.post} after applying it`);
  }
  console.log(`[patch] cf-git patch applied: ${cfGitDir}`);
}
