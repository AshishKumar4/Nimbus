import type { WasiFsDiff, WasiFsSnapshot } from './wasi-instance.js';
import type { VfsCred } from './os-contracts.js';

/**
 * Minimal VFS shape runtime bridges need. Kept separate from SqliteVFS's
 * concrete type so runtime helpers do not pull supervisor modules into facet
 * preambles or create import cycles.
 */
export interface VfsLike {
  readonly cred: VfsCred;
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  stat(path: string): { mode: number; uid: number; gid: number };
  readFile(path: string): Uint8Array;
  writeFile(path: string, content: Uint8Array | string): void;
  readdir(path: string): { name: string; type: string }[];
  mkdir(path: string, opts?: { recursive?: boolean }): void;
  unlink(path: string): void;
  rmdir(path: string): void;
  chmod(path: string, mode: number): void;
}

export interface VfsSnapshotCaps {
  maxBytes?: number;
  maxFiles?: number;
  skipSubdirs?: Iterable<string>;
  extraRoots?: Iterable<string>;
}

export interface VfsSnapshotResult {
  snapshot: WasiFsSnapshot;
  bytes: number;
  files: number;
}

export function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function effectiveMode(mode: number, uid: number, gid: number, cred: VfsCred): number {
  if (cred.uid === 0) return 0o6 | ((mode & 0o111) !== 0 ? 0o1 : 0);
  if (cred.uid === uid) return (mode >> 6) & 0o7;
  if (cred.gid === gid || cred.groups.includes(gid)) return (mode >> 3) & 0o7;
  return mode & 0o7;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

/**
 * Snapshot a VFS subtree into a JSON-serializable WASI-shaped filesystem.
 *
 * The snapshot is intentionally bounded. Runtimes that need incremental or
 * lazy file IO should add a streaming bridge; a single request payload is the
 * right primitive only for normal source trees and small app state.
 */
export function snapshotVfs(
  vfs: VfsLike,
  vfsRoot: string,
  caps: VfsSnapshotCaps = {},
): VfsSnapshotResult | { error: string } {
  const maxBytes = caps.maxBytes ?? 32 * 1024 * 1024;
  const maxFiles = caps.maxFiles ?? 5000;
  const skipSubdirs = new Set(caps.skipSubdirs ?? ['.nimbus', 'node_modules', '.cache', '.npm']);
  const root = vfsRoot.replace(/^\/+/, '').replace(/\/+$/, '');
  const roots = Array.from(new Set([
    root,
    ...Array.from(caps.extraRoots ?? []).map((r) => r.replace(/^\/+/, '').replace(/\/+$/, '')).filter(Boolean),
  ].filter(Boolean)));
  const files: Record<string, string> = {};
  const modes: Record<string, number> = {};
  const dirsSet = new Set<string>();
  let totalBytes = 0;
  let fileCount = 0;
  const stack: string[] = [];
  const failures: string[] = [];

  const addDirWithParents = (path: string) => {
    const clean = path.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!clean) return;
    const parts = clean.split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      const ancestor = parts.slice(0, i).join('/');
      dirsSet.add(ancestor);
      // Every ancestor directory needs an effective-mode entry: the WASI
      // shim requires the search (x) bit on each path component to traverse
      // into a leaf, and its default for an existing-but-unmapped inode is
      // deny. An intermediate dir that is neither a root nor walked (e.g.
      // the shared parent of the cwd and the gem home) would otherwise have
      // no entry and block all traversal through it with EACCES. Statting
      // it here grants exactly the caller's real access — no more, no less.
      if (modes[ancestor] === undefined) {
        try {
          const stat = vfs.stat(ancestor);
          modes[ancestor] = effectiveMode(stat.mode, stat.uid, stat.gid, vfs.cred);
        } catch {
          // Unreadable or absent ancestor: leave unmapped so the caller's
          // seeded preopen modes or the shim's deny-by-default apply.
        }
      }
    }
  };

  for (const start of roots) {
    addDirWithParents(start);
    try {
      if (!vfs.exists(start)) continue;
    } catch (error) {
      if (!hasErrorCode(error, 'EACCES')) throw error;
      modes[start] = 0;
      continue;
    }
    const stat = vfs.stat(start);
    modes[start] = effectiveMode(stat.mode, stat.uid, stat.gid, vfs.cred);
    stack.push(start);
  }
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: { name: string; type: string }[];
    try {
      entries = vfs.readdir(dir);
    } catch (error) {
      if (hasErrorCode(error, 'EACCES')) continue;
      failures.push(`readdir ${dir}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    for (const entry of entries) {
      const childPath = `${dir}/${entry.name}`;
      if (entry.type === 'directory') {
        if (skipSubdirs.has(entry.name)) continue;
        let stat: ReturnType<VfsLike['stat']>;
        try {
          stat = vfs.stat(childPath);
        } catch (error) {
          failures.push(`stat ${childPath}: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        modes[childPath] = effectiveMode(stat.mode, stat.uid, stat.gid, vfs.cred);
        addDirWithParents(childPath);
        stack.push(childPath);
        continue;
      }

      let stat: ReturnType<VfsLike['stat']>;
      try {
        stat = vfs.stat(childPath);
      } catch (error) {
        failures.push(`stat ${childPath}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      const mode = effectiveMode(stat.mode, stat.uid, stat.gid, vfs.cred);
      modes[childPath] = mode;
      if ((mode & 0o4) === 0) continue;

      let bytes: Uint8Array;
      try {
        bytes = vfs.readFile(childPath);
      } catch (error) {
        failures.push(`readFile ${childPath}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }

      totalBytes += bytes.length;
      fileCount++;
      if (totalBytes > maxBytes) {
        return { error: `runtime filesystem snapshot exceeded ${(maxBytes / 1024 / 1024).toFixed(0)} MiB cap (current dir: ${dir})` };
      }
      if (fileCount > maxFiles) {
        return { error: `runtime filesystem snapshot exceeded ${maxFiles} file cap` };
      }
      addDirWithParents(dir);
      files[childPath] = bytesToB64(bytes);
    }
  }

  if (failures.length > 0) {
    return { error: `runtime filesystem snapshot incomplete: ${failures.join('; ')}` };
  }

  return {
    snapshot: { root, roots, preopens: [], files, dirs: Array.from(dirsSet).sort(), modes },
    bytes: totalBytes,
    files: fileCount,
  };
}

