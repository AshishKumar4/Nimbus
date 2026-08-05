/**
 * vfs-manifest.ts — describe a VFS subtree to the WASI layer without copying it.
 *
 * This is the seed producer for the one filesystem: a manifest of sizes and
 * modes that wasi-instance.ts treats as a cache index over the live session
 * VFS. Content arrives on demand and mutations write back as they happen.
 */
import type { WasiFsSnapshot } from './wasi-instance.js';
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
  stat(path: string): { mode: number; uid: number; gid: number; size: number };
  readFile(path: string): Uint8Array;
  writeFile(path: string, content: Uint8Array | string): void;
  readdir(path: string): { name: string; type: string }[];
  mkdir(path: string, opts?: { recursive?: boolean }): void;
  unlink(path: string): void;
  rmdir(path: string): void;
  chmod(path: string, mode: number): void;
}

/**
 * Describe a VFS subtree without copying it.
 *
 * Same walk as snapshotVfs, but it records each file's SIZE instead of its
 * bytes, so the result is a manifest the WASI layer treats as a cache index:
 * content is demand-loaded through the supervisor on first read, and a path
 * the manifest lacks is genuinely absent (the walk excludes nothing).
 *
 * That last property is why this cannot be a flag on snapshotVfs. snapshotVfs
 * skips node_modules/.cache/.npm/.nimbus and unreadable files, so its output
 * may not describe the subtree completely and must never claim to.
 */
export function manifestVfs(
  vfs: VfsLike,
  vfsRoot: string,
  opts: { extraRoots?: Iterable<string>; revision?: number } = {},
): { snapshot: WasiFsSnapshot; files: number; bytes: number } | { error: string } {
  const root = vfsRoot.replace(/^\/+/, '').replace(/\/+$/, '');
  const roots = Array.from(new Set([
    root,
    ...Array.from(opts.extraRoots ?? []).map((r) => r.replace(/^\/+/, '').replace(/\/+$/, '')),
  ].filter((r) => r !== undefined)));

  const sizes: Record<string, number> = {};
  const modes: Record<string, number> = {};
  const dirsSet = new Set<string>();
  let totalBytes = 0;
  let fileCount = 0;
  const stack: string[] = [];

  const addDirWithParents = (path: string) => {
    const clean = path.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!clean) return;
    const parts = clean.split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      const ancestor = parts.slice(0, i).join('/');
      dirsSet.add(ancestor);
      if (modes[ancestor] === undefined) {
        try {
          const st = vfs.stat(ancestor);
          modes[ancestor] = effectiveMode(st.mode, st.uid, st.gid, vfs.cred);
        } catch { /* unreadable ancestor: leave to deny-by-default */ }
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
    const st = vfs.stat(start);
    modes[start] = effectiveMode(st.mode, st.uid, st.gid, vfs.cred);
    stack.push(start);
  }

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: { name: string; type: string }[];
    try {
      entries = vfs.readdir(dir);
    } catch (error) {
      if (hasErrorCode(error, 'EACCES')) continue;
      return { error: `runtime filesystem manifest incomplete: readdir ${dir}` };
    }
    for (const entry of entries) {
      const childPath = `${dir}/${entry.name}`;
      let st: ReturnType<VfsLike['stat']>;
      try {
        st = vfs.stat(childPath);
      } catch (error) {
        return { error: `runtime filesystem manifest incomplete: stat ${childPath}` };
      }
      const mode = effectiveMode(st.mode, st.uid, st.gid, vfs.cred);
      modes[childPath] = mode;
      if (entry.type === 'directory') {
        addDirWithParents(childPath);
        stack.push(childPath);
        continue;
      }
      // Size comes from the inode, so a manifest costs no reads at all — this
      // is the whole reason it has no byte cap and cannot fail a spawn.
      const size = st.size;
      sizes[childPath] = size;
      totalBytes += size;
      fileCount++;
      addDirWithParents(dir);
    }
  }

  return {
    snapshot: {
      root,
      roots,
      preopens: [],
      files: {},
      sizes,
      dirs: Array.from(dirsSet).sort(),
      modes,
      enumeratedRoots: roots,
      revision: opts.revision,
    },
    files: fileCount,
    bytes: totalBytes,
  };
}

export function effectiveMode(mode: number, uid: number, gid: number, cred: VfsCred): number {
  if (cred.uid === 0) return 0o6 | ((mode & 0o111) !== 0 ? 0o1 : 0);
  if (cred.uid === uid) return (mode >> 6) & 0o7;
  if (cred.gid === gid || cred.groups.includes(gid)) return (mode >> 3) & 0o7;
  return mode & 0o7;
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
