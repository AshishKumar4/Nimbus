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
export declare const SESSION_KERNEL_ROOTS: readonly string[];
/**
 * Whether `key`, its entry or with `listing` its names, is clear of every
 * root in `roots`: nothing at or under one is, nor the names of a directory
 * above one (they include the root's own). The engine asks it of the
 * session's stores (SESSION_KERNEL_ROOTS) on each write that meets a read
 * lease, so it allocates nothing.
 */
export declare function readLeaseCovers(key: string, listing: boolean, roots: readonly string[]): boolean;
//# sourceMappingURL=read-lease-cover.d.ts.map