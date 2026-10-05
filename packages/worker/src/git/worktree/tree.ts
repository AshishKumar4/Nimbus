/**
 * git/worktree/tree.ts — trees read one at a time, and written from the index.
 *
 * A tree is read when the walk reaches it and dropped when the walk leaves
 * it, so a walk holds the trees along one path. Objects come through the
 * repository's store (loose, else the ranged pack store). Writing a commit's
 * trees from the index keeps one tree open per directory level, and writes
 * only the trees no store already holds.
 */

import { oidFromHex, oidToHex } from '../pack/format.js';
import { DirCache, S_IFMT, comparePaths, decodePath } from './dircache.js';

export const S_IFDIR = 0o040000;
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** The object calls trees, commits and staging make. */
export interface ObjectStore {
  read(oid: string): Promise<{ type: string; data: Uint8Array }>;
  /** Whether the repository holds `oid`, loose or packed. */
  has(oid: string): Promise<boolean>;
  /** Write an object the repository does not hold yet; its id either way. */
  write(type: 'blob' | 'tree' | 'commit', data: Uint8Array): Promise<string>;
}

export interface TreeEntry {
  name: string;
  mode: number;
  oid: string;
}

/** A leaf below a tree: a file, a link or a gitlink, at its repo-relative path. */
export interface Leaf {
  path: string;
  mode: number;
  oid: string;
}

const encoder = new TextEncoder();

/** A tree object's entries, in the tree's own order. */
export function parseTree(data: Uint8Array): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (let at = 0; at < data.length;) {
    const space = data.indexOf(0x20, at);
    const nul = data.indexOf(0, space);
    let mode = 0;
    for (let i = at; i < space; i++) mode = mode * 8 + (data[i] - 0x30);
    entries.push({ name: decodePath(data.subarray(space + 1, nul)), mode, oid: oidToHex(data, nul + 1) });
    at = nul + 21;
  }
  return entries;
}

/** The tree a tree-ish names: a commit's, or the tree itself. */
export async function treeOf(store: ObjectStore, oid: string): Promise<string> {
  for (;;) {
    if (oid === EMPTY_TREE) return oid;
    const { type, data } = await store.read(oid);
    if (type === 'tree') return oid;
    if (type === 'commit') return new TextDecoder().decode(data.subarray(5, 45));
    if (type !== 'tag') throw new Error(`object ${oid} is a ${type}, not a tree`);
    // An annotated tag names its object on its first line.
    oid = new TextDecoder().decode(data.subarray(7, 47));
  }
}

export async function readTree(store: ObjectStore, oid: string): Promise<TreeEntry[]> {
  if (oid === EMPTY_TREE) return [];
  const { type, data } = await store.read(oid);
  if (type !== 'tree') throw new Error(`object ${oid} is a ${type}, not a tree`);
  return parseTree(data);
}

const isTree = (mode: number) => (mode & S_IFMT) === S_IFDIR;

/**
 * Every leaf below `tree` in path order (git's index order), reading a tree
 * as the walk enters it. `within` prunes: a directory is entered only when
 * it answers true for it.
 */
export async function* treeLeaves(
  store: ObjectStore,
  tree: string,
  prefix = '',
  within: (dir: string) => boolean = () => true,
): AsyncGenerator<Leaf> {
  for (const entry of await readTree(store, tree)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (isTree(entry.mode)) {
      if (within(path)) yield* treeLeaves(store, entry.oid, path, within);
    } else {
      yield { path, mode: entry.mode, oid: entry.oid };
    }
  }
}

/** A cursor over an async sequence: the next item is looked at before it is taken. */
export class Peekable<T> {
  private head: IteratorResult<T> | null = null;

  constructor(private readonly source: AsyncIterator<T>) {}

  async peek(): Promise<T | null> {
    this.head ??= await this.source.next();
    return this.head.done ? null : this.head.value;
  }

  async take(): Promise<T | null> {
    const value = await this.peek();
    this.head = null;
    return value;
  }
}

