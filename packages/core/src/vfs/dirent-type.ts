/**
 * A file's exact type, as readdir's d_type names it, with its st_mode format
 * bits (S_IFMT) and the Node predicate that holds for it: the one table every
 * consumer turns one into another by (find, Node's Dirent in the substrate,
 * and the Worker's Node shim, which embeds it).
 */

import type { RuntimeDirentType, RuntimeFileType } from '../runtime/os-contracts.js';
import { S_IFMT } from './vfs.js';

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
