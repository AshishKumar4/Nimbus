/**
 * git/worktree/checkout.ts — moving the worktree and index to another commit
 * (a branch switch, a fast-forward, reset --hard), touching only what moves.
 *
 * Unforced, it is git's twoway merge (unpack-trees.c twoway_merge) of the
 * index against HEAD's tree and the target's: the paths that differ between
 * the two trees are found by comparing them (a subtree both hold with the
 * same id is never read), and only those paths, the directories a file
 * replaces and what is under them, are looked at. An entry HEAD and the
 * target agree on keeps the index and worktree as they are; one the index
 * holds as HEAD has it takes the target's, if the worktree still matches the
 * index (verify_uptodate); anything else refuses as a local change. A path
 * git does not track may be overwritten only if ignored (verify_absent), and
 * a directory a file replaces may go only if all that is untracked in it is
 * ignored (verify_clean_subdirectory). Forced (reset --hard) it is a oneway
 * merge: the paths where the index or the worktree differ from the target
 * take the target's, and untracked paths in its way go.
 *
 * Refusals are reported together, as git reports them, before anything is
 * written. Then files go, directories go (deepest first), directories come,
 * files come, and the index is written once.
 */

import { DirCache, S_IFGITLINK, S_IFMT, comparePaths, type IndexEdit, type NewEntry } from './dircache.js';
import type { Excludes } from './excludes.js';
import { diffTrees, type Leaf, type ObjectStore } from './tree.js';
import { walkTreeAndIndex } from './status.js';
import { compareEntry, scanWorktree, type Worktree, type WorktreeStat } from './walk.js';

/** The worktree writes a checkout makes, at absolute paths (createGitFs's checkout rules). */
export interface CheckoutWriter {
  writeFile(path: string, data: Uint8Array): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
}

/** What a refused checkout names, by git's kinds. */
export interface Refusal {
  local: string[];
  directories: string[];
  untracked: string[];
}

export class CheckoutRefused extends Error {
  constructor(readonly refusal: Refusal) {
    super('checkout refused');
  }
}

export interface SwitchContext {
  store: ObjectStore;
  tree: Worktree;
  dc: DirCache;
  excludes: Excludes;
  /** The worktree's top, absolute. */
  root: string;
  writer: CheckoutWriter;
}

type Kind = 'blob' | 'tree' | 'commit' | null;
type Op =
  | { method: 'delete' | 'delete-index' | 'rmdir' | 'rmdir-index' | 'mkdir'; path: string }
  | { method: 'update-blob-to-tree'; path: string; present: boolean }
  | { method: 'create' | 'update' | 'update-dir-to-blob' | 'mkdir-index'; path: string; oid: string; mode: number };

/** A small binary heap of paths in git's order: parents come out before what is below them. */
class PathQueue {
  private readonly heap: string[] = [];
  private readonly seen = new Set<string>();

  push(path: string): void {
    if (this.seen.has(path)) return;
    this.seen.add(path);
    const heap = this.heap;
    heap.push(path);
    for (let i = heap.length - 1; i > 0;) {
      const parent = (i - 1) >> 1;
      if (comparePaths(heap[parent], heap[i]) <= 0) break;
      [heap[parent], heap[i]] = [heap[i], heap[parent]];
      i = parent;
    }
  }

  pop(): string | undefined {
    const heap = this.heap;
    const top = heap[0];
    const last = heap.pop();
    if (heap.length && last !== undefined) {
      heap[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let least = i;
        if (l < heap.length && comparePaths(heap[l], heap[least]) < 0) least = l;
        if (r < heap.length && comparePaths(heap[r], heap[least]) < 0) least = r;
        if (least === i) break;
        [heap[least], heap[i]] = [heap[i], heap[least]];
        i = least;
      }
    }
    return top;
  }
}

const kindOfMode = (mode: number): Kind => ((mode & S_IFMT) === S_IFGITLINK ? 'commit' : 'blob');
const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));

/**
 * Move the worktree from `head` (a tree; null when forced or unborn) to
 * `target` (a tree), and answer the index edit that goes with it. Throws
 * CheckoutRefused, having written nothing, when git would refuse.
 */
