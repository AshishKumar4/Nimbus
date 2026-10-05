/**
 * git/worktree/status.ts — `git status`'s short and porcelain v1 forms
 * (wt-status.c), from the tree walk, the index and the worktree walk.
 *
 * HEAD's tree against the index gives the first column (diff-index --cached,
 * renames found among its adds and deletes), the worktree walk the second
 * (diff-files) and the untracked list. Only changed paths are held, sorted
 * once at the end as git's string lists sort them.
 */

import { detectRenames, quotePath, type QueuedPair } from '../unified-diff.js';
import { DirCache, comparePaths, compareBytes, S_IFMT } from './dircache.js';
import { Peekable, treeLeaves, type Leaf, type ObjectStore } from './tree.js';
import { scanWorktree, type ScanOptions, type Worktree } from './walk.js';

const encoder = new TextEncoder();

/** Whether `path` is one of `specs` or below one; no specs is everything. */
export function inSpecs(specs: readonly string[], path: string): boolean {
  return specs.length === 0 || specs.some((spec) => spec === '' || path === spec || path.startsWith(`${spec}/`));
}

/** Whether directory `dir` holds one of `specs`, so a walk enters it on the way. */
export function holdsSpec(specs: readonly string[], dir: string): boolean {
  return specs.some((spec) => spec.startsWith(`${dir}/`));
}

/**
 * diff-index --cached: the leaves of `tree` against the index's entries, in
 * path order. `visit` gets each path where either has something: the leaf
 * (or null) and the index entries [lo, hi) at that path (lo === hi for none;
 * more than one, or a stage, for an unmerged path). Unchanged paths are
 * visited too; the caller compares.
 */
export async function walkTreeAndIndex(
  store: ObjectStore,
  tree: string,
  dc: DirCache,
  specs: readonly string[],
  visit: (path: string, leaf: Leaf | null, lo: number, hi: number) => Promise<void> | void,
): Promise<void> {
  const leaves = new Peekable(treeLeaves(store, tree, '', (dir) => inSpecs(specs, dir) || holdsSpec(specs, dir)));
  let i = 0;
  let leafKey: Uint8Array | null = null;
  for (;;) {
    while (i < dc.count && specs.length && !inSpecs(specs, dc.path(i))) i++;
    const leaf = await leaves.peek();
    if (leaf !== null && !inSpecs(specs, leaf.path)) {
      await leaves.take();
      continue;
    }
    if (leaf === null && i >= dc.count) return;
    if (leaf !== null) leafKey ??= encoder.encode(leaf.path);
    const order = leaf === null ? 1 : i >= dc.count ? -1 : compareBytes(leafKey!, dc.pathBytes(i));
    let lo = i;
    let hi = i;
    if (order >= 0) {
      const key = dc.pathBytes(i);
      while (hi < dc.count && compareBytes(dc.pathBytes(hi), key) === 0) hi++;
      i = hi;
    } else {
      lo = hi = i;
    }
    if (order <= 0) {
      await leaves.take();
      leafKey = null;
    }
    await visit(order > 0 ? dc.path(lo) : leaf!.path, order > 0 ? null : leaf, lo, hi);
  }
}

/** One path's line: its two columns (or its unmerged code) and, for a rename, where it came from. */
export interface StatusChange {
  path: string;
  index: string;
  worktree: string;
  from?: string;
  /** DD, AU, UD, UA, DU, AA or UU. */
  unmerged?: string;
}

export interface StatusOptions {
  specs: readonly string[];
  untracked: ScanOptions['untracked'];
  excludes: ScanOptions['excludes'];
  renames: boolean;
}

const UNMERGED = ['', 'DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'];
const S_IFTYPE_CHANGE = (a: number, b: number) => (a & S_IFMT) !== (b & S_IFMT);

