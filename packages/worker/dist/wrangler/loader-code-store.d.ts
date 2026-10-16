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
    readonly code: 'ENOSPC' | 'EPERM' | 'ENOENT' | 'EINVAL';
    readonly name = "LoaderStoreRefusal";
    constructor(message: string, code: 'ENOSPC' | 'EPERM' | 'ENOENT' | 'EINVAL');
}
/** The registry of `ctx`'s incarnation, over its filesystem `engine`. */
export declare function loaderCodeRegistry(ctx: object, engine: SqliteVFS): LoaderCodeRegistry;
export declare class LoaderCodeRegistry {
    private readonly engine;
    private readonly owners;
    /** Per (wrangler, binding): its reuse source's token. */
    private readonly sources;
    /** Directories queued for removal, by path, with their bytes until removed. */
    private readonly removing;
    private storeBytes;
    private removals;
    private rootChecked;
    constructor(engine: SqliteVFS);
    /** A new owner, staged, for `binding` of the build of wrangler `wranglerId`: its token. */
    mint(wranglerId: string, binding: string): string;
    /**
     * A build of wrangler `wranglerId` committed with `tokens`: they are its
     * bindings' owners now, each binding's previous one its reuse source, and
     * a reuse source before that queued for removal. Synchronous.
     */
    commit(wranglerId: string, tokens: readonly string[]): void;
    /** `token` closed, and its directory queued for removal. Idempotent. Synchronous. */
    release(token: string): void;
    /** Every owner and reuse source of wrangler `wranglerId`, released. Synchronous. */
    stop(wranglerId: string): void;
    /** Serve a request of the shim; a token this incarnation does not hold open is refused. */
    serve(request: LoaderStoreRequest, stream?: ReadableStream<Uint8Array>): Promise<unknown>;
    /** Which of `digests` the owner holds, each it lacks but another owner or reuse source of this incarnation has adopted first. */
    private has;
    /** Another live owner's, or a reuse source's, file of `digest`: a put of it in flight there is waited for first. */
    private donor;
    /** The bytes of module `digest`, `size` long, written from `stream` and published only if they are what `digest` names. */
    private put;
    private read;
    /**
     * One new file of `owner`, admitted against the caps before `make`
     * creates it: a creation of the same digest under way is joined, and a
     * failed one gives its reservation back. A copy from `from` is in flight
     * on it too, so its removal waits for the copy.
     */
    private create;
    /** `operation`, which reads or writes `owner`'s directory: its removal waits for it. */
    private track;
    /** `token` closed, its reuse-source record dropped, its directory queued for removal once nothing reads or writes it. */
    private retire;
    /** Remove each directory `paths` names, one after another, each with the VFS's paged recursive removal. */
    private queue;
    /** The store's credentialed view, its directory made and checked first. */
    private storeFs;
    /** The store's view, with `owner`'s directory made at its first use. */
    private ownerFs;
    private size;
}
//# sourceMappingURL=loader-code-store.d.ts.map