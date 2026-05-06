// X.5-L probe helpers — re-exports the X.5-C helpers (synth VFS,
// makeFacet, check/summary/reset) plus a real-package-fixture loader.
//
// Why re-export instead of copy: the helper surface is stable and any
// X.5-C helper bug is already audited via x5c probes. A fork would
// drift; a re-export keeps the single-impl invariant.
//
// The real-package-fixture loader (`loadRealPkgFixture`) reads files
// from a pre-installed scratch directory on disk and packages them
// into the synth VFS shape. Lets us drive the *runtime* require chain
// against the *actual* file content shipped by the package, without
// needing a live wrangler dev or production WS session.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

export {
  makeVfs,
  makeFacet,
  check,
  summary,
  reset,
  results,
  X5C_OUT_DIR,
} from '../x5c/_helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const X5L_OUT_DIR = path.join(HERE, '_results');
fs.mkdirSync(X5L_OUT_DIR, { recursive: true });

// ─── Real-package fixture loader ─────────────────────────────────────────

/**
 * Read a real package's directory tree from disk and emit a synth-VFS
 * file map. Strips the on-disk prefix and rewrites paths under
 * `home/user/app/node_modules/<pkgName>/...`.
 *
 * @param {string} diskRoot   Absolute path to the on-disk pkg directory
 *                            (e.g. /tmp/x5l-fixtures/node_modules/react-remove-scroll).
 * @param {string} pkgName    Package name as it should appear in the
 *                            VFS path (e.g. `react-remove-scroll`).
 * @returns {Record<string, string>} Map of vfs-path → file content.
 */
export function loadRealPkgFixture(diskRoot, pkgName) {
  const out = {};
  const vfsPrefix = `home/user/app/node_modules/${pkgName}`;

  function walk(dir, rel) {
    const ents = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of ents) {
      const full = path.join(dir, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(full, r);
      else if (e.isFile()) {
        // Skip junk that bloats the bundle (TypeScript declarations,
        // test fixtures, etc.) — we want runtime-required surfaces only.
        if (e.name.endsWith('.d.ts')) continue;
        if (e.name.endsWith('.d.cts')) continue;
        if (e.name.endsWith('.d.mts')) continue;
        if (e.name.endsWith('.map')) continue;
        if (e.name.endsWith('.md')) continue;
        if (e.name === 'LICENSE') continue;
        try {
          const c = fs.readFileSync(full, 'utf8');
          out[`${vfsPrefix}/${r}`] = c;
        } catch { /* binary or unreadable; skip */ }
      }
    }
  }

  walk(diskRoot, '');
  return out;
}

/**
 * Run `bun add <pkgs>` in a scratch dir, then load the resulting
 * node_modules tree as a synth-VFS file map. Cached at module-init
 * time per (cacheKey, pkgs) tuple — first run installs, subsequent
 * runs reuse.
 *
 * @param {string} cacheKey   Stable key naming the fixture (e.g. 'rrs').
 * @param {string[]} pkgs     `bun add` arg list.
 * @returns {Record<string, string>} Combined file map across all
 *                                   installed packages.
 */
export function getOrInstallFixture(cacheKey, pkgs) {
  const fixtureDir = path.join('/tmp', 'x5l-fixtures', cacheKey);
  fs.mkdirSync(fixtureDir, { recursive: true });

  const sentinel = path.join(fixtureDir, '.installed');
  if (!fs.existsSync(sentinel)) {
    // Initialize as a bun project (silent failure ok if package.json
    // already exists from a prior partial run).
    const pkgJson = path.join(fixtureDir, 'package.json');
    if (!fs.existsSync(pkgJson)) {
      fs.writeFileSync(pkgJson, JSON.stringify({
        name: 'x5l-fixture-' + cacheKey,
        version: '0.0.0',
        private: true,
      }, null, 2));
    }
    execSync(`bun add ${pkgs.join(' ')}`, {
      cwd: fixtureDir,
      stdio: 'inherit',
      timeout: 120_000,
    });
    fs.writeFileSync(sentinel, new Date().toISOString());
  }

  // Load every package directory under node_modules
  const nm = path.join(fixtureDir, 'node_modules');
  const out = {};
  if (!fs.existsSync(nm)) return out;
  const ents = fs.readdirSync(nm, { withFileTypes: true });
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.')) continue;
    if (e.name.startsWith('@')) {
      // Scoped — recurse one level.
      const scope = path.join(nm, e.name);
      const sub = fs.readdirSync(scope, { withFileTypes: true });
      for (const s of sub) {
        if (!s.isDirectory()) continue;
        Object.assign(
          out,
          loadRealPkgFixture(path.join(scope, s.name), `${e.name}/${s.name}`),
        );
      }
    } else {
      Object.assign(
        out,
        loadRealPkgFixture(path.join(nm, e.name), e.name),
      );
    }
  }
  return out;
}

