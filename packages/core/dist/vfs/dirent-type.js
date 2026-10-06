/**
 * A file's exact type, as readdir's d_type names it, with its st_mode format
 * bits (S_IFMT) and the Node predicate that holds for it: the one table every
 * consumer turns one into another by (find, Node's Dirent in the substrate,
 * and the Worker's Node shim, which embeds it).
 */
import { S_IFCHR, S_IFDIR, S_IFLNK, S_IFMT, S_IFREG } from './vfs.js';
export const DIRENT_TYPES = {
    file: { format: S_IFREG, node: 'isFile' },
    directory: { format: S_IFDIR, node: 'isDirectory' },
    symlink: { format: S_IFLNK, node: 'isSymbolicLink' },
    character: { format: S_IFCHR, node: 'isCharacterDevice' },
    block: { format: 0o060000, node: 'isBlockDevice' },
    fifo: { format: 0o010000, node: 'isFIFO' },
    socket: { format: 0o140000, node: 'isSocket' },
};
const KNOWN_DIRENT_TYPES = ['file', 'directory', 'symlink', 'character', 'block', 'fifo', 'socket'];
/**
 * The type a stat names: its mode's format bits where the backend sets them
 * (a device's do), its coarse type where the mode holds only permissions.
 */
export function direntTypeOfStat(stat) {
    const format = (stat.mode ?? 0) & S_IFMT;
    return KNOWN_DIRENT_TYPES.find((type) => DIRENT_TYPES[type].format === format) ?? stat.type;
}
/**
 * An entry's exact type, as a caller of readdir(3) learns it: what d_type
 * says, and for an entry its backend could not type (DT_UNKNOWN), the stat
 * the listing bundled with it, else what `lstat` says. Null when the entry
 * has gone since the listing.
 */
export async function direntTypeOf(entry, lstat) {
    if (entry.type !== 'unknown')
        return entry.type;
    const stat = entry.stat ?? await lstat();
    return stat === null ? null : direntTypeOfStat(stat);
}
/** direntTypeOf for an entry of directory `dir`, lstat'ing it on `fs` when it must. */
export function direntTypeIn(fs, dir, entry) {
    return direntTypeOf(entry, () => fs.stat(dir === '/' ? `/${entry.name}` : `${dir}/${entry.name}`, { follow: false }));
}
