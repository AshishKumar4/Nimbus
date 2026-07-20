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
import { normalizeVfsPath } from './path.js';
export const LEGACY_SYMLINK_REGISTRY_PATH = '.nimbus-symlinks.json';
export class SymlinkRegistry {
    vfs;
    cache = null;
    cacheRevision = -1;
    constructor(vfs) {
        this.vfs = vfs;
    }
    /** Lazy-load the registry and refresh it after direct backing-file writes. */
    load() {
        const revision = this.vfs.revision(LEGACY_SYMLINK_REGISTRY_PATH);
        if (this.cache && this.cacheRevision === revision)
            return this.cache;
        const next = new Map();
        if (this.vfs.exists(LEGACY_SYMLINK_REGISTRY_PATH)) {
            const raw = this.vfs.readFileString(LEGACY_SYMLINK_REGISTRY_PATH);
            const parsed = JSON.parse(raw);
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                throw new Error(`[symlink-registry] invalid ${LEGACY_SYMLINK_REGISTRY_PATH}`);
            }
            for (const [link, target] of Object.entries(parsed)) {
                if (typeof target !== 'string') {
                    throw new Error(`[symlink-registry] invalid target for ${link}`);
                }
                next.set(link, target);
            }
        }
        this.cache = next;
        this.cacheRevision = revision;
        return next;
    }
    /** Persist a complete registry snapshot before publishing it to readers. */
    persist(next) {
        const obj = {};
        for (const [k, v] of next)
            obj[k] = v;
        this.vfs.writeFile(LEGACY_SYMLINK_REGISTRY_PATH, JSON.stringify(obj));
        this.cache = next;
        this.cacheRevision = this.vfs.revision(LEGACY_SYMLINK_REGISTRY_PATH);
    }
    /** Normalize a path to the VFS internal key convention. */
    norm(p) {
        return normalizeVfsPath(p);
    }
    /** Create or replace a symlink. Target is stored verbatim (can be
     *  absolute or relative — interpretation happens at resolve time). */
    set(linkPath, target) {
        this.vfs.assertMutationAllowed(linkPath);
        this.vfs.assertMutationAllowed(LEGACY_SYMLINK_REGISTRY_PATH);
        const next = new Map(this.load());
        next.set(this.norm(linkPath), target);
        this.persist(next);
    }
    /** Remove a symlink. Returns true if it existed. */
    delete(linkPath) {
        const cache = this.load();
        const normalized = this.norm(linkPath);
        if (!cache.has(normalized))
            return false;
        this.vfs.assertMutationAllowed(normalized);
        this.vfs.assertMutationAllowed(LEGACY_SYMLINK_REGISTRY_PATH);
        const next = new Map(cache);
        next.delete(normalized);
        this.persist(next);
        return true;
    }
    assertMutable(...paths) {
        for (const path of paths)
            this.vfs.assertMutationAllowed(path);
        this.vfs.assertMutationAllowed(LEGACY_SYMLINK_REGISTRY_PATH);
    }
    /** Check if `path` is registered as a symlink (no chain resolution). */
    isSymlink(path) {
        return this.load().has(this.norm(path));
    }
    /** Get the immediate target of a symlink. Returns null if not a symlink. */
    readlink(path) {
        const v = this.load().get(this.norm(path));
        return v === undefined ? null : v;
    }
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
    resolveChain(startPath) {
        let cur = this.norm(startPath);
        for (let hops = 0; hops < 40; hops++) {
            const target = this.load().get(cur);
            if (target === undefined)
                return cur; // not a symlink — done
            if (target.startsWith('/')) {
                cur = this.norm(target);
            }
            else {
                // Relative target: resolve from symlink's parent dir.
                const parent = cur.includes('/') ? cur.substring(0, cur.lastIndexOf('/')) : '';
                cur = normalizeVfsPath(`${parent}/${target}`);
            }
        }
        // ELOOP
        return null;
    }
    /** List all currently-registered symlinks (debugging / ls -la support). */
    list() {
        const out = [];
        for (const [k, v] of this.load()) {
            out.push({ link: k, target: v });
        }
        return out;
    }
    hasAtOrBelow(path) {
        const root = this.norm(path);
        for (const link of this.load().keys()) {
            if (link === root || link.startsWith(`${root}/`))
                return true;
        }
        return false;
    }
}
/**
 * Return the session-wide registry for a VFS instance. The registry has an
 * in-memory cache, so all runtime surfaces that share one SqliteVFS must also
 * share the registry instance to avoid stale symlink reads.
 */
export function getSymlinkRegistry(vfs) {
    const owner = vfs;
    if (!owner.__nimbus_symlink_registry) {
        owner.__nimbus_symlink_registry = new SymlinkRegistry(vfs);
    }
    return owner.__nimbus_symlink_registry;
}
