/**
 * git/pack/tree-object.ts — a tree object's entries, as git's tree walk
 * decodes them (tree-walk.c decode_tree_entry): "<octal mode> <name>\0<id>"
 * each, in the tree's order.
 *
 * Every reader of a tree decodes it here, each making its own entry from the
 * entry's mode, as git's walk canonicalizes it (canon_mode), and its name and
 * id as spans of the tree's bytes, so a name is never re-encoded. A malformed
 * tree is git's error, and the decoding always ends: a tree whose last 21
 * bytes are not a NUL and an id holds no whole entry.
 */

import { OID_BYTES } from './format.js';

/** canon_mode: a file 100644 or 100755, a link, a tree, and anything else a gitlink. */
function canonMode(mode: number): number {
  switch (mode & 0o170000) {
    case 0o100000: return mode & 0o100 ? 0o100755 : 0o100644;
    case 0o120000: return 0o120000;
    case 0o040000: return 0o040000;
    default: return 0o160000;
  }
}

/**
 * A tree object's entries, in its order, each as `entry` makes it from its
 * mode, its id at tree[oidAt, oidAt + OID_BYTES) and its name at
 * tree[nameAt, nameEnd); git's error, thrown, for a malformed tree.
 */
export function decodeTree<T>(tree: Uint8Array, entry: (mode: number, oidAt: number, nameAt: number, nameEnd: number) => T): T[] {
  const entries: T[] = [];
  const end = tree.byteLength;
  // Each name ends at a NUL at or before this one, so no name or id runs past the tree.
  if (end > 0 && (end < OID_BYTES + 3 || tree[end - OID_BYTES - 1] !== 0)) throw new Error('too-short tree object');
  for (let p = 0; p < end;) {
    if (end - p < OID_BYTES + 3) throw new Error('too-short tree object');
    if (tree[p] === 0x20) throw new Error('malformed mode in tree entry');
    // git keeps 16 bits of the mode.
    let mode = 0;
    for (let c = tree[p++]; c !== 0x20; c = tree[p++]) {
      if (c < 0x30 || c > 0x37) throw new Error('malformed mode in tree entry');
      mode = ((mode << 3) | (c - 0x30)) & 0xffff;
    }
    if (tree[p] === 0) throw new Error('empty filename in tree entry');
    const nameEnd = tree.indexOf(0, p);
    entries.push(entry(canonMode(mode), nameEnd + 1, p, nameEnd));
    p = nameEnd + 1 + OID_BYTES;
  }
  return entries;
}
