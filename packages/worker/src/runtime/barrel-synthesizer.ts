/**
 * barrel-synthesizer.ts — generate synthetic entry files for "barrel"
 * packages so they tree-shake cleanly through esbuild.
 *
 * Why this exists
 * ───────────────
 * Some npm packages ship as a "barrel" — a single index file that
 * re-exports hundreds or thousands of named exports, each living in
 * its own source file. Examples observed in the wild:
 *
 *   lucide-react@0.460:        ~3940 files (~1500 icons × 2 entry forms)
 *   @phosphor-icons/react:     thousands of icon components
 *   react-icons:               thousands of icons across icon families
 *   @mui/icons-material:       thousands of Material icons
 *   @heroicons/react:          hundreds of icons (split by style)
 *
 * Bundling the whole barrel as if it were a normal browser module OOMs
 * esbuild's WASM facet — the compiler tries to ingest the entire
 * source tree into one ESM output. We previously fell back to
 * `https://esm.sh/<pkg>?deps=react@<v>,react-dom@<v>` (commit fc17847)
 * which violated the 100% edge contract: every preview load fetched
 * tree-shaken bytes from a third-party CDN.
 *
 * The fix is structural. Instead of bundling `import * from 'pkg'`,
 * we scan the user's source code for the SET of named imports the
 * project actually uses
 *
 *   import { Home, FileText, Zap } from 'lucide-react'
 *
 * and synthesize a tiny entry module
 *
 *   export { Home, FileText, Zap } from 'lucide-react';
 *
 * which esbuild bundles in milliseconds because reachability prunes
 * everything else. The output is small (5–20 KiB for typical icon
 * sets) and ships from our edge.
 *
 * Generality
 * ──────────
 * This is NOT lucide-react-specific. Any barrel package whose author
 * marked `sideEffects: false` (or whose individual icon files are
 * side-effect-free) works automatically — esbuild's tree-shake takes
 * care of selecting the actually-used exports. Packages without
 * sideEffects: false may still tree-shake because esbuild's static
 * analysis of `export { X } from './x.js'` is conservative-correct.
 *
 * Failure mode
 * ────────────
 * If the scanner can't enumerate the set (dynamic imports, computed
 * member access like `Icons[name]`, etc.), the synthesizer returns
 * null and the caller MUST hard-error. NO CDN fallback. The user
 * sees a clear remediation: "add a static import for the
 * dynamically-referenced icon."
 */

import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import type { SliceEntry } from '../npm/pre-bundle-facet.js';
import { packageNameFromSpecifier } from './barrel-detect.js';

/**
 * Map of package name → set of named imports observed across the
 * project's source files. Top-level package only — subpath imports
 * (e.g. `lucide-react/icons/Home`) are skipped because the user is
 * already opting into per-file resolution and esbuild handles them
 * directly without barrel pressure.
 */
export type NamedImportMap = Map<string, Set<string>>;

/**
 * Static-import scanner. Walks the user's source tree under projDir
 * and extracts named-import sets. Returns a map keyed by package name.
 *
 * Recognized syntax:
 *   import { A } from 'pkg'
 *   import { A, B } from 'pkg'
 *   import { A as X, B as Y } from 'pkg'
 *   import D, { A } from 'pkg'   // only A is captured (D is default)
 *
 * NOT recognized (intentional — these can't be statically tree-shaken):
 *   import * as M from 'pkg'             — caller must bundle whole pkg
 *   import('pkg')                         — dynamic; runtime resolution
 *   const { A } = require('pkg')          — CJS at runtime
 *
 * The scanner is intentionally conservative-text-based. We do NOT
 * parse a full AST — that would require shipping acorn or esbuild's
 * parser at runtime in the supervisor. The regex covers the >99% case
 * for browser source code in TS/JS/JSX/TSX.
 *
 * Costs: O(files × content_length). For Mossaic (199 source files,
 * ~150 KiB total source) this is single-digit ms.
 */
