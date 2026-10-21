/**
 * A backend's listing as its feed gives it (VfsChanges.list), and the feed
 * of a backend whose tree does not change while it is mounted (/dev; /proc,
 * whose generated files' content is not its tree): every cursor of its
 * epoch is current, nothing has changed since one, and its listing is its
 * whole tree. A mount states its change model by its feed (VFS.changes); an
 * immutable one states it so, and is answered from what a reader listed as
 * any fed mount is.
 *
 * Its epoch is its tree's: every name with its type, size, mode and owner,
 * as `stat` and `readdir` say them now, and the version the backend gives
 * it. A tree that changes (a /proc file registered) is another epoch, so a
 * reader holding the last one lists again.
 */
import type { VfsBackendPage, VfsListEntry } from '../runtime/os-contracts.js';
import { compareUtf8 as comparePaths } from '@nimbus-sh/platform/utf8.js';
import { runtimeStatOf } from './runtime-stat.js';
import type { SyncVFS, VfsChanges } from './vfs.js';

/** Every name in `vfs` but its root, absolute, as its own lstat says it (a link with its target), in path order. */
export function treeListing(vfs: Pick<SyncVFS, 'stat' | 'readdir'> & Partial<Pick<SyncVFS, 'readlink'>>): VfsListEntry[] {
  const entries: VfsListEntry[] = [];
  const walk = (dir: string): void => {
    for (const child of vfs.readdir(dir)) {
      const path = dir === '/' ? `/${child.name}` : `${dir}/${child.name}`;
      const stat = vfs.stat(path, { follow: false });
      if (stat === null) continue;
      const entry: VfsListEntry = { path, kind: stat.type, size: stat.size, rev: typeof stat.revision === 'number' ? stat.revision : 0, stat: runtimeStatOf(stat) };
      if (stat.type === 'symlink' && vfs.readlink !== undefined) entry.linkTarget = vfs.readlink(path);
      entries.push(entry);
      if (stat.type === 'directory') walk(path);
    }
  };
  walk('/');
  entries.sort((a, b) => comparePaths(a.path, b.path));
  return entries;
}

/** The page of `entries` (in path order) after `after`, `limit` long, at `epoch` and `rev`; each entry its own copy. */
export function pageOf(entries: readonly VfsListEntry[], after: string | null, limit: number, epoch: string, rev: number): VfsBackendPage {
  let start = 0;
  if (after !== null) {
    let high = entries.length;
    while (start < high) {
      const middle = (start + high) >>> 1;
      if (comparePaths(entries[middle].path, after) <= 0) start = middle + 1;
      else high = middle;
    }
  }
  const page = entries.slice(start, start + Math.max(1, limit)).map((entry) => ({ ...entry, stat: { ...entry.stat } }));
  const next = start + page.length < entries.length && page.length > 0 ? page[page.length - 1].path : null;
  return { epoch, rev, entries: page, next };
}

/**
 * The feed of `vfs`, whose tree changes only when `version` does (a /proc
 * registration): its listing and epoch are taken once a version.
 */
export function immutableChanges(vfs: Pick<SyncVFS, 'stat' | 'readdir'>, version: () => number = () => 0): VfsChanges {
  let tree: { entries: VfsListEntry[]; epoch: string; version: number } | null = null;
  const current = (): { entries: VfsListEntry[]; epoch: string } => {
    if (tree !== null && tree.version === version()) return tree;
    const at = version();
    const entries = treeListing(vfs);
    const text = entries.map((e) => `${e.path}\u0000${e.kind}\u0000${e.size}\u0000${e.stat.mode}\u0000${e.stat.uid}\u0000${e.stat.gid}`).join('\u0001');
    // Its version too: a registration that replaces a file's content with as many bytes is another tree.
    tree = { entries, epoch: `tree:${hash(text)}.${at}`, version: at };
    return tree;
  };
  return {
    get epoch() { return current().epoch; },
    fixed: true,
    revision: () => 0,
    since: (epoch) => {
      const now = current().epoch;
      return { epoch: now, rev: 0, paths: [], poison: epoch !== now };
    },
    list: (after, limit) => {
      const { entries, epoch } = current();
      return pageOf(entries, after, limit, epoch, 0);
    },
  };
}

/** Two 32-bit FNV-1a hashes of `text` (offsets apart): a tree's name, not a secret. */
function hash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}
