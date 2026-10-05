/**
 * git/worktree/cachetree.ts — the index's TREE extension (cache-tree.c): for
 * each directory, how many index entries it covers and, while still valid,
 * the id of the tree those entries make.
 *
 * A valid node whose id is the id of a tree being compared with the index
 * says, without reading it, that the tree and that run of entries agree: a
 * status or diff against HEAD skips the subtree. Commit writes the whole
 * tree; anything that changes an entry invalidates the nodes on its path
 * (cache_tree_invalidate_path), so the rest stays usable.
 */

import { oidFromHex, oidToHex } from '../pack/format.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface CacheTree {
  /** Index entries below this directory; -1 when the node is invalid. */
  count: number;
  /** The tree's id (hex) while valid. */
  oid: string | null;
  /** Subtrees in git's order: by name length, then name bytes (subtree_name_cmp). */
  subtrees: { name: Uint8Array; tree: CacheTree }[];
}

function subtreeOrder(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return a.length - b.length;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function findSubtree(tree: CacheTree, name: Uint8Array): number {
  let lo = 0;
  let hi = tree.subtrees.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const order = subtreeOrder(tree.subtrees[mid].name, name);
    if (order === 0) return mid;
    if (order < 0) lo = mid + 1;
    else hi = mid;
  }
  return -(lo + 1);
}

/** cache_tree_read: the extension's bytes as a tree, or null when they do not parse (git then ignores them). */
export function parseCacheTree(bytes: Uint8Array): CacheTree | null {
  let at = 0;
  const readNumber = (end: number): number | null => {
    const text = decoder.decode(bytes.subarray(at, end));
    at = end + 1;
    return /^-?\d+$/.test(text) ? Number(text) : null;
  };
  const readNode = (): CacheTree | null => {
    const nul = bytes.indexOf(0, at);
    if (nul < 0) return null;
    at = nul + 1;
    const space = bytes.indexOf(0x20, at);
    const count = space < 0 ? null : readNumber(space);
    const newline = bytes.indexOf(0x0a, at);
    const subtreeCount = count === null || newline < 0 ? null : readNumber(newline);
    if (count === null || subtreeCount === null) return null;
    let oid: string | null = null;
    if (count >= 0) {
      if (at + 20 > bytes.length) return null;
      oid = oidToHex(bytes, at);
      at += 20;
    }
    const node: CacheTree = { count, oid, subtrees: [] };
    for (let i = 0; i < subtreeCount; i++) {
      const name = bytes.slice(at, bytes.indexOf(0, at));
      const tree = readNode();
      if (tree === null) return null;
      node.subtrees.push({ name, tree });
    }
    node.subtrees.sort((a, b) => subtreeOrder(a.name, b.name));
    return node;
  };
  // The root's name is empty.
  if (bytes[0] !== 0) return null;
  return readNode();
}

/** write_one, root first: the extension's bytes. */
export function encodeCacheTree(root: CacheTree): Uint8Array {
  const parts: Uint8Array[] = [];
  const write = (name: Uint8Array, node: CacheTree) => {
    parts.push(name, encoder.encode(`\0${node.count} ${node.subtrees.length}\n`));
    if (node.count >= 0 && node.oid !== null) parts.push(oidFromHex(node.oid));
    for (const sub of node.subtrees) write(sub.name, sub.tree);
  };
  write(new Uint8Array(0), root);
  let size = 0;
  for (const part of parts) size += part.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * cache_tree_invalidate_path: every directory on `path` loses its tree id,
 * and a subtree at `path` itself goes, as git drops one a file replaces.
 */
export function invalidatePath(root: CacheTree, path: string): void {
  const parts = path.split('/');
  let node: CacheTree | undefined = root;
  for (let i = 0; node !== undefined; i++) {
    node.count = -1;
    node.oid = null;
    const at = findSubtree(node, encoder.encode(parts[i]));
    if (i === parts.length - 1) {
      if (at >= 0) node.subtrees.splice(at, 1);
      return;
    }
    node = at >= 0 ? node.subtrees[at].tree : undefined;
  }
}

/** A node's subtree `name` (null when absent): a walk's next step down. */
export function cacheSubtree(node: CacheTree | null, name: string): CacheTree | null {
  if (node === null) return null;
  const at = findSubtree(node, encoder.encode(name));
  return at < 0 ? null : node.subtrees[at].tree;
}

/** Add `name`'s node under `parent` in its place (a fresh tree being built). */
export function addSubtree(parent: CacheTree, name: string, tree: CacheTree): void {
  const bytes = encoder.encode(name);
  const at = findSubtree(parent, bytes);
  if (at >= 0) parent.subtrees[at].tree = tree;
  else parent.subtrees.splice(-(at + 1), 0, { name: bytes, tree });
}