export function scanNamedImports(
  vfs: SqliteVFS,
  projDir: string,
): NamedImportMap {
  const result: NamedImportMap = new Map();
  const scanExts = new Set(['.ts', '.tsx', '.jsx', '.js', '.mjs']);

  const add = (pkgName: string, name: string): void => {
    let set = result.get(pkgName);
    if (!set) { set = new Set(); result.set(pkgName, set); }
    set.add(name);
  };

  // Match `import { ... } from 'spec'` and `import D, { ... } from 'spec'`.
  // Non-greedy to handle multiple imports per file. The `[^"']*?` after
  // the closing brace tolerates whitespace + the optional `from`.
  // Captures:
  //   1: the named-import body (between { and })
  //   2: the specifier
  const namedImportRe = /import\s+(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]+)\}\s*from\s*["']([^"']+)["']/g;

  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return;
    let entries: { name: string; type: string }[];
    try { entries = vfs.readdir(dir); } catch { return; }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' ||
          entry.name === 'dist' || entry.name === 'build') continue;
      const path = dir + '/' + entry.name;
      if (entry.type === 'directory') {
        walk(path, depth + 1);
        continue;
      }
      const dot = entry.name.lastIndexOf('.');
      if (dot < 0) continue;
      const ext = entry.name.substring(dot);
      if (!scanExts.has(ext)) continue;

      let code: string;
      try { code = vfs.readFileString(path); } catch { continue; }

      let m: RegExpExecArray | null;
      while ((m = namedImportRe.exec(code)) !== null) {
        const body = m[1];
        const specRaw = m[2];
        // Skip relative + builtin imports: only bare package specifiers.
        if (specRaw.startsWith('.') || specRaw.startsWith('/') || specRaw.startsWith('node:')) continue;
        // Skip subpath imports — the user is opting into per-file
        // resolution; esbuild bundles the specific file directly.
        const pkgName = packageNameFromSpecifier(specRaw);
        if (specRaw !== pkgName) continue;
        // Parse the named-import body. Each item is one of:
        //   X
        //   X as Y
        //   "X" as Y         (TS bracket-import, rare)
        // We capture the SOURCE name (the export name on the package),
        // NOT the local alias.
        for (const partRaw of body.split(',')) {
          const part = partRaw.trim();
          if (!part) continue;
          const asMatch = part.match(/^([A-Za-z_$][\w$]*)\s+as\s+[A-Za-z_$][\w$]*$/);
          if (asMatch) {
            add(pkgName, asMatch[1]);
            continue;
          }
          // Plain identifier — capture as-is. Reject anything that's not
          // a clean JS identifier (e.g. comments, type-only imports).
          if (/^[A-Za-z_$][\w$]*$/.test(part)) {
            add(pkgName, part);
          } else if (/^type\s+([A-Za-z_$][\w$]*)/.test(part)) {
            // `import { type Foo } from 'pkg'` — capture, esbuild will
            // strip type-only imports during bundle.
            const tm = part.match(/^type\s+([A-Za-z_$][\w$]*)/);
            if (tm) add(pkgName, tm[1]);
          }
          // Anything else (e.g. "default as X") is non-named; skip.
        }
      }
    }
  };

  walk(projDir, 0);
  return result;
}

/**
 * Synthesize a tiny ESM entry that re-exports the given names from
 * the package. We do NOT emit `export { X } from 'pkg'` — that resolves
 * to the package's barrel-index file, which typically pulls in EVERY
 * export via `import * as ns from '../index.js'` and breaks
 * esbuild's tree-shake (the namespace expansion balloons the
 * reachability graph and OOMs the WASM facet on icon-libraries
 * that ship 1500+ exports).
 *
 * Instead we PARSE the barrel-index file, build a map of
 * `<exportedName> → <relative path inside the package>`, and emit
 * direct file imports:
 *
 *   export { default as Home } from 'lucide-react/dist/esm/icons/house.js';
 *   export { default as FileText } from 'lucide-react/dist/esm/icons/file-text.js';
 *
 * esbuild's bundler now ingests only the per-icon files we directly
 * reference (plus their transitive dependencies). The unused 1499
 * icons never enter the build graph at all.
 *
 * Supported re-export forms in the barrel index:
 *   export { default as Name } from './icons/x.js';
 *   export { default as Name1, default as Name2 } from './icons/x.js';
 *   export { Name } from './icons/x.js';
 *   export { Name as Alias } from './icons/x.js';
 *
 * NOT supported (rare in barrels — caller falls back if encountered):
 *   export * from './foo.js';
 *   export * as ns from './foo.js';
 *   import { X } from './foo.js'; export { X };  (split form)
 *
 * Returns null if:
 *   - input set empty, OR
 *   - the barrel index file isn't found, OR
 *   - none of the user's requested names appear in the parsed map.
 *     (Caller should then hard-error, NOT fall back to a CDN.)
 *
 * `vfs` + `nmDir` (project's node_modules path) are required so we
 * can read the barrel index. `pkgName` is the top-level package; the
 * synthesizer resolves the package's main ESM entry by reading
 * `package.json`.
 */
