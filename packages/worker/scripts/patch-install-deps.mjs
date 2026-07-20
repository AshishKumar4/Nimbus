/**
 * postinstall fix-ups for Nimbus' dependency graph.
 *
 * The cf-git fork currently publishes package export paths that point at
 * root-level files even though the tarball ships them under src/. Wrangler's
 * bundler follows the export map, so Nimbus patches installed copies in-place
 * and links the nested dependencies that cf-git expects.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// The script lives at packages/worker/scripts/. Walk up to the repo
// root so we can patch every node_modules tree below it.
const repoRoot = resolve(__dirname, '..', '..', '..');
const cfGitPatch = resolve(
  __dirname,
  '..',
  'patches',
  '@ashishkumar472+cf-git+1.0.5.patch',
);

// Walk every node_modules tree and patch cf-git copies.
function walkForNodeModules(base, depth = 0) {
  if (depth > 5) return [];          // safety
  if (!existsSync(base)) return [];
  const out = [];
  let entries;
  try { entries = readdirSync(base, { withFileTypes: true }); }
  catch { return []; }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name === 'node_modules') {
      out.push(join(base, ent.name));
    } else if (ent.name === 'packages' || ent.name === 'apps') {
      // recurse one level into packages/* and apps/*
      for (const sub of readdirSync(join(base, ent.name), { withFileTypes: true })) {
        if (sub.isDirectory()) {
          out.push(...walkForNodeModules(join(base, ent.name, sub.name), depth + 1));
        }
      }
    }
  }
  return out;
}

const nmDirs = walkForNodeModules(repoRoot);
const cfGitDirs = new Set();

for (const nm of nmDirs) {
  for (const packagePath of [
    join(nm, 'isomorphic-git', 'package.json'),
    join(nm, '@ashishkumar472', 'cf-git', 'package.json'),
    join(
      nm,
      '.bun',
      '@ashishkumar472+cf-git@1.0.5',
      'node_modules',
      '@ashishkumar472',
      'cf-git',
      'package.json',
    ),
  ]) {
    if (!existsSync(packagePath)) continue;
    const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
    if (pkg.name === '@ashishkumar472/cf-git' && pkg.version === '1.0.5') {
      cfGitDirs.add(realpathSync(dirname(packagePath)));
    }
  }
}

for (const nm of nmDirs) {
  const igPkgPath = join(nm, 'isomorphic-git', 'package.json');
  if (!existsSync(igPkgPath)) continue;
  try {
    const pkg = JSON.parse(readFileSync(igPkgPath, 'utf8'));
    const igDir = dirname(igPkgPath);
    const needsPatch =
      pkg.exports?.['.']?.worker === './index.js'
      && !existsSync(join(igDir, 'index.js'))
      && existsSync(join(igDir, 'src', 'index.js'));
    if (needsPatch) {
      pkg.exports['.'] = {
        types: './src/index.d.ts',
        worker: './src/index.js',
        import: './src/index.js',
        default: './src/index.js',
      };
      if (pkg.exports['./http/web']) {
        pkg.exports['./http/web'] = {
          import: { types: './src/http/web/index.d.ts', default: './src/http/web/index.js' },
        };
      }
      if (pkg.exports['./http/node']) {
        pkg.exports['./http/node'] = {
          import: { types: './src/http/node/index.d.ts', default: './src/http/node/index.js' },
        };
      }
      pkg.main = './src/index.js';
      writeFileSync(igPkgPath, JSON.stringify(pkg, null, 2) + '\n');
      console.log(`[patch] cf-git exports patched: ${igPkgPath}`);
    }

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
    console.warn(`[patch] cf-git patch skipped at ${igPkgPath}:`, e?.message);
  }
}

if (!existsSync(cfGitPatch)) {
  throw new Error(`Missing tracked cf-git patch: ${cfGitPatch}`);
}
if (cfGitDirs.size === 0) {
  throw new Error('No @ashishkumar472/cf-git@1.0.5 installation found to patch');
}

function runGitApply(cwd, args) {
  return spawnSync(
    'git',
    ['apply', '--no-index', '--unidiff-zero', ...args, cfGitPatch],
    {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CEILING_DIRECTORIES: dirname(cwd),
      },
    },
  );
}

function gitApplyFailure(result) {
  return (
    result.error?.message ||
    result.stderr?.trim() ||
    result.stdout?.trim() ||
    'unknown error'
  );
}

for (const cfGitDir of cfGitDirs) {
  const reverseCheck = runGitApply(cfGitDir, ['--reverse', '--check']);
  if (reverseCheck.status === 0) {
    console.log(`[patch] cf-git checkout repairs already applied: ${cfGitDir}`);
    continue;
  }

  const forwardCheck = runGitApply(cfGitDir, ['--check']);
  if (forwardCheck.status !== 0) {
    throw new Error(
      `Cannot apply cf-git checkout repairs at ${cfGitDir}: ${gitApplyFailure(forwardCheck)}`,
    );
  }

  const apply = runGitApply(cfGitDir, []);
  if (apply.status !== 0) {
    throw new Error(
      `Failed to apply cf-git checkout repairs at ${cfGitDir}: ${gitApplyFailure(apply)}`,
    );
  }
  console.log(`[patch] cf-git checkout repairs applied: ${cfGitDir}`);
}
