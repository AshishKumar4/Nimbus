/**
 * The filesystem interface: one small required core, and optional
 * capabilities a caller probes for.
 *
 * A backend implements `VFS` over whatever it stores (SQLite, memory, a
 * container, a device). `CompositeVFS` mounts backends into one namespace.
 * Paths are absolute and normalized; a mounted backend sees paths relative
 * to its own root ('/' is the mount point itself).
 *
 * An optional capability is either there or absent, never emulated where the
 * emulation would change its meaning: a compare-and-write done as read,
 * compare, write is not atomic, and a ranged read done as a whole read of a
 * 4 GB file is not a ranged read. A caller without the capability learns
 * that (ENOTSUP) and decides.
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder();
/** Whether anything is at `path`. */
export async function exists(vfs, path) {
    return (await vfs.stat(path)) !== null;
}
/** The file as UTF-8 text. */
export async function readText(vfs, path) {
    return decoder.decode(await vfs.readFile(path));
}
/** Write `text` as UTF-8. */
export async function writeText(vfs, path, text, options) {
    await vfs.writeFile(path, encoder.encode(text), options);
}
