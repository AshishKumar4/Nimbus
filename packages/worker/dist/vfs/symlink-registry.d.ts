/**
 * symlink-registry.ts — virtual symlink table backed by a special
 * JSON file in the SqliteVFS.
 *
 * SHELL-FOLLOWUPS-4 (2026-05-11): Real symlink support for `ln -s`
 * + `readlink`. Pre-fix `ln -s` copied the file content into a new
 * regular file; `readlink` returned empty.
 *
 * Why a registry (not VFS-schema change):
 *   - SqliteVFS schema is anti-touch for surrounding waves.
 *   - Symlinks have minimal storage requirement (path → target string).
 *   - Persistence across reconnect/eviction is automatic because the
 *     registry file lives in the same SqliteVFS that gets snapshotted.
 *
 * Storage: `/.nimbus-symlinks.json` with shape `{ [linkPath]: target }`.
 * The registry is in-memory cached on first read; writes flush back
 * to the file synchronously.
 *
 * Resolution: callers (`ls -la`, `cat`, `readlink`, `rm`) check the
 * registry FIRST before treating a path as a regular file. This
 * means symlinks transparently dereference for read but appear in
 * `ls -la` with proper `lrwxrwxrwx` mode and `-> target` suffix.
 *
 * Loop guard: `resolveSymlinkChain` follows at most 40 hops (matches
 * POSIX SYMLOOP_MAX).
 */
import type { SqliteVFS } from './sqlite-vfs.js';
export declare class SymlinkRegistry {
    private vfs;
    private cache;
    constructor(vfs: SqliteVFS);
    /** Lazy-load + memoize the registry. */
    private load;
    /** Write the cache back to the registry file. */
    private flush;
    /** Normalize a path to the VFS internal key convention. */
    private norm;
    /** Create or replace a symlink. Target is stored verbatim (can be
     *  absolute or relative — interpretation happens at resolve time). */
    set(linkPath: string, target: string): void;
    /** Remove a symlink. Returns true if it existed. */
    delete(linkPath: string): boolean;
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
}
/**
 * Return the session-wide registry for a VFS instance. The registry has an
 * in-memory cache, so all runtime surfaces that share one SqliteVFS must also
 * share the registry instance to avoid stale symlink reads.
 */
export declare function getSymlinkRegistry(vfs: SqliteVFS): SymlinkRegistry;
//# sourceMappingURL=symlink-registry.d.ts.map