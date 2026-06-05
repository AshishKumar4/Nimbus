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
export declare function scanNamedImports(vfs: SqliteVFS, projDir: string): NamedImportMap;
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
export declare function buildSyntheticEntry(vfs: SqliteVFS, nmDir: string, pkgName: string, names: ReadonlySet<string>): SyntheticEntryResult | null;
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
export declare function buildScopedSliceForSynthetic(vfs: SqliteVFS, nmDir: string, pkgName: string, referencedFiles: string[], transitiveCap?: number): {
    entries: SliceEntry[];
    totalBytes: number;
};
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
export declare function syntheticEntryPath(projDir: string, pkgName: string): string;
//# sourceMappingURL=barrel-synthesizer.d.ts.map