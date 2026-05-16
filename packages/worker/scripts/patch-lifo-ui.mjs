/**
 * patch-lifo-ui.mjs — postinstall fix-ups for the Nimbus build chain.
 *
 *   1. Create a stub `@lifo-sh/ui` (legacy alias; some imports still
 *      reference it).
 *   2. Patch every installed copy of `isomorphic-git` (cf-git fork) so
 *      its `exports` map points at `src/...` paths (the published
 *      tarball's package.json points at root-level paths but the
 *      tarball actually ships files under `src/`).
 *   3. Symlink cf-git's missing deps into its nested `node_modules`
 *      so wrangler's esbuild can resolve them.
 *
 * Walks both root node_modules AND every packages/* / apps/*
 * sub-node_modules. Idempotent — re-running is a no-op once patched.
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, symlinkSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// The script lives at packages/worker/scripts/. Walk up to the repo
// root so we can patch every node_modules tree below it.
const repoRoot = resolve(__dirname, '..', '..', '..');

// ── 1. @lifo-sh/ui stub at root node_modules ────────────────────────
{
  const dir = join(repoRoot, 'node_modules', '@lifo-sh', 'ui');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: '@lifo-sh/ui', version: '0.0.1', main: 'index.js' }, null, 2),
  );
  writeFileSync(join(dir, 'index.js'), 'module.exports = {};');
  writeFileSync(join(dir, 'index.d.ts'), 'export {};');
  console.log('[patch] @lifo-sh/ui stub created');
}

// ── 2 + 3. Walk every node_modules and patch cf-git copies ──────────
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


