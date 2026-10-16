import type { ModuleContent } from '@nimbus-sh/platform/worker-code.js';
import type { HostRoute } from './composition.js';
/** Where a binding's loaded Workers are kept: its session, and the owner its build minted. */
export interface LoaderStoreRef {
    readonly doId: string;
    readonly route?: HostRoute;
    readonly owner: string;
}
export type StoredKind = 'string' | 'js' | 'cjs' | 'py' | 'text' | 'json' | 'data' | 'wasm';
/** A module as the store keeps it. */
export interface StoredModule {
    readonly kind: StoredKind;
    readonly size: number;
    readonly digest: string;
    /** What re-creating it holds at its peak (loader-code-store-design-r7.md, working prices). */
    readonly missPrice: number;
    /** Its stored bytes, again, in slices of at most SLICE_UNITS units' encoding. */
    slices(): Iterable<Uint8Array>;
}
/** The most one read answers (the store's LOADER_STORE_READ_BYTES). */
export declare const STORE_READ_BYTES: number;
/**
 * What `JSON.parse(text)` makes, charged by one scan of the text with no
 * parse: 64 per object or array, 24 per member or element (its slot and
 * backing), and 16 + 2 per unit of every string, keys included. A shared
 * object JSON wrote many times is charged as many times as it is parsed.
 */
export declare function jsonParseCharge(text: string): number;
/** `content`'s stored form: its kind, size and digest, hashed slice by slice, and its working price. */
export declare function storedModule(content: ModuleContent): Promise<StoredModule>;
/** `bytes` (a whole stored module) as the content it was stored from. */
export declare function restoredModule(kind: StoredKind, bytes: Uint8Array): ModuleContent;
/** The store's requests for `ref`'s owner, through its session's host op. */
export declare function loaderStore(env: object, ref: LoaderStoreRef): {
    alive(): Promise<boolean>;
    /** Each of `modules` the owner does not hold already (or adopt from another owner), put. */
    keep(modules: readonly StoredModule[]): Promise<void>;
    /** A stored module's bytes, read in frames into one buffer, verified against its digest. */
    read(module: Pick<StoredModule, "digest" | "size">): Promise<Uint8Array>;
};
//# sourceMappingURL=loader-store-client.d.ts.map