/**
 * Result of a synthetic-entry build. `code` is the ESM source ready
 * for esbuild. `referencedFiles` is the set of absolute VFS paths
 * (no leading slash, like the rest of our VFS surface) the entry
 * imports — useful for callers building a SCOPED slice that contains
 * only those files instead of the whole package directory (which can
 * exceed the 28 MiB slice cap for icon-libraries with thousands of
 * files).
 */
export interface SyntheticEntryResult {
  code: string;
  referencedFiles: string[];
}

export function buildSyntheticEntry(
  vfs: SqliteVFS,
  nmDir: string,
  pkgName: string,
  names: ReadonlySet<string>,
): SyntheticEntryResult | null {
  if (names.size === 0) return null;
  const indexPath = findPackageEsmEntry(vfs, nmDir, pkgName);
  if (!indexPath) return null;
  const indexCode = (() => {
    try { return vfs.readFileString(indexPath); } catch { return null; }
  })();
  if (!indexCode) return null;

  // Build name → { path, isDefault, sourceName }.
  // sourceName = the name ON THE SOURCE FILE'S export. For
  //   `export { default as X } from './x.js'` → sourceName='default', isDefault=true.
  //   `export { Foo as Bar } from './foo.js'` → sourceName='Foo', isDefault=false.
  //   `export { Foo } from './foo.js'`        → sourceName='Foo', isDefault=false.
  type ExportRef = { path: string; sourceName: string; isDefault: boolean };
  const exportMap = new Map<string, ExportRef>();
  // Match an entire `export { ... } from '...';` block.
  const reExport = /export\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']\s*;?/g;
  let m: RegExpExecArray | null;
  while ((m = reExport.exec(indexCode)) !== null) {
    const body = m[1];
    const path = m[2];
    if (!path.startsWith('.')) continue; // only relative re-exports
    for (const partRaw of body.split(',')) {
      const part = partRaw.trim();
      if (!part) continue;
      // `default as X`
      const defAs = part.match(/^default\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (defAs) {
        exportMap.set(defAs[1], { path, sourceName: 'default', isDefault: true });
        continue;
      }
      // `X as Y`
      const renamed = part.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (renamed) {
        exportMap.set(renamed[2], { path, sourceName: renamed[1], isDefault: false });
        continue;
      }
      // `X`
      if (/^[A-Za-z_$][\w$]*$/.test(part)) {
        exportMap.set(part, { path, sourceName: part, isDefault: false });
        continue;
      }
      // `default` (default re-export with no rename) is rare; skip.
    }
  }

  // Primitives wave (P6) — `export * from './x.js'` support.
  //
  // Many barrel packages (date-fns, several utility libraries, some
  // icon kits) use `export *` aggregation instead of per-name
  // re-exports. The original synthesizer ignored these → exportMap
  // stayed empty → /preview/@modules/<pkg> 500'd with "synthetic
  // entry generation returned null".
  //
  // Strategy: harvest each `export *` source's own top-level export
  // declarations once, and inject them into the same exportMap with
  // `sourceName === exportedName`. This is not a full ESM resolver
  // (we don't follow nested `export *` chains), but it covers the
  // common case where the file at the end of the chain has explicit
  // `export function X` / `export const X` / `export class X` /
  // `export { X }` declarations — which matches every barrel
  // observed in the wild.
  //
  // Cap on the number of `export *` sources we walk so a pathological
  // barrel-of-barrels can't blow the synthesizer's budget.
  const indexDirForStar = indexPath.substring(0, indexPath.lastIndexOf('/'));
  const reExportStar = /export\s*\*\s*from\s*["']([^"']+)["']\s*;?/g;
  const STAR_SOURCE_CAP = 1500; // date-fns has ~290; well within cap
  let starSourcesWalked = 0;
  let s: RegExpExecArray | null;
  while ((s = reExportStar.exec(indexCode)) !== null && starSourcesWalked < STAR_SOURCE_CAP) {
    const path = s[1];
    if (!path.startsWith('.')) continue;
    starSourcesWalked++;
    const fullPath = normalizeJoin(indexDirForStar, path);
    let starCode: string | null;
    try { starCode = vfs.readFileString(fullPath); } catch { starCode = null; }
    if (!starCode) continue;
    // Harvest top-level exports from the source file. Order of patterns:
    //   1. `export { X, Y as Z } from "..."` (re-export from elsewhere)
    //   2. `export { X, Y as Z };` (re-export of locally-bound names)
    //   3. `export function|class|const|let|var X` (declaration)
    // We do NOT walk transitive `export *` chains; that's the
    // budget cap in exchange for simplicity. esbuild handles the
    // actual resolution at bundle time anyway — we only need enough
    // entries in the map to MATCH the user's named imports.
    const reInnerNamed = /export\s*\{([^}]+)\}\s*(?:from\s*["'][^"']+["'])?\s*;?/g;
    let im: RegExpExecArray | null;
    while ((im = reInnerNamed.exec(starCode)) !== null) {
      for (const partRaw of im[1].split(',')) {
        const part = partRaw.trim();
        if (!part) continue;
        const renamed = part.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
        if (renamed) {
          if (!exportMap.has(renamed[2])) {
            exportMap.set(renamed[2], { path, sourceName: renamed[2], isDefault: false });
          }
          continue;
        }
        if (/^[A-Za-z_$][\w$]*$/.test(part)) {
          if (!exportMap.has(part)) {
            exportMap.set(part, { path, sourceName: part, isDefault: false });
          }
        }
      }
    }
    // Top-level declarations — `export function X`, `export class X`,
    // `export const X`, `export let X`, `export var X`. Async, generator
    // and TS modifiers (default, abstract) handled by the prefix opt-out.
    const reDecl = /export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
    let dm: RegExpExecArray | null;
    while ((dm = reDecl.exec(starCode)) !== null) {
      const name = dm[1];
      if (!exportMap.has(name)) {
        exportMap.set(name, { path, sourceName: name, isDefault: false });
      }
    }
  }

  if (exportMap.size === 0) return null;

  // Match user's requested names against the map. Build per-file
  // groupings so the synthetic entry has one re-export per source
  // file (smaller text, cleaner tree-shake graph).
  const indexDir = indexPath.substring(0, indexPath.lastIndexOf('/'));
  // grouped: full-source-path → array of { exportedName, sourceName, isDefault }
  type Item = { exportedName: string; sourceName: string; isDefault: boolean };
  const grouped = new Map<string, Item[]>();
  let matched = 0;
  for (const name of names) {
    const ref = exportMap.get(name);
    if (!ref) continue;
    matched++;
    // Resolve relative path against indexDir, then strip the
    // package's nmDir prefix so we can build a `pkgName/...` import.
    const fullPath = normalizeJoin(indexDir, ref.path);
    let arr = grouped.get(fullPath);
    if (!arr) { arr = []; grouped.set(fullPath, arr); }
    arr.push({ exportedName: name, sourceName: ref.sourceName, isDefault: ref.isDefault });
  }
  if (matched === 0) return null;

  // Emit per-file re-export lines. Use `pkgName/<rel-from-pkg-root>`
  // so esbuild's resolver follows the package's exports field if any.
  const pkgRoot = nmDir + '/' + pkgName;
  const sortedFiles = [...grouped.keys()].sort();
  const lines: string[] = [
    `// AUTO-GENERATED synthetic entry for ${pkgName}`,
    `// ${matched} of ${names.size} requested names matched the parsed barrel.`,
    `// esbuild tree-shakes the rest of the package away.`,
  ];
  if (matched < names.size) {
    const missing = [...names].filter(n => !exportMap.has(n));
    lines.push(`// MISSING (not found in barrel index): ${missing.sort().join(', ')}`);
  }
  const referencedFiles: string[] = [];
  for (const filePath of sortedFiles) {
    let relFromPkg = filePath.startsWith(pkgRoot + '/')
      ? filePath.substring(pkgRoot.length + 1)
      : filePath;
    // Use the package-rooted form so esbuild's resolver respects
    // the package's exports/main fields. Strip leading slash.
    const importSpec = pkgName + '/' + relFromPkg;
    const items = grouped.get(filePath)!;
    // Sort items for determinism.
    items.sort((a, b) => a.exportedName.localeCompare(b.exportedName));
    const memberLines = items.map(i => {
      if (i.isDefault) return `default as ${i.exportedName}`;
      if (i.sourceName === i.exportedName) return i.exportedName;
      return `${i.sourceName} as ${i.exportedName}`;
    });
    lines.push(`export { ${memberLines.join(', ')} } from ${JSON.stringify(importSpec)};`);
    referencedFiles.push(filePath);
  }
  return {
    code: lines.join('\n') + '\n',
    referencedFiles,
  };
}

