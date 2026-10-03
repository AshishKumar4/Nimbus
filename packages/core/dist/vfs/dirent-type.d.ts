/**
 * A file's exact type, as readdir's d_type names it, with its st_mode format
 * bits (S_IFMT) and the Node predicate that holds for it: the one table every
 * consumer turns one into another by (find, Node's Dirent in the substrate,
 * and the Worker's Node shim, which embeds it).
 */
import type { RuntimeDirentType, RuntimeFileType } from '../runtime/os-contracts.js';
import { type Awaitable } from './vfs.js';
/** Every dirent type but 'unknown': what an entry is once readdir, or a stat, has said. */
export type KnownDirentType = Exclude<RuntimeDirentType, 'unknown'>;
/** Node's predicate, on a Dirent or a Stats, for one type. */
export type NodeTypePredicate = 'isFile' | 'isDirectory' | 'isSymbolicLink' | 'isCharacterDevice' | 'isBlockDevice' | 'isFIFO' | 'isSocket';
export declare const DIRENT_TYPES: Readonly<Record<KnownDirentType, {
    readonly format: number;
    readonly node: NodeTypePredicate;
}>>;
/**
 * The type a stat names: its mode's format bits where the backend sets them
 * (a device's do), its coarse type where the mode holds only permissions.
 */
export declare function direntTypeOfStat(stat: {
    readonly mode?: number;
    readonly type: RuntimeFileType;
}): KnownDirentType;
/** What a stat says of a file's type: its coarse type, and its mode where the backend gives one. */
type TypedStat = {
    readonly mode?: number;
    readonly type: RuntimeFileType;
};
/**
 * An entry's exact type, as a caller of readdir(3) learns it: what d_type
 * says, and for an entry its backend could not type (DT_UNKNOWN), the stat
 * the listing bundled with it, else what `lstat` says. Null when the entry
 * has gone since the listing.
 */
export declare function direntTypeOf(entry: {
    readonly type: RuntimeDirentType;
    readonly stat?: TypedStat;
}, lstat: () => Awaitable<TypedStat | null>): Promise<KnownDirentType | null>;
/** direntTypeOf for an entry of directory `dir`, lstat'ing it on `fs` when it must. */
export declare function direntTypeIn(fs: {
    stat(path: string, options?: {
        follow?: boolean;
    }): Awaitable<TypedStat | null>;
}, dir: string, entry: {
    readonly name: string;
    readonly type: RuntimeDirentType;
    readonly stat?: TypedStat;
}): Promise<KnownDirentType | null>;
export {};
//# sourceMappingURL=dirent-type.d.ts.map