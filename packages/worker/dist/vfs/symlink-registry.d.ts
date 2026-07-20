/**
 * symlink-registry.ts — virtual symlink table backed by a special
 * JSON file in the SqliteVFS.
 *
 * Native symlinks now live in SqliteVFS. This registry remains the durable
 * compatibility path for symlinks created by older sessions.
 *
 * Storage: `/.nimbus-symlinks.json` with shape `{ [linkPath]: target }`.
 * The registry cache tracks the backing inode revision so direct durable
 * writes cannot leave clone destination proofs on a stale view.
 *
 * Native inodes take precedence when both representations exist.
 *
 * Loop guard: `resolveSymlinkChain` follows at most 40 hops (matches
 * POSIX SYMLOOP_MAX).
 */
import type { SqliteVFS } from './sqlite-vfs.js';
export declare const LEGACY_SYMLINK_REGISTRY_PATH = ".nimbus-symlinks.json";
export declare class SymlinkRegistry {
    private vfs;
    private view;
    private cache;
    private cacheRevision;
    constructor(vfs: SqliteVFS);
    /** Lazy-load the registry and refresh it after direct backing-file writes. */
    private load;
    /** Persist a complete registry snapshot before publishing it to readers. */
    private persist;
    /** Normalize a path to the VFS internal key convention. */
    private norm;
    /** Create or replace a symlink. Target is stored verbatim (can be
     *  absolute or relative — interpretation happens at resolve time). */
    set(linkPath: string, target: string): void;
    /** Remove a symlink. Returns true if it existed. */
    delete(linkPath: string): boolean;
    assertMutable(...paths: string[]): void;
    /** Check if `path` is registered as a symlink (no chain resolution). */
    isSymlink(path: string): boolean;
    /** Get the immediate target of a symlink. Returns null if not a symlink. */
    readlink(path: string): string | null;
    /**
     * Follow a symlink chain until we hit a non-symlink (or run out of
     * hops). Returns the resolved path (canonicalized to no-leading-slash).
     * If the chain breaks (max-hops or missing target), returns the
     * last-resolved path or null.
     *
     * `cwd` is used to resolve RELATIVE symlink targets (target without
     * leading `/`). POSIX semantics: relative targets resolve from the
     * symlink's directory, not the current cwd.
     */
    resolveChain(startPath: string): string | null;
    /** List all currently-registered symlinks (debugging / ls -la support). */
    list(): {
        link: string;
        target: string;
    }[];
    hasAtOrBelow(path: string): boolean;
}
export declare function getSymlinkRegistry(vfs: SqliteVFS): SymlinkRegistry;
//# sourceMappingURL=symlink-registry.d.ts.map