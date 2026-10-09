/**
 * _shared/read-lease-cover.ts — what a process's read lease vouches for, as
 * the session grants it and as a process's view answers by it.
 * scripts/bundle-facet-workers.mjs compiles this module once into
 * READ_LEASE_COVER_PREAMBLE (worker loaders/generated-workers.ts), so the
 * node shims carry it as the same text whatever toolchain evaluates them. It
 * imports nothing: a body that bundles it (the WASI instance's) takes in
 * nothing else with it.
 */
/**
 * The session's own stores (engine keys): a process may not hold them, so
 * the session's synchronous use of them (durable launch images, inline wasm
 * images, staged bindings) never meets a delegation. A subtree at or above
 * one is not delegated (EPERM).
 */
export declare const SESSION_KERNEL_ROOTS: readonly string[];
/**
 * What a process's read lease does not vouch for (engine keys): the
 * session's own stores, which its synchronous writers change without a
 * recall, and the kernel's mounts, which are not SQLite's.
 */
export declare const READ_LEASE_UNCOVERED_ROOTS: readonly string[];
/**
 * Whether what a process knows of `key`, its entry or with `listing` its
 * names, is clear of every root in `roots`: nothing at or under one is, nor
 * the names of a directory above one (they include the root's own). Under a
 * trusted read lease a process's view answers in the session's place only
 * what is clear of READ_LEASE_UNCOVERED_ROOTS, and once it has answered what
 * is not clear of SESSION_KERNEL_ROOTS (changed with no recall) it asks every
 * barrier. Asked on every lookup a view makes, so it allocates nothing.
 */
export declare function readLeaseCovers(key: string, listing: boolean, roots: readonly string[]): boolean;
//# sourceMappingURL=read-lease-cover.d.ts.map