/** wt_status_collect: every changed path, then the untracked ones, each list in git's order. */
export async function collectStatus(
  store: ObjectStore,
  tree: Worktree,
  dc: DirCache,
  head: string,
  options: StatusOptions,
): Promise<{ changes: StatusChange[]; untracked: string[] }> {
  const changes = new Map<string, StatusChange>();
  const change = (path: string) => {
    let found = changes.get(path);
    if (!found) changes.set(path, found = { path, index: ' ', worktree: ' ' });
    return found;
  };
  // diff-index --cached HEAD, adds and deletes queued for rename detection.
  const queue: QueuedPair<{ path: string; oid: string; mode: number }>[] = [];
  await walkTreeAndIndex(store, head, dc, options.specs, (path, leaf, lo, hi) => {
    if (hi - lo > 1 || (hi > lo && dc.stage(lo) !== 0)) {
      let mask = 0;
      for (let i = lo; i < hi; i++) if (dc.stage(i)) mask |= 1 << (dc.stage(i) - 1);
      change(path).unmerged = UNMERGED[mask];
      return;
    }
    const entry = hi > lo && !dc.intentToAdd(lo) ? { path, oid: dc.oid(lo), mode: dc.mode(lo) } : null;
    if (leaf && entry && leaf.oid === entry.oid && leaf.mode === entry.mode) return;
    if (leaf && entry) {
      change(path).index = S_IFTYPE_CHANGE(leaf.mode, entry.mode) ? 'T' : 'M';
      return;
    }
    if (leaf || entry) queue.push({ one: leaf, two: entry });
  });
  const { queue: paired } = options.renames && queue.length > 1
    ? await detectRenames(queue, async (side) => (await store.read(side.oid)).data)
    : { queue };
  for (const pair of paired) {
    if (pair.one && pair.two) {
      const found = change(pair.two.path);
      found.index = 'R';
      found.from = pair.one.path;
    } else if (pair.two) {
      change(pair.two.path).index = 'A';
    } else {
      change(pair.one!.path).index = 'D';
    }
  }
  // diff-files, and the untracked files.
  const scan = await scanWorktree(tree, dc, { specs: options.specs, untracked: options.untracked, excludes: options.excludes });
  for (const [i, dirty] of scan.dirty) change(dc.path(i)).worktree = dirty.change;
  return {
    changes: [...changes.values()].sort((a, b) => comparePaths(a.path, b.path)),
    untracked: scan.untracked.sort(comparePaths),
  };
}

/**
 * path.c relative_path: `path` as seen from `prefix` (which ends in '/'),
 * climbing with '../'; './' for the prefix itself.
 */
export function relativePath(path: string, prefix: string): string {
  if (!path) return './';
  if (!prefix) return path;
  let i = 0;
  let j = 0;
  let prefixOff = 0;
  let inOff = 0;
  while (i < prefix.length && j < path.length && prefix[i] === path[j]) {
    if (prefix[i] === '/') {
      while (prefix[i] === '/') i++;
      while (path[j] === '/') j++;
      prefixOff = i;
      inOff = j;
    } else {
      i++;
      j++;
    }
  }
  if (i >= prefix.length && prefixOff < prefix.length) {
    if (j >= path.length) inOff = path.length;
    else if (path[j] === '/') {
      while (path[j] === '/') j++;
      inOff = j;
    } else {
      i = prefixOff;
    }
  } else if (j >= path.length && inOff < path.length && prefix[i] === '/') {
    while (prefix[i] === '/') i++;
    inOff = path.length;
  }
  const rest = path.slice(inOff);
  if (i >= prefix.length) return rest || './';
  let out = '';
  while (i < prefix.length) {
    if (prefix[i] === '/') {
      out += '../';
      while (prefix[i] === '/') i++;
      continue;
    }
    i++;
  }
  if (prefix[prefix.length - 1] !== '/') out += '../';
  return out + rest;
}

/** quote_path with QUOTE_PATH_QUOTE_SP: C-quoted when a byte needs it, and quoted whole when it holds a space. */
function statusQuote(path: string): string {
  const quoted = quotePath(path);
  return quoted[0] !== '"' && path.includes(' ') ? `"${quoted}"` : quoted;
}

/**
 * wt_shortstatus_print as a binary string. `prefix` (the cwd below the top,
 * ending in '/', or '') makes paths relative, as short status does and
 * porcelain does not; `z` ends entries with NUL and prints paths as they are.
 */
export function formatShortStatus(
  status: { changes: readonly StatusChange[]; untracked: readonly string[] },
  { prefix, z }: { prefix: string; z: boolean },
): string {
  const bin = (path: string) => String.fromCharCode(...encoder.encode(path));
  const show = (path: string) => (z ? bin(path) : statusQuote(relativePath(path, prefix)));
  const end = z ? '\0' : '\n';
  let out = '';
  for (const entry of status.changes) {
    if (entry.unmerged) {
      out += `${entry.unmerged} ${show(entry.path)}${end}`;
    } else if (z) {
      out += `${entry.index}${entry.worktree} ${show(entry.path)}\0${entry.from === undefined ? '' : `${show(entry.from)}\0`}`;
    } else {
      out += `${entry.index}${entry.worktree} ${entry.from === undefined ? '' : `${show(entry.from)} -> `}${show(entry.path)}\n`;
    }
  }
  for (const path of status.untracked) out += `?? ${show(path)}${end}`;
  return out;
}
