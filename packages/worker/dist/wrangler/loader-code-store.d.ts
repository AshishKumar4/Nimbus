import { type VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
export declare const LOADER_CODE_ROOT = "/.nimbus/loader-code";
export declare const CRED_LOADER_STORE: VfsCred;
/** The most one read answers, and the most digests one `has` asks after. */
export declare const LOADER_STORE_READ_BYTES: number;
export type LoaderStoreRequest = {
    readonly kind: 'has';
    readonly owner: string;
    readonly digests: readonly string[];
} | {
    readonly kind: 'put';
    readonly owner: string;
    readonly digest: string;
    readonly size: number;
} | {
    readonly kind: 'read';
    readonly owner: string;
    readonly digest: string;
    readonly offset: number;
    readonly length: number;
} | {
    readonly kind: 'alive';
    readonly owner: string;
};
/** A request the store refuses, by name. */
export declare class LoaderStoreRefusal extends Error {
    readonly code: 'ENOSPC' | 'EPERM' | 'ENOENT' | 'EINVAL' | 'ETIMEDOUT';
    readonly name = "LoaderStoreRefusal";
    constructor(message: string, code: 'ENOSPC' | 'EPERM' | 'ENOENT' | 'EINVAL' | 'ETIMEDOUT');
}
/** The registry of the incarnation whose filesystem is `engine`. */
export declare function loaderCodeRegistry(engine: SqliteVFS): LoaderCodeRegistry;
export declare class LoaderCodeRegistry {
    private readonly engine;
    private readonly owners;
    /** Per (wrangler, binding): its reuse source's token. */
    private readonly sources;
    /** Directories queued for removal (an owner's, or a dead incarnation's), until they are gone. */
    private readonly removing;
    /**
     * The bytes of content this incarnation's directories hold, each digest
     * counted once however many directories share it. The VFS is the only
     * inventory: a digest is held while any of this incarnation's directories
     * (an owner's, a source's, one queued for removal) has its file, and only
     * puts in flight are kept here, transiently.
     */
    private storeBytes;
    /** Puts in flight, by digest: how many, and whether the content's charge is theirs (no directory held it). */
    private readonly putting;
    private removals;
    constructor(engine: SqliteVFS);
    /** What the store holds now, for the session's diagnostics. */
    stats(): {
        owners: number;
        sources: number;
        removing: number;
        storeBytes: number;
        putting: number;
    };
    /** A new owner, staged, for `binding` of the build of wrangler `wranglerId`: its token. */
    mint(wranglerId: string, binding: string): string;
    /**
     * A build of wrangler `wranglerId` committed with `tokens`, one per binding
     * it has: they are its bindings' owners now. Each binding's previous owner
     * is its reuse source, the source before that is retired, and a binding
     * the build no longer has is retired with its source. Synchronous.
     */
    commit(wranglerId: string, tokens: readonly string[]): void;
    /** `token` closed, and its directory queued for removal. Idempotent. Synchronous. */
    release(token: string): void;
    /** Every owner and reuse source of wrangler `wranglerId`, released. Synchronous. */
    stop(wranglerId: string): void;
    /** Serve a request of the shim; a token this incarnation does not hold open is refused. Every stream it is given is consumed or cancelled. */
    serve(request: LoaderStoreRequest, stream?: ReadableStream<Uint8Array>): Promise<unknown>;
    /** Which of `digests` the owner holds, each it lacks but another owner or reuse source of this incarnation has adopted first. */
    private has;
    /** Another live owner's, or a reuse source's, file of `digest`: a put of it in flight there is waited for first (bounded by the put's own deadline). */
    private donor;
    /** The bytes of module `digest`, `size` long, written from `stream` and published only if they are what `digest` names. */
    private put;
    private read;
    /**
     * One new file of `owner`, admitted against the caps before `make`
     * creates it: a creation of the same digest under way is joined (its
     * stream then unread, cancelled by the caller), and a failed one gives its
     * reservation back. The session's cap counts content once: a put charges
     * its digest when no directory holds it and no put in flight has charged
     * it, and keeps that charge until it settles (a directory holding it then
     * keeps it counted; one that failed with nothing holding it gives it back).
     * An adoption shares its donor's charge. A copy from `from` is in flight
     * on the donor too, so its removal waits for the copy.
     */
    private create;
    /** Whether a directory of this incarnation but `except` (a live owner's, a source's, or one queued for removal) has the file of `digest`. */
    private holds;
    /** `operation`, which reads or writes `owner`'s directory: its removal waits for it. */
    private track;
    /** `token` closed, its reuse-source record dropped, its directory queued for removal once nothing reads or writes it. */
    private retire;
    /**
     * Remove `dir` once `owner`'s operations (all of them, however many come
     * after this) have drained, with the VFS's paged recursive removal. Its
     * files are listed first, and in the same synchronous step that removes it
     * each digest no other directory holds is counted no more, or, when a put
     * of it is in flight, its charge passes to that put. One that could not be
     * removed stays queued, still counted, and every queued directory is tried
     * again at each removal. A dead incarnation's directories were never
     * counted: their removal gives nothing back.
     */
    private queueRemoval;
    /** `dir`'s files: their digest and size (a flat directory, at most OWNER_FILES). */
    private files;
    /** Whether `dir` is gone. */
    private removeDir;
    /** The store's credentialed view: /.nimbus the kernel's (as every kernel store checks it), loader-code the store's own, checked at every use. */
    private storeFs;
    /** The store's view, with `owner`'s directory made at its first use. */
    private ownerFs;
    private size;
}
//# sourceMappingURL=loader-code-store.d.ts.map