/** git's tree order: a directory sorts as its name with a '/' after it. */
function treeKey(entry: TreeEntry): string {
  return isTree(entry.mode) ? `${entry.name}/` : entry.name;
}

/**
 * diff-tree -r of two trees (null for none): `visit` gets every leaf path
 * whose entry differs, with each side's leaf or null. A subtree both sides
 * hold with the same id is never read.
 */
export async function diffTrees(
  store: ObjectStore,
  from: string | null,
  to: string | null,
  visit: (path: string, before: Leaf | null, after: Leaf | null) => Promise<void>,
  prefix = '',
): Promise<void> {
  if (from === to) return;
  const before = from === null ? [] : await readTree(store, from);
  const after = to === null ? [] : await readTree(store, to);
  const join = (name: string) => (prefix ? `${prefix}/${name}` : name);
  const leaf = (entry: TreeEntry) => ({ path: join(entry.name), mode: entry.mode, oid: entry.oid });
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    const a = before[i];
    const b = after[j];
    const order = a === undefined ? 1 : b === undefined ? -1 : comparePaths(treeKey(a), treeKey(b));
    if (order === 0) {
      i++;
      j++;
      if (a.oid === b.oid && a.mode === b.mode) continue;
      if (isTree(a.mode)) await diffTrees(store, a.oid, b.oid, visit, join(a.name));
      else await visit(join(a.name), leaf(a), leaf(b));
      continue;
    }
    // Same name, a tree on one side and a leaf on the other, sort apart: each is its own change.
    if (order < 0) {
      i++;
      if (isTree(a.mode)) await diffTrees(store, a.oid, null, visit, join(a.name));
      else await visit(join(a.name), leaf(a), null);
    } else {
      j++;
      if (isTree(b.mode)) await diffTrees(store, null, b.oid, visit, join(b.name));
      else await visit(join(b.name), null, leaf(b));
    }
  }
}

/** One open directory of the tree being written: its entries so far, encoded. */
interface Frame {
  dir: string;
  parts: Uint8Array[];
}

function treeLine(mode: number, name: string, oid: Uint8Array): Uint8Array {
  const head = encoder.encode(`${mode.toString(8)} ${name}\0`);
  const out = new Uint8Array(head.length + 20);
  out.set(head);
  out.set(oid, head.length);
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

/**
 * write-tree: the index's stage-0 entries as trees, root first in the
 * returned id. Entries come in index order, which within one directory is
 * tree order, so each tree is complete the moment the walk leaves it.
 */
export async function writeTreeFromIndex(store: ObjectStore, dc: DirCache): Promise<string> {
  const frames: Frame[] = [{ dir: '', parts: [] }];
  const close = async (): Promise<void> => {
    const frame = frames.pop()!;
    const oid = await store.write('tree', concat(frame.parts));
    const parent = frames[frames.length - 1];
    parent.parts.push(treeLine(S_IFDIR, frame.dir.slice(parent.dir ? parent.dir.length + 1 : 0), oidFromHex(oid)));
  };
  for (let i = 0; i < dc.count; i++) {
    if (dc.stage(i) !== 0 || dc.intentToAdd(i)) continue;
    const path = dc.path(i);
    const cut = path.lastIndexOf('/');
    const dir = cut < 0 ? '' : path.slice(0, cut);
    while (frames.length > 1 && dir !== frames[frames.length - 1].dir && !dir.startsWith(`${frames[frames.length - 1].dir}/`)) {
      await close();
    }
    for (let top = frames[frames.length - 1].dir; top !== dir;) {
      const next = dir.indexOf('/', top ? top.length + 1 : 0);
      top = next < 0 ? dir : dir.slice(0, next);
      frames.push({ dir: top, parts: [] });
    }
    frames[frames.length - 1].parts.push(treeLine(dc.mode(i), path.slice(cut + 1), dc.oidBytes(i).slice()));
  }
  while (frames.length > 1) await close();
  return await store.write('tree', concat(frames[0].parts));
}
