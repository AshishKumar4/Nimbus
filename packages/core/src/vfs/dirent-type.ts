/**
 * A file's exact type, as readdir's d_type names it, with its st_mode format
 * bits (S_IFMT) and the Node predicate that holds for it: the one table every
 * consumer turns one into another by (find, Node's Dirent in the substrate,
 * and the Worker's Node shim, which embeds it).
 */

import type { RuntimeDirentType, RuntimeFileType } from '../runtime/os-contracts.js';
import { S_IFMT, type Awaitable } from './vfs.js';

/** Every dirent type but 'unknown': what an entry is once readdir, or a stat, has said. */
export type KnownDirentType = Exclude<RuntimeDirentType, 'unknown'>;

/** Node's predicate, on a Dirent or a Stats, for one type. */
export type NodeTypePredicate =
  | 'isFile' | 'isDirectory' | 'isSymbolicLink' | 'isCharacterDevice' | 'isBlockDevice' | 'isFIFO' | 'isSocket';

export const DIRENT_TYPES: Readonly<Record<KnownDirentType, { readonly format: number; readonly node: NodeTypePredicate }>> = {
  file: { format: 0o100000, node: 'isFile' },
  directory: { format: 0o040000, node: 'isDirectory' },
  symlink: { format: 0o120000, node: 'isSymbolicLink' },
  character: { format: 0o020000, node: 'isCharacterDevice' },
  block: { format: 0o060000, node: 'isBlockDevice' },
  fifo: { format: 0o010000, node: 'isFIFO' },
  socket: { format: 0o140000, node: 'isSocket' },
};

const KNOWN_DIRENT_TYPES: readonly KnownDirentType[] = ['file', 'directory', 'symlink', 'character', 'block', 'fifo', 'socket'];

/**
 * The type a stat names: its mode's format bits where the backend sets them
 * (a device's do), its coarse type where the mode holds only permissions.
 */
export function direntTypeOfStat(stat: { readonly mode?: number; readonly type: RuntimeFileType }): KnownDirentType {
  const format = (stat.mode ?? 0) & S_IFMT;
  return KNOWN_DIRENT_TYPES.find((type) => DIRENT_TYPES[type].format === format) ?? stat.type;
}

/** What a stat says of a file's type: its coarse type, and its mode where the backend gives one. */
type TypedStat = { readonly mode?: number; readonly type: RuntimeFileType };

/**
 * An entry's exact type, as a caller of readdir(3) learns it: what d_type
 * says, and for an entry its backend could not type (DT_UNKNOWN), the stat
 * the listing bundled with it, else what `lstat` says. Null when the entry
 * has gone since the listing.
 */
export async function direntTypeOf(
  entry: { readonly type: RuntimeDirentType; readonly stat?: TypedStat },
  lstat: () => Awaitable<TypedStat | null>,
): Promise<KnownDirentType | null> {
  if (entry.type !== 'unknown') return entry.type;
  const stat = entry.stat ?? await lstat();
  return stat === null ? null : direntTypeOfStat(stat);
}

/** direntTypeOf for an entry of directory `dir`, lstat'ing it on `fs` when it must. */
export function direntTypeIn(
  fs: { stat(path: string, options?: { follow?: boolean }): Awaitable<TypedStat | null> },
  dir: string,
  entry: { readonly name: string; readonly type: RuntimeDirentType; readonly stat?: TypedStat },
): Promise<KnownDirentType | null> {
  return direntTypeOf(entry, () => fs.stat(dir === '/' ? `/${entry.name}` : `${dir}/${entry.name}`, { follow: false }));
}
