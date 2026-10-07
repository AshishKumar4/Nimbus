/**
 * require-resolution.ts — Node's CommonJS resolution over a filesystem that
 * answers metadata questions (exists, isDirectory, a package.json's text):
 * LOAD_AS_FILE, LOAD_AS_DIRECTORY through each `main`, node_modules lookup,
 * `exports` and `imports` maps and self-reference, mirroring node-shims.ts's
 * runtime resolver so a walk and the process pick the same file.
 *
 * It reads no module source. Its callers are the module-map walk
 * (require-resolver.ts, which stages what it resolves) and the data plan
 * (worker facets/data-plan.ts, which only names files).
 */
import type { Awaitable, RuntimeFsBridge, RuntimeVfsStat } from './os-contracts.js';
import { type ResolvablePackageJson } from '../_shared/exports-resolver.js';
/**
 * The filesystem questions resolution needs; held-cell reuse can additionally
 * check current read authority without rereading bytes. A missing path is
 * false, false, a throw, and null.
 */
export interface RequireFs {
    exists(path: string): Awaitable<boolean>;
    isDirectory(path: string): Awaitable<boolean>;
    readFileString(path: string): Awaitable<string>;
    stat(path: string): Awaitable<{
        size: number;
    } | null>;
    /** Revalidate held content through the same principal without rereading its bytes. */
    assertReadable?(path: string): Awaitable<void>;
}
/**
 * The resolver's filesystem over a bound process bridge (supervisor RPC or
 * in-process), plus the two reads a launch builder needs. Every probe answers
 * a missing path (ENOENT, however the bridge reports it) with null or false;
 * other errors are the bridge's.
 */
export interface BridgeRequireFs extends RequireFs {
    stat(path: string): Promise<RuntimeVfsStat | null>;
    /** The entry itself, a final link not followed. */
    lstat(path: string): Promise<RuntimeVfsStat | null>;
    readBytes(path: string): Promise<Uint8Array | null>;
}
/**
 * The entry `require` takes of `pkg` for `subpath`, under the program's
 * conditions: its `exports` under require's conditions, else (a map with an
 * entry only under `import`) under import's, else its legacy `main` for the
 * root. The one reading of a package's entry: the runtime's resolution and
 * the launch's speculative root selection both take it.
 */
export declare function requirePackageEntry(pkg: ResolvablePackageJson, subpath: string, conditions: readonly string[]): string | null;
export declare function requireFsOverBridge(bridge: RuntimeFsBridge): BridgeRequireFs;
/**
 * Sink for package.json files consulted during LOAD_AS_DIRECTORY
 * resolution. The runtime resolver (`__resolveFile` in node-shims.ts)
 * re-derives a directory require's target by reading that directory's
 * package.json#main; if prefetch resolves a subpath through a nested
 * package.json (e.g. web-streams-polyfill's `ponyfill/package.json`
 * declaring `main: "../dist/ponyfill"`), only the FINAL file gets
 * added to the bundle — the runtime then can't repeat the resolution
 * because the intermediate package.json's content was never shipped
 * (and, for npx-cache trees outside cwd, isn't in the manifest either).
 * Recording every consulted package.json lets the prefetch walker add
 * its content so prefetch and runtime agree.
 */
export type PkgJsonSink = (pkgJsonPath: string) => Awaitable<string | null>;
export type WalkProgress = (work: number) => Promise<void>;
export declare const METADATA_CANDIDATE_WORK = 256;
/**
 * Extension-list probe; mirrors node-shims.ts:__resolveFile so prefetch
 * picks the same on-disk file the runtime require will pick.
 *
 * Mirrors Node's LOAD_AS_FILE + LOAD_AS_DIRECTORY (require_2 spec):
 *   1. LOAD_AS_FILE: base, base.js, base.mjs, base.cjs, base.json.
 *   2. LOAD_AS_DIRECTORY (if base resolves to a directory):
 *      a. <base>/package.json#main → recurse.
 *      b. <base>/index.{js,cjs,mjs,json}.
 *
 * Bug class C (audit 2026-05-11): step 2a was missing, so prefetch
 * silently dropped any file reachable only via package.json#main from
 * a directory-style require (e.g. `require('./mod')` where mod has
 * main='entry.js' and no index.js).
 */
export declare function resolveFile(vfs: RequireFs, base: string, sink?: PkgJsonSink, progress?: WalkProgress): Promise<string | null>;
/**
 * Result shape for `resolvePkgSubpathEx`. A legacy subpath directory with
 * its own package.json (`react-remove-scroll-bar/constants/package.json`
 * with `main: "../dist/constants.js"`) is Node's LOAD_AS_DIRECTORY, which
 * `resolveFile` and the runtime resolver both perform through `main`.
 */
export interface ResolveSubpathResult {
    /** Canonical resolved path to the real file. */
    resolved: string;
}
/** The require resolver `prefetchForRequire` walks with. */
export declare function resolveRequireEx(vfs: RequireFs, id: string, fromDir: string, sink?: PkgJsonSink, progress?: WalkProgress, 
/** The program's own conditions (`node --conditions`), beside require's. */
conditions?: readonly string[]): Promise<ResolveSubpathResult | null>;
//# sourceMappingURL=require-resolution.d.ts.map