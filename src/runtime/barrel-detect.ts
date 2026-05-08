/**
 * barrel-detect.ts — heuristic for "barrel" packages whose source tree
 * is too large for esbuild's facet to bundle without OOM.
 *
 * Barrel packages ship one .js per icon/component (e.g. lucide-react
 * with 1500 icons → 4000+ files). esbuild's bundler ingests the whole
 * tree into a single ESM module, which routinely OOMs the 128 MiB
 * facet isolate during JS heap allocation.
 *
 * Both the install-time pre-bundle path (npm-installer.prebundleUsedModules)
 * and the on-demand path (vite-dev-server.serveModule) use this to
 * route the package through `barrel-synthesizer.ts`: scan the user's
 * source for static named imports, generate a tiny synthetic entry
 * (`export { Home, FileText } from 'pkg'`), and bundle THAT through
 * the standard facet path. esbuild's tree-shaking + the package's
 * sideEffects:false produces a small per-app bundle without ever
 * reaching for a third-party CDN (100% edge contract).
 *
 * Threshold rationale (1500 files):
 *   lucide-react@0.460:    4069 files (synthesizes)
 *   framer-motion@11.11:    ~250 files (bundles whole)
 *   react-router-dom@6.26:  ~80  files (bundles whole)
 *   react-dom@18.3:         ~150 files (bundles whole)
 *
 * The cap (5000) prevents pathological deep walks; we only need to
 * know "clearly a barrel" vs. not.
 */

import type { SqliteVFS } from '../vfs/sqlite-vfs.js';

/** A package with more than this many files is treated as a barrel. */
export const BARREL_PKG_FILE_THRESHOLD = 1500;

/**
 * Recursively count files under `pkgDir`, excluding nested node_modules
 * (those are walked separately by the slice walker as transitive deps).
 *
 * Stops counting once we exceed `cap` to avoid pathological walks. Cost:
 * VFS readdir is sync + in-memory inode lookup. For lucide-react
 * (4069 files), measured at <2 ms in dev.
 */
export function countPackageFiles(vfs: SqliteVFS, pkgDir: string, cap = 5000): number {
  if (!vfs.exists(pkgDir) || !vfs.isDirectory(pkgDir)) return 0;
  let count = 0;
  const stack = [pkgDir];
  while (stack.length > 0 && count <= cap) {
    const dir = stack.pop()!;
    let entries: { name: string; type: string }[];
    try { entries = vfs.readdir(dir); } catch { continue; }
    for (const e of entries) {
      if (e.name === 'node_modules') continue;
      const child = dir + '/' + e.name;
      if (e.type === 'directory') stack.push(child);
      else count++;
    }
  }
  return count;
}

/**
 * Convenience: derive top-level package name from a bare specifier
 * (e.g. "lucide-react/icons/Cloud" → "lucide-react", "@radix-ui/react"
 * → "@radix-ui/react"). Used by callers building the pkgDir path.
 */
export function packageNameFromSpecifier(specifier: string): string {
  return specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0];
}