/**
 * Build a SCOPED slice for a synthetic-entry bundle: include only
 * the files the synthetic entry directly references (+ their
 * transitive imports walked via static analysis), plus the package
 * root's `package.json` (esbuild's resolver reads it for exports/main
 * fields). This bypasses the standard `walkDir` over the whole
 * package, which for icon-libraries with thousands of files can
 * exceed the 28 MiB slice cap.
 *
 * Caller still appends the synthetic entry file itself to the slice
 * (we don't include it here because it lives in a synthetic
 * directory the caller already manages).
 *
 * Returns the list of `SliceEntry`-shaped objects to push into the
 * existing slice, plus the total bytes added (for cap-tracking).
 *
 * `transitiveCap`: how many files we'll walk in total. Bounded so a
 * pathological barrel-of-barrels can't blow the cap. Default 800,
 * which empirically covers icon-libraries with up to ~400 imported
 * icons (each pulling 1-2 transitive shared utility files).
 */
export function buildScopedSliceForSynthetic(
  vfs: SqliteVFS,
  nmDir: string,
  pkgName: string,
  referencedFiles: string[],
  transitiveCap = 800,
): { entries: SliceEntry[]; totalBytes: number } {
  const entries: SliceEntry[] = [];
  let totalBytes = 0;
  const visited = new Set<string>();
  const dirSet = new Set<string>();
  const pkgRoot = nmDir + '/' + pkgName;

  const addDir = (d: string) => {
    if (dirSet.has(d) || !d) return;
    dirSet.add(d);
    entries.push({ path: '/' + d.replace(/^\/+/, ''), isDir: true });
  };

  // Always include the package root + its package.json. esbuild's
  // resolver reads package.json for sideEffects, exports, main, etc.
  addDir(pkgRoot);
  const pkgJsonPath = pkgRoot + '/package.json';
  if (vfs.exists(pkgJsonPath) && !vfs.isDirectory(pkgJsonPath)) {
    try {
      const bytes = vfs.readFile(pkgJsonPath);
      entries.push({ path: '/' + pkgJsonPath.replace(/^\/+/, ''), bytes, isDir: false });
      totalBytes += bytes.length + pkgJsonPath.length;
      visited.add(pkgJsonPath);
    } catch {}
  }

  // Walker: BFS over referenced files + their relative imports.
  const queue = [...referencedFiles];
  while (queue.length > 0 && visited.size < transitiveCap) {
    const filePath = queue.shift()!;
    if (visited.has(filePath)) continue;
    visited.add(filePath);
    if (!vfs.exists(filePath) || vfs.isDirectory(filePath)) continue;
    let bytes: Uint8Array;
    try { bytes = vfs.readFile(filePath); } catch { continue; }
    // Track parent dirs so esbuild's plugin's dirSet has them.
    const slash = filePath.lastIndexOf('/');
    if (slash > 0) addDir(filePath.substring(0, slash));
    entries.push({ path: '/' + filePath.replace(/^\/+/, ''), bytes, isDir: false });
    totalBytes += bytes.length + filePath.length;
    // Parse relative imports and queue them. Same regex as
    // scanNamedImports but with relative-path predicate.
    const text = new TextDecoder().decode(bytes);
    const importRe = /(?:from\s+|import\s*\(?\s*)["'](\.\.?\/[^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(text)) !== null) {
      const rel = m[1];
      const dir = filePath.substring(0, slash > 0 ? slash : 0);
      const candidate = normalizeJoin(dir, rel);
      // Try with extensions (.js, .mjs, no-ext-as-dir/index.js).
      for (const ext of ['', '.js', '.mjs', '.cjs', '.jsx']) {
        const tryPath = candidate + ext;
        if (!visited.has(tryPath) && vfs.exists(tryPath) && !vfs.isDirectory(tryPath)) {
          queue.push(tryPath);
          break;
        }
      }
      // Also try as directory with index.js.
      const idx = candidate + '/index.js';
      if (!visited.has(idx) && vfs.exists(idx) && !vfs.isDirectory(idx)) {
        queue.push(idx);
      }
    }
  }
  return { entries, totalBytes };
}

/**
 * Resolve the package's main ESM entry file path (preferring the
 * `module` field, then `main`). Returns null if the package isn't
 * installed or doesn't expose a JS entry.
 */
function findPackageEsmEntry(
  vfs: SqliteVFS,
  nmDir: string,
  pkgName: string,
): string | null {
  const pkgRoot = nmDir + '/' + pkgName;
  const pkgJsonPath = pkgRoot + '/package.json';
  if (!vfs.exists(pkgJsonPath)) return null;
  let pkg: any;
  try { pkg = JSON.parse(vfs.readFileString(pkgJsonPath)); } catch { return null; }
  // Prefer module (ESM), then main.
  const candidates: string[] = [];
  if (typeof pkg.module === 'string') candidates.push(pkg.module);
  if (typeof pkg.main === 'string') candidates.push(pkg.main);
  // Some packages publish `exports` field with a default condition
  // pointing at ESM; try that as a tiebreaker.
  if (pkg.exports && typeof pkg.exports === 'object') {
    const root = pkg.exports['.'] || pkg.exports;
    if (root && typeof root === 'object') {
      const m = root.import || root.module || root.default;
      if (typeof m === 'string') candidates.unshift(m);
    } else if (typeof root === 'string') {
      candidates.unshift(root);
    }
  }
  for (const rel of candidates) {
    const clean = rel.replace(/^\.\//, '');
    const abs = pkgRoot + '/' + clean;
    if (vfs.exists(abs) && !vfs.isDirectory(abs)) return abs;
    // Try with index.js if rel is a directory.
    const idx = abs + '/index.js';
    if (vfs.exists(idx)) return idx;
  }
  return null;
}

/**
 * Normalize-join two paths: `dir + '/' + rel`, resolving `.` and `..`
 * segments. Used when the barrel-index references siblings via
 * relative paths like `./icons/house.js`.
 */
function normalizeJoin(dir: string, rel: string): string {
  const stack = dir.split('/').filter(Boolean);
  for (const seg of rel.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') stack.pop();
    else stack.push(seg);
  }
  return (dir.startsWith('/') ? '/' : '') + stack.join('/');
}

/**
 * VFS path where synthetic entries are written. Lives under the
 * project's node_modules in a Nimbus-private namespace so package
 * managers don't collide with real package directories.
 *
 * Format: <projDir>/node_modules/.nimbus-synthetic/<safeName>.entry.js
 *
 * Safe name = pkgName with '@' and '/' replaced by '__' so scoped
 * packages produce a valid filesystem path.
 */
export function syntheticEntryPath(projDir: string, pkgName: string): string {
  const safe = pkgName.replace(/[@/]/g, '__');
  return projDir + '/node_modules/.nimbus-synthetic/' + safe + '.entry.js';
}