/**
 * Apply a runtime-produced filesystem diff back into the supervisor VFS.
 * Operations are independent so one bad path never loses the rest of a run.
 */
export function flushVfsDiff(
  vfs: VfsLike,
  diff: WasiFsDiff,
): { written: number; deleted: number; mkdirs: number; rmdirs: number; timesTouched: number; symlinks: number; chmods: number } {
  let written = 0;
  let deleted = 0;
  let mkdirs = 0;
  let rmdirs = 0;
  let timesTouched = 0;
  let symlinks = 0;
  let chmods = 0;

  for (const path of diff.dirsCreated) {
    try {
      vfs.mkdir(path, { recursive: true });
      mkdirs++;
    } catch {}
  }

  for (const [path, b64] of Object.entries(diff.filesWritten)) {
    try {
      const lastSlash = path.lastIndexOf('/');
      if (lastSlash > 0) {
        try { vfs.mkdir(path.substring(0, lastSlash), { recursive: true }); } catch {}
      }
      vfs.writeFile(path, b64ToBytes(b64));
      written++;
    } catch {}
  }

  for (const path of diff.filesDeleted) {
    try {
      vfs.unlink(path);
      deleted++;
    } catch {}
  }

  for (const path of diff.dirsDeleted) {
    try {
      vfs.rmdir(path);
      rmdirs++;
    } catch {}
  }

  for (const [path, mode] of Object.entries(diff.modesChanged ?? {})) {
    try {
      vfs.chmod(path, mode);
      chmods++;
    } catch {}
  }

  if (diff.timesChanged) timesTouched = Object.keys(diff.timesChanged).length;
  if (diff.symlinksCreated) symlinks = Object.keys(diff.symlinksCreated).length;
  if (diff.symlinksDeleted) symlinks += diff.symlinksDeleted.length;
  return { written, deleted, mkdirs, rmdirs, timesTouched, symlinks, chmods };
}
