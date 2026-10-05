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
import { encodeNode, type BuiltSubtree, type CacheTree } from './cachetree.js';
import { comparePaths, compareBytes, decodePath, S_IFMT, type DirCache } from './dircache.js';
import { S_IFDIR, readTree, type Leaf, type ObjectStore } from './tree.js';
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
 * path order, one directory at a time. `visit` gets each path where either
 * has something: the leaf (or null) and the index entries [lo, hi) at that
 * path (lo === hi for none; more than one, or a stage, for an unmerged
 * path). Unchanged paths are visited too; the caller compares.
 *
 * A directory the index's cache tree records as valid, with the id of the
 * tree's subtree there and as many entries as the index holds below it, is
 * the same on both sides: it is skipped, its tree never read. With `build`,
 * the walk answers the cache tree the index has against `tree` (a node for
 * every directory where the two agree, valid), for the caller to record.
 */
export async function walkTreeAndIndex(
  store: ObjectStore,
  tree: string,
  dc: DirCache,
  specs: readonly string[],
  visit: (path: string, leaf: Leaf | null, lo: number, hi: number) => Promise<void> | void,
  { cacheTree = null, build = false }: { cacheTree?: CacheTree | null; build?: boolean } = {},
): Promise<Uint8Array | null> {
  const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
  const entered = (dir: string) => inSpecs(specs, dir) || holdsSpec(specs, dir);
  /**
   * One directory: `treeOid` (null for none) against the index's [lo, hi)
   * below it, `node` its cache-tree node (-1 for none). With `build`, the
   * directory's cache-tree node as written, when it has one.
   */
  const walk = async (dir: string, treeOid: string | null, lo: number, hi: number, node: number): Promise<{ same: boolean; built: BuiltSubtree | null }> => {
    if (cacheTree !== null && node >= 0 && treeOid !== null && cacheTree.count(node) === hi - lo && cacheTree.oid(node) === treeOid) {
      return { same: true, built: build ? cacheTree.nodeBytes(node) : null };
    }
    const entries = treeOid === null ? [] : await readTree(store, treeOid);
    const subtrees = cacheTree !== null && node >= 0 ? cacheTree.subtrees(node) : null;
    const built: BuiltSubtree[] | null = build ? [] : null;
    let same = treeOid !== null;
    const skip = dir ? encoder.encode(dir).length + 1 : 0;
    let t = 0;
    let i = lo;
    while (t < entries.length || i < hi) {
      // The index's next child here: a file (its stages) or a directory (the run below it).
      let indexKey: string | null = null;
      let childEnd = i;
      let childDir = false;
      if (i < hi) {
        const rest = dc.pathBytes(i).subarray(skip);
        const slash = rest.indexOf(0x2f);
        const name = decodePath(slash < 0 ? rest : rest.subarray(0, slash));
        childDir = slash >= 0;
        if (childDir) {
          childEnd = dc.rangeUnder(join(dir, name), i, hi)[1];
        } else {
          childEnd = i + 1;
          while (childEnd < hi && dc.stage(childEnd) !== 0 && compareBytes(dc.pathBytes(childEnd), dc.pathBytes(i)) === 0) childEnd++;
        }
        indexKey = childDir ? `${name}/` : name;
      }
      const entry = t < entries.length ? entries[t] : null;
      const treeKey = entry === null ? null : (entry.mode & S_IFMT) === S_IFDIR ? `${entry.name}/` : entry.name;
      const order = treeKey === null ? 1 : indexKey === null ? -1 : comparePaths(treeKey, indexKey);
      const name = order <= 0 ? entry!.name : indexKey!.replace(/\/$/, '');
      const path = join(dir, name);
      const subtree = order <= 0 && (entry!.mode & S_IFMT) === S_IFDIR;
      const indexLo = i;
      const indexHi = order >= 0 ? childEnd : i;
      if (order <= 0) t++;
      if (order >= 0) i = childEnd;
      if (subtree || (order > 0 && childDir)) {
        if (!entered(path)) {
          same = false;
          continue;
        }
        const child = subtree && order === 0 ? subtrees?.get(name) ?? -1 : -1;
        const sub = await walk(path, subtree ? entry!.oid : null, indexLo, indexHi, child);
        same &&= sub.same && order === 0;
        if (built && sub.built) built.push(sub.built);
        continue;
      }
      const leaf = order <= 0 ? { path, mode: entry!.mode, oid: entry!.oid } : null;
      same &&= order === 0 && indexHi - indexLo === 1 && dc.stage(indexLo) === 0
        && dc.mode(indexLo) === leaf!.mode && dc.oid(indexLo) === leaf!.oid;
      if (inSpecs(specs, path)) await visit(path, leaf, indexLo, indexHi);
    }
    if (!built || (!(same && treeOid !== null) && built.length === 0)) return { same, built: null };
    const valid = same && treeOid !== null;
    return { same, built: encodeNode(dir.slice(dir.lastIndexOf('/') + 1), valid ? hi - lo : -1, valid ? treeOid : null, built) };
  };
  return (await walk('', tree, 0, dc.count, cacheTree === null ? -1 : cacheTree.root)).built?.bytes ?? null;
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
    if (!found) {
      found = { path, index: ' ', worktree: ' ' };
      changes.set(path, found);
    }
    return found;
  };
  // diff-index --cached HEAD, adds and deletes queued for rename detection.
  const queue: QueuedPair<{ path: string; oid: string; mode: number }>[] = [];
  // An index with no cache tree (one a clone or cf-git wrote) gets the one the whole tree's walk
  // answers against HEAD: kept, the next status skips what agrees. One it has is git's to keep.
  const whole = options.specs.length === 0 && dc.cacheTree() === null;
  const built = await walkTreeAndIndex(store, head, dc, options.specs, (path, leaf, lo, hi) => {
    if (hi - lo > 1 || (hi > lo && dc.stage(lo) !== 0)) {
      let mask = 0;
      for (let i = lo; i < hi; i++) if (dc.stage(i)) mask |= 1 << (dc.stage(i) - 1);
      change(path).unmerged = UNMERGED[mask];
      return;
    }
    const entry = hi > lo && !dc.intentToAdd(lo) ? { path, oid: dc.oid(lo), mode: dc.mode(lo) } : null;
    if (leaf && entry && leaf.oid === entry.oid && leaf.mode === entry.mode) return;
    if (leaf && entry) {
      change(path).index = (leaf.mode & S_IFMT) !== (entry.mode & S_IFMT) ? 'T' : 'M';
      return;
    }
    if (leaf || entry) queue.push({ one: leaf, two: entry });
  }, { cacheTree: dc.cacheTree(), build: whole });
  if (built) dc.setCacheTree(built);
  let paired = queue;
  if (options.renames && queue.some((pair) => pair.one) && queue.some((pair) => pair.two)) {
    // Rename detection reads the blobs on both sides: a partial clone fetches them in one request.
    await store.prefetch(queue.flatMap((pair) => [pair.one?.oid, pair.two?.oid].filter((oid) => oid !== undefined)));
    paired = (await detectRenames(queue, async (side) => (await store.read(side.oid)).data)).queue;
  }
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
