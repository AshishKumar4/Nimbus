/**
 * _shared/read-lease-cover.ts — what a process's read lease vouches for, as
 * the session grants it.
 */
/**
 * The session's own stores (engine keys): a process may not hold them, so
 * the session's synchronous use of them (boot and durable images, inline
 * wasm images, staged bindings) never meets a delegation. A subtree at or
 * above one is not delegated (EPERM), and a synchronous write to one that
 * meets a read lease is held until the lease is recalled, never refused
 * (SqliteVFS.readRecallAt).
 */
export const SESSION_KERNEL_ROOTS = ['.nimbus', 'var/lib/nimbus'];
/**
 * Whether what a process knows of `key`, its entry or with `listing` its
 * names, is clear of every root in `roots`: nothing at or under one is, nor
 * the names of a directory above one (they include the root's own). Under a
 * trusted read lease a process's view answers in the session's place only
 * what is clear of the lease's `uncovered` roots (VfsAcquireResult.readLease:
 * its namespace's mount points). Asked on every lookup a view makes, so it
 * allocates nothing.
 */
export function readLeaseCovers(key, listing, roots) {
    for (const root of roots) {
        if (key.startsWith(root) && (key.length === root.length || key.charCodeAt(root.length) === 47))
            return false;
        if (listing && (key === '' || (root.startsWith(key) && root.charCodeAt(key.length) === 47)))
            return false;
    }
    return true;
}