export async function switchTrees(ctx: SwitchContext, head: string | null, target: string, force: boolean): Promise<IndexEdit> {
  const { store, tree, dc, excludes, root, writer } = ctx;
  /** What the target holds at a path, and HEAD's leaf there (the trees differ at it). */
  const targetAt = new Map<string, Leaf | 'tree' | null>();
  const headAt = new Map<string, Leaf>();
  const queue = new PathQueue();

  // Every leading directory of a target leaf is a tree in the target.
  const targetDirs = (path: string) => {
    for (let dir = parentOf(path); dir; dir = parentOf(dir)) {
      if (targetAt.get(dir) === 'tree') break;
      targetAt.set(dir, 'tree');
      queue.push(dir);
    }
  };
  if (!force && head !== null) {
    await diffTrees(store, head, target, async (path, before, after) => {
      targetAt.set(path, after);
      if (before) headAt.set(path, before);
      queue.push(path);
      if (after) targetDirs(path);
    });
  } else {
    // Oneway: every path where the index differs from the target, then every one the worktree changed.
    await walkTreeAndIndex(store, target, dc, [], (path, leaf, lo, hi) => {
      const entry = hi - lo === 1 && dc.stage(lo) === 0 ? lo : -1;
      if (leaf && entry >= 0 && leaf.oid === dc.oid(entry) && leaf.mode === dc.mode(entry)) return;
      targetAt.set(path, leaf);
      queue.push(path);
      if (leaf) targetDirs(path);
    });
    const scan = await scanWorktree(tree, dc, { untracked: 'no', excludes: null });
    for (const i of scan.dirty.keys()) {
      const path = dc.path(i);
      // The index agrees with the target here (or the walk above said otherwise): the target holds the index's entry.
      if (!targetAt.has(path)) targetAt.set(path, { path, mode: dc.mode(i), oid: dc.oid(i) });
      queue.push(path);
    }
  }

  // The worktree's view of a path, as a walk from the top sees it: nothing below a link or a file.
  const leading = new Map<string, boolean>();
  const reachable = async (path: string): Promise<boolean> => {
    const dir = parentOf(path);
    if (!dir) return true;
    let real = leading.get(dir);
    if (real === undefined) {
      real = await reachable(dir) && (await tree.fs.lstat(dir))?.type === 'directory';
      leading.set(dir, real);
    }
    return real;
  };
  const lstat = async (path: string): Promise<WorktreeStat | null> =>
    (await reachable(path)) ? await tree.fs.lstat(path) : null;

  const ops: Op[] = [];
  const refusal: Refusal = { local: [], directories: [], untracked: [] };
  const replaced = new Set<string>();
  const replacedAncestor = (path: string): string | null => {
    for (let dir = parentOf(path); dir; dir = parentOf(dir)) if (replaced.has(dir)) return dir;
    return null;
  };
  // A directory a file replaces: what the index and the worktree hold below it is looked at too.
  const replace = async (path: string) => {
    replaced.add(path);
    const [lo, hi] = dc.rangeUnder(path);
    for (let i = lo; i < hi; i++) queue.push(dc.path(i));
    const below = async (dir: string): Promise<void> => {
      for (const { name, type } of await tree.fs.list(dir)) {
        const child = `${dir}/${name}`;
        queue.push(child);
        if (type === 'directory') await below(child);
      }
    };
    if ((await lstat(path))?.type === 'directory') await below(path);
  };

  for (let path = queue.pop(); path !== undefined; path = queue.pop()) {
    const target = targetAt.get(path) ?? null;
    const commitType: Kind = target === null ? null : target === 'tree' ? 'tree' : kindOfMode(target.mode);
    const at = dc.find(path);
    const entry = at >= 0 && dc.stage(at) === 0 ? at : -1;
    const [below, belowEnd] = dc.rangeUnder(path);
    const stageType: Kind = entry >= 0 ? kindOfMode(dc.mode(entry)) : belowEnd > below ? 'tree' : null;
    const st = await lstat(path);
    const workType: Kind = st === null ? null : st.type === 'directory' ? 'tree' : 'blob';
    const oldBlob = force ? undefined : headAt.get(path);
    const leaf = target !== null && target !== 'tree' ? target : null;
    const sameAsIndex = (other: Leaf) => entry >= 0 && dc.oid(entry) === other.oid && dc.mode(entry) === other.mode;
    // verify_uptodate: the worktree holds what the index says, or nothing.
    const upToDate = async () => st === null || (st.type !== 'directory' && await compareEntry(tree, dc, entry, path, st) === null);
    const write = (method: 'create' | 'update' | 'update-dir-to-blob') => ops.push({ method, path, oid: leaf!.oid, mode: leaf!.mode });
    const ignored = async () => await excludes.isExcluded(path, workType === 'tree');

    if (commitType === 'commit') {
      // A submodule: its gitlink is indexed, its contents never touched.
      if (workType === 'blob') refusal.untracked.push(path);
      else ops.push({ method: 'mkdir-index', path, oid: leaf!.oid, mode: leaf!.mode });
      continue;
    }
    if (stageType === 'commit') {
      ops.push({ method: 'rmdir-index', path });
      continue;
    }
    if (stageType === 'tree') {
      if (commitType === 'tree') continue;
      if (commitType === null) {
        ops.push({ method: workType === 'tree' ? 'rmdir' : 'rmdir-index', path });
        continue;
      }
      if (!force && oldBlob) {
        if (!(oldBlob.oid === leaf!.oid && oldBlob.mode === leaf!.mode)) refusal.local.push(path);
        continue;
      }
      if (workType === 'blob') {
        if (force) write('update');
        else refusal.local.push(path);
        continue;
      }
      await replace(path);
      write('update-dir-to-blob');
      continue;
    }
    if (stageType === 'blob') {
      const unchangedSinceHead = oldBlob !== undefined && sameAsIndex(oldBlob);
      if (commitType === 'blob') {
        if (force) {
          if (workType === 'tree') {
            await replace(path);
            write('update-dir-to-blob');
          } else if (!(st && sameAsIndex(leaf!) && await upToDate())) {
            write('update');
          }
          continue;
        }
        if (sameAsIndex(leaf!) || (oldBlob && oldBlob.oid === leaf!.oid && oldBlob.mode === leaf!.mode)) continue;
        if (unchangedSinceHead && await upToDate()) write('update');
        else refusal.local.push(path);
        continue;
      }
      if (commitType === 'tree') {
        if (force) ops.push({ method: 'update-blob-to-tree', path, present: workType === 'blob' });
        else if (unchangedSinceHead && await upToDate()) ops.push({ method: 'update-blob-to-tree', path, present: st !== null });
        else refusal.local.push(path);
        continue;
      }
      if (force) {
        ops.push({ method: workType === 'blob' ? 'delete' : 'delete-index', path });
        continue;
      }
      if (!oldBlob) {
        // Added to the index since HEAD: it stays, so the directory it is in cannot be replaced.
        if (replacedAncestor(path)) refusal.local.push(path);
        continue;
      }
      if (unchangedSinceHead && await upToDate()) ops.push({ method: st ? 'delete' : 'delete-index', path });
      else refusal.local.push(path);
      continue;
    }
    // Not in the index.
    if (commitType === null) {
      const owner = workType && replacedAncestor(path);
      if (!owner) continue;
      if (workType === 'tree') ops.push({ method: 'rmdir', path });
      else if (force || await ignored()) ops.push({ method: 'delete', path });
      else refusal.directories.push(owner);
      continue;
    }
    if (commitType === 'tree') {
      if (workType === null) ops.push({ method: 'mkdir', path });
      else if (workType === 'blob') {
        if (force || await ignored()) ops.push({ method: 'update-blob-to-tree', path, present: true });
        else refusal.untracked.push(path);
      }
      continue;
    }
    // The target has a file or link here and the index does not.
    if (oldBlob) {
      // Its deletion is staged: it stays deleted unless the target changes it.
      if (!(oldBlob.oid === leaf!.oid && oldBlob.mode === leaf!.mode)) refusal.local.push(path);
      continue;
    }
    if (workType === null) write('create');
    else if (workType === 'tree') {
      await replace(path);
      write('update-dir-to-blob');
    } else if (force || await ignored()) write('update');
    else refusal.untracked.push(path);
  }

  if (refusal.local.length + refusal.directories.length + refusal.untracked.length > 0) {
    throw new CheckoutRefused({
      local: [...new Set(refusal.local)],
      directories: [...new Set(refusal.directories)],
      untracked: [...new Set(refusal.untracked)],
    });
  }

  const removed = new Set<number>();
  const unindex = (path: string) => {
    const at = dc.find(path);
    if (at >= 0) {
      for (let i = at; i < dc.count && dc.path(i) === path; i++) removed.add(i);
      return;
    }
    const [lo, hi] = dc.rangeUnder(path);
    for (let i = lo; i < hi; i++) removed.add(i);
  };
  const file = (path: string) => `${root}/${path}`;
  for (const op of ops) {
    if (op.method !== 'delete' && op.method !== 'delete-index' && op.method !== 'update-blob-to-tree') continue;
    if (op.method === 'delete' || (op.method === 'update-blob-to-tree' && op.present)) await writer.unlink(file(op.path));
    unindex(op.path);
  }
  // A directory goes after what is in it: deepest first.
  const directories = ops.filter((op) => op.method === 'rmdir' || op.method === 'rmdir-index' || op.method === 'update-dir-to-blob');
  directories.sort((a, b) => comparePaths(b.path, a.path));
  for (const op of directories) {
    try {
      if (op.method !== 'rmdir-index') await writer.rmdir(file(op.path));
      unindex(op.path);
    } catch (error) {
      // A directory that still holds untracked files stays, as rmdir(2) leaves it.
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOTEMPTY' && op.method !== 'update-dir-to-blob')) throw error;
    }
  }
  for (const op of ops) {
    if (op.method === 'mkdir' || op.method === 'mkdir-index' || op.method === 'update-blob-to-tree') await writer.mkdir(file(op.path));
  }
  const added: NewEntry[] = [];
  for (const op of ops) {
    if (op.method !== 'create' && op.method !== 'update' && op.method !== 'update-dir-to-blob' && op.method !== 'mkdir-index') continue;
    if (op.method !== 'mkdir-index') {
      const { data } = await store.read(op.oid);
      if (op.mode === 0o120000) {
        await writer.symlink(new TextDecoder().decode(data), file(op.path));
      } else {
        await writer.writeFile(file(op.path), data);
        await writer.chmod(file(op.path), op.mode === 0o100755 ? 0o755 : 0o644);
      }
    }
    added.push({ path: op.path, mode: op.mode, oid: op.oid, stat: await tree.fs.lstat(op.path) });
  }
  return { removed, added };
}
