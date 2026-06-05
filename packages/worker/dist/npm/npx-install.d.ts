/**
 * npx-install.ts — Nimbus-native npx implementation.
 *
 * Replaces @lifo-sh/core's createNpxCommand (which uses a too-narrow
 * semver-range detector that misses major-only ranges like `'1'`, `'2'`,
 * `'1.0'`). The core's `ic()` regex `/[\^~>=<|*x]/.test(r)` flagged
 * caret/tilde/comparator/x ranges correctly but treated `'1'` as a
 * literal version → fetched `/wrappy/1` → 404 → silently skipped.
 *
 * Symptom captured by tests/behavioral/install/transitive-dep-resolution.mjs:
 *   `npx --yes rimraf@3.0.2 --help` →
 *     warn: could not install wrappy: Package 'wrappy@1' not found in registry
 *     warn: could not install inherits: Package 'inherits@2' not found in registry
 *     Cannot find module './' (from /tmp/.npx-cache/node_modules/rimraf)
 *
 * Fix: route the npx install step through Nimbus's NpmInstaller, which
 * uses always-fetch-packument + RESOLVE_VERSION-style version-pick path
 * (resolve-one-facet.ts:264 + RESOLVE_VERSION). Handles all semver-range
 * syntax including major-only and major.minor.
 *
 * Binary-lookup and execution stay closer to the @lifo-sh/core flow:
 *   1. Check cwd/node_modules/.bin/<cmd>
 *   2. Check /tmp/.npx-cache/node_modules/.bin/<cmd>
 *   3. Check global registry (built-ins like vite, esbuild — handled by
 *      caller; this module is only invoked when registry resolution failed)
 *   4. Install package via NpmInstaller into /tmp/.npx-cache
 *   5. Locate <pkg>/package.json#bin → resolve absolute path
 *   6. Invoke via Nimbus's `node` registry command (preserves PID
 *      tracking, log buffer, process table membership)
 */
import type { NpmInstaller } from './installer.js';
import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
/** Path where npx caches packages it installs. Matches the constant
 *  in @lifo-sh/core (Vs in dist/index-Djm2onjx.js) so any other code
 *  reading this dir (e.g. tooling that introspects npx state) sees the
 *  same layout. */
export declare const NPX_CACHE_DIR = "/tmp/.npx-cache";
/**
 * Result of a Nimbus-native npx invocation.
 *
 *   ok=true:  the binary was located AND about to be invoked. The
 *             caller dispatches via the `node` registry handler with
 *             { args: [binPath, ...binArgs] }.
 *   ok=false: bin not found OR install failed OR arg parse error.
 *             `error` is a human-readable message; caller prints to
 *             stderr and returns exit code.
 */
export interface NpxResolveResult {
    ok: boolean;
    binPath?: string;
    binArgs?: string[];
    error?: string;
    /** Diagnostic: which path located the bin (project-nm / npx-cache /
     *  fresh-install). Useful in logs. */
    source?: 'project-nm' | 'npx-cache' | 'fresh-install';
}
/**
 * Resolve a binary for `npx <args>` by:
 *   1. Parsing args.
 *   2. Checking node_modules/.bin/<binName> in cwd, then NPX cache.
 *   3. If absent, installing the package via NpmInstaller into
 *      /tmp/.npx-cache, then re-checking.
 *
 * The caller is responsible for actually invoking the resulting binPath
 * via Nimbus's `node` command — keeping this module pure (no process
 * spawning) makes it testable.
 *
 * Note: deliberately does NOT honor `--version`/`--help` for npx
 * itself (those are caller's job); they bubble up as `error` markers
 * so the caller can format the usage banner consistently with the
 * rest of the shell.
 */
export declare function resolveNpxBinary(installer: NpmInstaller, vfs: SqliteVFS, cwd: string, rawArgs: string[], log: (msg: string) => void): Promise<NpxResolveResult>;
//# sourceMappingURL=npx-install.d.ts.map