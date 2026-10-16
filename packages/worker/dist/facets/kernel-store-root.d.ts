/**
 * The kernel's store root, `/.nimbus`: the stores the kernel keeps in the
 * session's filesystem (images, inline wasm, the Worker Loader shim's code)
 * live under it, and are written through it only while it is the kernel's
 * own directory (uid 0, not group- or other-writable), made so if absent.
 * One check, every store's.
 */
export declare const KERNEL_STORE_ROOT = "/.nimbus";
/** A filesystem as the kernel sees it: a stat that does not follow a link (null when absent), and a mkdir. */
export interface KernelStoreFs {
    stat(path: string): {
        readonly type: string;
        readonly uid: number;
        readonly mode: number;
    } | null;
    mkdir(path: string, mode: number): void;
}
/** Make `/.nimbus` if absent, and refuse it unless it is the kernel's own directory. */
export declare function ensureKernelStoreRoot(fs: KernelStoreFs): void;
//# sourceMappingURL=kernel-store-root.d.ts.map