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
 *
 * The extension stays its own bytes. Reading it builds a table of where each
 * node lies, a few integers a node and no object, as next.js has 17,000
 * directories: as objects, its cache tree was 11 MiB of heap. A walk asks
 * for one node's subtrees at a time; a write rewrites the bytes in one pass.
 */

import { oidFromHex, oidToHex } from '../pack/format.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** subtree_name_cmp: by length, then bytes. */
function subtreeOrder(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return a.length - b.length;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** A node as written: `<name>\0<count> <subtrees>\n`, the id when valid, then its subtrees. */
function nodeHeader(name: Uint8Array, count: number, subtrees: number): Uint8Array {
  const tail = encoder.encode(`\0${count} ${subtrees}\n`);
  const out = new Uint8Array(name.length + tail.length);
  out.set(name);
  out.set(tail, name.length);
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
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

/** One subtree being built: its name and its bytes as written (name first). */
export interface BuiltSubtree {
  name: Uint8Array;
  bytes: Uint8Array;
}

/**
 * A node's bytes as written: `count` -1 for an invalid node (no id), its
 * subtrees (each already written) in git's order. The root's name is ''.
 */
export function encodeNode(name: string, count: number, oid: string | null, subtrees: BuiltSubtree[]): BuiltSubtree {
  const nameBytes = encoder.encode(name);
  subtrees.sort((a, b) => subtreeOrder(a.name, b.name));
  const parts = [nodeHeader(nameBytes, count, subtrees.length)];
  if (count >= 0 && oid !== null) parts.push(oidFromHex(oid));
  for (const sub of subtrees) parts.push(sub.bytes);
  return { name: nameBytes, bytes: concat(parts) };
}

/**
 * The extension read: where each node lies, in the order written (root
 * first, each node before its subtrees).
 */
export class CacheTree {
  private constructor(
    readonly bytes: Uint8Array,
    /** Per node: where its name starts and ends, its count, where its id is (-1: invalid), its subtrees, the node after its last descendant. */
    private readonly nameAt: Int32Array,
    private readonly nameEnd: Int32Array,
    private readonly counts: Int32Array,
    private readonly oidAt: Int32Array,
    private readonly subtreeCounts: Int32Array,
    private readonly ends: Int32Array,
  ) {}

  /** cache_tree_read: the table, or null when the bytes do not parse (git then ignores them). */
  static parse(bytes: Uint8Array): CacheTree | null {
    // Every node has a name's NUL and a header's newline: at most this many.
    let most = 0;
    for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x0a) most++;
    const nameAt = new Int32Array(most);
    const nameEnd = new Int32Array(most);
    const counts = new Int32Array(most);
    const oidAt = new Int32Array(most);
    const subtreeCounts = new Int32Array(most);
    const ends = new Int32Array(most);
    let at = 0;
    let nodes = 0;
    const number = (end: number): number | null => {
      let value = 0;
      let negative = false;
      let i = at;
      if (bytes[i] === 0x2d) {
        negative = true;
        i++;
      }
      if (i >= end) return null;
      for (; i < end; i++) {
        const digit = bytes[i] - 0x30;
        if (digit < 0 || digit > 9) return null;
        value = value * 10 + digit;
      }
      at = end + 1;
      return negative ? -value : value;
    };
    const read = (): boolean => {
      const node = nodes++;
      if (node >= most) return false;
      const nul = bytes.indexOf(0, at);
      if (nul < 0) return false;
      nameAt[node] = at;
      nameEnd[node] = nul;
      at = nul + 1;
      const space = bytes.indexOf(0x20, at);
      const count = space < 0 ? null : number(space);
      const newline = bytes.indexOf(0x0a, at);
      const subtrees = count === null || newline < 0 ? null : number(newline);
      if (count === null || subtrees === null) return false;
      counts[node] = count;
      subtreeCounts[node] = subtrees;
      oidAt[node] = -1;
      if (count >= 0) {
        if (at + 20 > bytes.length) return false;
        oidAt[node] = at;
        at += 20;
      }
      for (let i = 0; i < subtrees; i++) if (!read()) return false;
      ends[node] = nodes;
      return true;
    };
    // The root's name is empty.
    if (bytes[0] !== 0 || !read() || at !== bytes.length) return null;
    const used = (table: Int32Array) => table.slice(0, nodes);
    return new CacheTree(bytes, used(nameAt), used(nameEnd), used(counts), used(oidAt), used(subtreeCounts), used(ends));
  }

  /** The root node. */
  get root(): number {
    return 0;
  }

  /** Node `node`'s entry count, -1 when it is invalid. */
  count(node: number): number {
    return this.counts[node];
  }

  /** Node `node`'s tree id while valid, else null. */
  oid(node: number): string | null {
    return this.oidAt[node] < 0 ? null : oidToHex(this.bytes, this.oidAt[node]);
  }

  /** Node `node` as written, its subtrees with it: a subtree a walk keeps whole. */
  nodeBytes(node: number): BuiltSubtree {
    const end = this.ends[node] < this.counts.length ? this.nameAt[this.ends[node]] : this.bytes.length;
    return { name: this.bytes.subarray(this.nameAt[node], this.nameEnd[node]), bytes: this.bytes.subarray(this.nameAt[node], end) };
  }

  /** Node `node`'s subtrees by name: asked for once per directory a walk enters, and dropped with it. */
  subtrees(node: number): Map<string, number> {
    const out = new Map<string, number>();
    for (let child = node + 1, i = 0; i < this.subtreeCounts[node]; i++, child = this.ends[child]) {
      out.set(decoder.decode(this.bytes.subarray(this.nameAt[child], this.nameEnd[child])), child);
    }
    return out;
  }

  private child(node: number, name: Uint8Array): number {
    for (let child = node + 1, i = 0; i < this.subtreeCounts[node]; i++, child = this.ends[child]) {
      if (subtreeOrder(this.bytes.subarray(this.nameAt[child], this.nameEnd[child]), name) === 0) return child;
    }
    return -1;
  }

  /**
   * cache_tree_invalidate_path for each of `paths`: every directory on a
   * path loses its tree id, and a subtree at the path itself goes, as git
   * drops one a file replaces. The extension rewritten, or these bytes when
   * nothing changed.
   */
  invalidate(paths: Iterable<string>): Uint8Array {
    const nodes = this.counts.length;
    const invalid = new Uint8Array(nodes);
    const removed = new Uint8Array(nodes);
    let changed = false;
    for (const path of paths) {
      const parts = path.split('/');
      let node = 0;
      for (let i = 0; i < parts.length; i++) {
        changed ||= this.counts[node] >= 0;
        invalid[node] = 1;
        const child = this.child(node, encoder.encode(parts[i]));
        if (child < 0) break;
        if (i === parts.length - 1) {
          changed = true;
          removed[child] = 1;
        }
        node = child;
      }
    }
    if (!changed) return this.bytes;
    // Written in place, into room for every count turning into "-1" (one byte more at most); an id dropped frees 20.
    const out = new Uint8Array(this.bytes.length + nodes);
    let at = 0;
    const number = (value: number) => {
      const text = String(value);
      for (let i = 0; i < text.length; i++) out[at++] = text.charCodeAt(i);
    };
    const write = (node: number): void => {
      let kept = 0;
      for (let child = node + 1, i = 0; i < this.subtreeCounts[node]; i++, child = this.ends[child]) if (!removed[child]) kept++;
      const valid = !invalid[node] && this.counts[node] >= 0;
      out.set(this.bytes.subarray(this.nameAt[node], this.nameEnd[node]), at);
      at += this.nameEnd[node] - this.nameAt[node];
      out[at++] = 0;
      number(valid ? this.counts[node] : -1);
      out[at++] = 0x20;
      number(kept);
      out[at++] = 0x0a;
      if (valid) {
        out.set(this.bytes.subarray(this.oidAt[node], this.oidAt[node] + 20), at);
        at += 20;
      }
      for (let child = node + 1, i = 0; i < this.subtreeCounts[node]; i++, child = this.ends[child]) if (!removed[child]) write(child);
    };
    write(0);
    return out.slice(0, at);
  }
}
