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
 * build's position, RuntimeFsBridge.acquire) leaves the build's answer as it
 * was unless it names one of them (staleReason):
 *   - a path the build asked about;
 *   - a directory above one, removed, renamed or given another mode or owner
 *     (a structural change, or a subtree's, moves what is under it);
 *   - a name made or removed in a directory the build listed, or one that
 *     changed kind (a listing answers names and kinds, not contents).
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
import type { RuntimeDirentType, RuntimeFsBridge, VfsInvalidatedPath } from '@nimbus-sh/core/runtime/os-contracts.js';
/** What a build asked the filesystem about, by the names the barrier reports (no leading or trailing slash). */
export interface LaunchReads {
    /** Each path it read, stat'ed, resolved or probed, found or not. */
    readonly paths: ReadonlySet<string>;
    /** Each directory it listed, with the names and kinds the listing answered (null: the listing failed). */
    readonly listed: ReadonlyMap<string, ReadonlyMap<string, RuntimeDirentType> | null>;
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
/**
 * What `reads` costs held, in UTF-16 bytes with a flat allowance for each
 * entry: the prefetch cache's bound prices an entry with it.
 */
export declare function launchReadsBytes(reads: LaunchReads): number;
/** The kind a name has now, as a listing names it, or null when nothing is there. */
export type KindNow = (name: string) => Promise<RuntimeDirentType | null>;
/**
 * Why `changes` (a barrier's report since the build's cursor) can change
 * what a build that asked `reads` answers, or null when none of them can.
 * `kindNow` answers what is at a name in a directory the build listed, now,
 * which says whether the listing would answer the same.
 */
export declare function staleReason(reads: LaunchReads, changes: readonly VfsInvalidatedPath[], kindNow: KindNow): Promise<string | null>;
//# sourceMappingURL=launch-reads.d.ts.map