/**
 * The kernel's store root, `/.nimbus`: the stores the kernel keeps in the
 * session's filesystem (images, inline wasm, the Worker Loader shim's code)
 * live under it, and are written through it only while it is the kernel's
 * own directory (uid 0, not group- or other-writable), made so if absent.
 * One check, every store's.
 */
export const KERNEL_STORE_ROOT = '/.nimbus';
/** Make `/.nimbus` if absent, and refuse it unless it is the kernel's own directory. */
export function ensureKernelStoreRoot(fs) {
    let root = fs.stat(KERNEL_STORE_ROOT);
    if (root === null) {
        fs.mkdir(KERNEL_STORE_ROOT, 0o755);
        root = fs.stat(KERNEL_STORE_ROOT);
    }
    if (root?.type !== 'directory' || root.uid !== 0 || (root.mode & 0o022) !== 0) {
        throw new Error(`Nimbus: ${KERNEL_STORE_ROOT} is not the kernel's own directory (a ${root?.type ?? 'missing entry'} owned by uid ${root?.uid}, mode ${((root?.mode ?? 0) & 0o7777).toString(8)}); its stores are not written through it`);
    }
}
