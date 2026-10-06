/**
 * npx-install.ts — Nimbus-native npx implementation.
 *
 * Fixes the too-narrow semver-range detector in the original substrate command
 * path, which missed major-only ranges like `'1'`, `'2'`, and `'1.0'`.
 * That path treated `'1'` as a literal version, fetched `/wrappy/1`, got 404,
 * and silently skipped the dependency.
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
 * Binary lookup and execution follow the same user-visible npx flow:
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
import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { ProjectFs } from '../runtime/project-fs.js';
import { type FacetBundleProfile } from '@nimbus-sh/core/runtime/bundle-profile.js';
/** Path where npx caches packages it installs. Matches the vendored substrate
 * cache layout so tooling that introspects npx state sees the expected path. */
export declare const NPX_CACHE_DIR = "/tmp/.npx-cache";
export type NpxSelfInvocation = 'help' | 'version' | 'missing' | null;
/** What `npx <args>` asks for, read once. */
export interface NpxInvocation {
    /** npx's own `--help`/`--version`, no command at all, or null for a command. */
    self: NpxSelfInvocation;
    /** The command word: a package spec, or the bin name under `--package`. */
    command: string | null;
    /** The command's own arguments. */
    args: string[];
    /** `--package <pkg>`: the package to install, whose bin `command` names. */
    packageOverride: string | null;
    yes: boolean;
}
export declare function parseNpxInvocation(rawArgs: string[]): NpxInvocation;
export declare function formatNpxHelp(): string;
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
    bundleProfile?: FacetBundleProfile;
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
 * Note: deliberately does not format `--version`/`--help` for npx itself.
 * Callers can use parseNpxInvocation()/formatNpxHelp() before calling
 * this resolver.
 */
export declare function resolveNpxBinary(installer: NpmInstaller, 
/** The caller's view of the namespace (runtime/project-fs.ts): the project and the npx cache alike. */
vfs: Pick<ProjectFs, 'exists' | 'readFileString' | 'mkdir' | 'writeFile'>, 
/** The caller's credential: what the npx cache install is written as. */
cred: VfsCred, cwd: string, rawArgs: string[], log: (msg: string) => void, pid: number, 
/** The command's `NPM_REGISTRY`; the npx cache install reads from it too. */
registry?: string): Promise<NpxResolveResult>;
//# sourceMappingURL=npx-install.d.ts.map