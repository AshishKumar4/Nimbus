/**
 * launch-reads.ts — what a launch's build asked the filesystem, so that the
 * module map it built can serve a later launch after writes it never read.
 *
 * The prefetch cache (facets/manager.ts prefetchBundleCache) kept a build
 * only while the session's global revision stayed where it was, and every
 * write moves that revision: a shell history line, or an agent's file tool
 * between two `node -e` runs. Measured 2026-10-23 on a throwaway (verdict
 * 20261023T005039-3f6a52332079): in an express project, a `node -e 1` after a
 * write elsewhere rebuilt its map every time, 1.6-2.5 s against 0.6 s for a
 * kept one.
 *
 * A build's answer depends on what it asked: each path it read, stat'ed,
 * resolved or probed (found or not, which is how a module resolves), and
 * each directory it listed. recordLaunchReads passes a build's bridge
 * through and notes those. A later change (the barrier's report since the
 * build's cursor, RuntimeFsBridge.acquire) leaves the build's answer as it
 * was unless it names one of them (readsAffectedBy):
 *   - a path the build asked about;
 *   - a directory above one, removed, renamed or given another mode or owner
 *     (a structural change, or a subtree's, moves what is under it);
 *   - a directory the build listed, or a name in it.
 * The barrier reports, beside each changed path, the directory it is in
 * (SqliteVFS's publication records the parent). For a directory the build
 * found there, that record says only that something in it changed, which
 * the record of the child itself answers, so it does not count as a change
 * to the directory the build stat'ed on its way down; otherwise every write
 * in the home directory would invalidate every build that resolved a path
 * under it. For a path the build did not find, it is the path being made,
 * and counts (a package installed where resolution looked first).
 * A build that enumerated the namespace, or that wrote, or that named a path
 * by a descriptor rather than by name, depends on everything.
 */
import type { RuntimeFsBridge, VfsInvalidatedPath } from '@nimbus-sh/core/runtime/os-contracts.js';
/** What a build asked the filesystem about, by the names the barrier reports (no leading or trailing slash). */
export interface LaunchReads {
    /** Each path it read, stat'ed, resolved or probed, found or not. */
    readonly paths: ReadonlySet<string>;
    /** Each directory it listed. */
    readonly listed: ReadonlySet<string>;
    /** The paths it asked about that were not there (an answer of null, or an error): a change that makes one counts. */
    readonly absent: ReadonlySet<string>;
    /** It enumerated the namespace, wrote, or named a path it cannot name here: any change may matter. */
    readonly whole: boolean;
}
/** A recording view of a bridge, and what was asked through it so far. */
export interface RecordedLaunchFs {
    readonly view: RuntimeFsBridge;
    reads(): LaunchReads;
}
/** `bridge`, passed through, noting what each call asks about (see the header). */
export declare function recordLaunchReads(bridge: RuntimeFsBridge): RecordedLaunchFs;
/**
 * Whether the build asked about a name under one of `mountPoints` (a mount
 * other than the session's own store). A mounted backend's files change
 * where the session's barrier may not see them, so such a build serves only
 * while nothing at all has changed, as every build did before this module.
 */
export declare function readsUnderMounts(reads: LaunchReads, mountPoints: readonly string[]): boolean;
/** Whether any of `changes` (a barrier's report since the build's cursor) can change what a build that asked `reads` answers. */
export declare function readsAffectedBy(reads: LaunchReads, changes: readonly VfsInvalidatedPath[]): boolean;
//# sourceMappingURL=launch-reads.d.ts.map