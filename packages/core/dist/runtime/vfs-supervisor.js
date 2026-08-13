/**
 * vfs-supervisor.ts — the session's syscall capability, served in place.
 *
 * The WASI layer treats its seed as a CACHE over the session filesystem and
 * reaches the real thing through a {@link WasiSupervisorStub}. In a Durable
 * Object that stub is an RPC handle minted for a pid, because the facet is a
 * different isolate; in the caller's own isolate the filesystem is right here
 * and the credential is already on the view.
 *
 * The methods are `async` because the shim's contract is, not because anything
 * here waits. That is what makes this usable on a host with no JSPI: every
 * mutation is queued and drained OUTSIDE the guest (`__wasiDrainPersist`, which
 * a runner awaits after the program returns), so a promise there costs nothing.
 * A READ is different — its promise would have to suspend the guest mid-syscall
 * — which is why a host without parking must seed the filesystem completely and
 * never reach the read paths at all. See FacetHost.parking.
 */
/** Serve the WASI syscall surface directly from `vfs`, as its own credential. */
export function vfsSupervisor(vfs) {
    const key = (path) => path.replace(/^\/+/, '');
    return {
        async fsReadRange(vfsPath, offset, length) {
            return vfs.readRange(key(vfsPath), offset, length);
        },
        async fsRevision(root) {
            return vfs.revision(key(root));
        },
        async stat(vfsPath) {
            const path = key(vfsPath);
            if (!vfs.exists(path))
                return null;
            const stat = vfs.lstat(path);
            return {
                type: stat.type === 'directory' ? 'directory' : stat.type === 'symlink' ? 'symlink' : 'file',
                size: stat.size,
                mtime: stat.mtime,
            };
        },
        async writeFile(vfsPath, bytes) {
            const path = key(vfsPath);
            const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
            if (parent && !vfs.exists(parent))
                vfs.mkdir(parent, { recursive: true });
            vfs.writeFile(path, bytes);
        },
        async unlink(vfsPath) {
            vfs.unlink(key(vfsPath));
        },
        async mkdir(vfsPath) {
            vfs.mkdir(key(vfsPath), { recursive: true });
        },
        async rmdir(vfsPath) {
            vfs.rmdir(key(vfsPath));
        },
        async rename(from, to) {
            vfs.rename(key(from), key(to));
        },
        async symlink(target, vfsPath) {
            vfs.symlink(target, key(vfsPath));
        },
        async utimes(vfsPath, atimeMs, mtimeMs) {
            vfs.utimes(key(vfsPath), atimeMs, mtimeMs);
        },
    };
}
