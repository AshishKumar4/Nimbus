import type { WasiFsDiff, WasiFsSnapshot } from './wasi-instance.js';

/**
 * Minimal VFS shape runtime bridges need. Kept separate from SqliteVFS's
 * concrete type so runtime helpers do not pull supervisor modules into facet
 * preambles or create import cycles.
 */
export interface VfsLike {
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  readFile(path: string): Uint8Array;
  writeFile(path: string, content: Uint8Array | string): void;
  readdir(path: string): { name: string; type: string }[];
  mkdir(path: string, opts?: { recursive?: boolean }): void;
  unlink(path: string): void;
  rmdir(path: string): void;
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
  const dirsSet = new Set<string>();
  let totalBytes = 0;
  let fileCount = 0;
  const stack: string[] = [];

  const addDirWithParents = (path: string) => {
    const clean = path.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!clean) return;
    const parts = clean.split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      dirsSet.add(parts.slice(0, i).join('/'));
    }
  };

  for (const start of roots) {
    addDirWithParents(start);
    if (vfs.exists(start)) stack.push(start);
  }
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: { name: string; type: string }[];
    try {
      entries = vfs.readdir(dir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const childPath = `${dir}/${entry.name}`;
      if (entry.type === 'directory') {
        if (skipSubdirs.has(entry.name)) continue;
        addDirWithParents(childPath);
        stack.push(childPath);
        continue;
      }

      let bytes: Uint8Array;
      try {
        bytes = vfs.readFile(childPath);
      } catch {
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

  return { snapshot: { root, roots, preopens: [], files, dirs: Array.from(dirsSet).sort() }, bytes: totalBytes, files: fileCount };
}

/**
 * Apply a runtime-produced filesystem diff back into the supervisor VFS.
 * Operations are independent so one bad path never loses the rest of a run.
 */
export function flushVfsDiff(
  vfs: VfsLike,
  diff: WasiFsDiff,
): { written: number; deleted: number; mkdirs: number; rmdirs: number; timesTouched: number; symlinks: number } {
  let written = 0;
  let deleted = 0;
  let mkdirs = 0;
  let rmdirs = 0;
  let timesTouched = 0;
  let symlinks = 0;

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

  if (diff.timesChanged) timesTouched = Object.keys(diff.timesChanged).length;
  if (diff.symlinksCreated) symlinks = Object.keys(diff.symlinksCreated).length;
  if (diff.symlinksDeleted) symlinks += diff.symlinksDeleted.length;
  return { written, deleted, mkdirs, rmdirs, timesTouched, symlinks };
}
