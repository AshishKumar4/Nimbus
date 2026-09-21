/**
 * vfs-manifest.ts — describe a filesystem subtree to the WASI layer without copying it.
 *
 * This is the seed producer for the one filesystem: a manifest of sizes and
 * modes that wasi-instance.ts treats as a cache index over the live session
 * filesystem. Content arrives on demand and mutations write back as they
 * happen, both through the same credential-bound authority the walk used.
 */
import type { WasiFsSnapshot } from './wasi-instance.js';
import type { RuntimeFsBridge, RuntimeVfsStat, VfsCred } from './os-contracts.js';

export interface VfsManifest {
  snapshot: WasiFsSnapshot;
  files: number;
  bytes: number;
}

/**
 * Describe a filesystem subtree without copying it.
 *
 * Records each file's SIZE instead of its bytes, so the result is a manifest
 * the WASI layer treats as a cache index: content is demand-loaded through the
 * authority on first read, and a path the manifest lacks is genuinely absent
 * (the walk excludes nothing, so every root is claimed as enumerated).
 *
 * Modes are the caller's effective bits, computed from the inode the authority
 * reports and the credential the bridge is bound to. Traversal is enforced by
 * the walk itself: a directory the credential cannot read is listed but never
 * entered, so nothing below it reaches the manifest.
 */
export async function manifestVfs(
  fs: RuntimeFsBridge,
  cred: Readonly<VfsCred>,
  vfsRoot: string,
  opts: { extraRoots?: Iterable<string>; revision?: number } = {},
): Promise<VfsManifest | { error: string }> {
  const root = vfsRoot.replace(/^\/+/, '').replace(/\/+$/, '');
  const roots = Array.from(new Set([
    root,
    ...Array.from(opts.extraRoots ?? []).map((r) => r.replace(/^\/+/, '').replace(/\/+$/, '')),
  ]));

  const sizes: Record<string, number> = {};
  const modes: Record<string, number> = {};
  const times: NonNullable<WasiFsSnapshot['times']> = {};
  const symlinks: Record<string, string> = {};
  const dirsSet = new Set<string>();
  let totalBytes = 0;
  let fileCount = 0;
  const stack: string[] = [];

  const record = (path: string, st: RuntimeVfsStat): number => {
    const mode = effectiveMode(st.mode, st.uid, st.gid, cred);
    modes[path] = mode;
    times[path] = {
      atime: nanoseconds(st.atime),
      mtime: nanoseconds(st.mtime),
      ctime: nanoseconds(st.ctime),
    };
    return mode;
  };

  const addDirWithParents = async (path: string, callerNamedRoot = false): Promise<void> => {
    const clean = path.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!clean) return;
    const parts = clean.split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      const ancestor = parts.slice(0, i).join('/');
      dirsSet.add(ancestor);
      if (modes[ancestor] !== undefined) continue;
      let st: RuntimeVfsStat | null;
      try {
        st = await fs.stat(ancestor);
      } catch (error) {
        // An ancestor the caller may not traverse stays modeless: the guest
        // is denied everything under it, which is what the authority said.
        if (hasErrorCode(error, 'EACCES')) continue;
        throw error;
      }
      if (st !== null) {
        record(ancestor, st);
        continue;
      }
      // A root that does not exist YET — site-packages before the first
      // install — is a path the producer deliberately listed for the guest to
      // create, and leaving it modeless makes __wasiEffectiveMode answer 0 for
      // a path that `dirs` says exists: deny everything, including traversal.
      // The guest then cannot stat its own target, os.path.isdir swallows the
      // error and says False, and makedirs(exist_ok=True) re-raises
      // FileExistsError for a directory it just created. It inherits its
      // parent instead. Only for a root the CALLER named: paths discovered by
      // the walk came from a readdir that already saw them, so a miss there is
      // a race the caller must see.
      if (!callerNamedRoot || i === 1) continue;
      const parentMode = modes[parts.slice(0, i - 1).join('/')];
      if (parentMode !== undefined) modes[ancestor] = parentMode;
    }
  };

  for (const start of roots) {
    await addDirWithParents(start, true);
    let st: RuntimeVfsStat | null;
    try {
      st = await fs.stat(start);
    } catch (error) {
      if (!hasErrorCode(error, 'EACCES')) throw error;
      modes[start] = 0;
      continue;
    }
    if (st === null) continue;
    if (st.type === 'directory') stack.push(start);
  }

  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries: Awaited<ReturnType<RuntimeFsBridge['readdir']>>;
    try {
      entries = await fs.readdir(dir);
    } catch (error) {
      if (hasErrorCode(error, 'EACCES')) continue;
      return { error: `runtime filesystem manifest incomplete: readdir ${dir}` };
    }
    for (const entry of entries) {
      const childPath = `${dir}/${entry.name}`;
      const st = await fs.stat(childPath, { followSymlinks: false });
      if (st === null) return { error: `runtime filesystem manifest incomplete: stat ${childPath}` };
      record(childPath, st);
      if (st.type === 'directory') {
        dirsSet.add(childPath);
        stack.push(childPath);
        continue;
      }
      if (st.type === 'symlink') {
        const target = await fs.readlink(childPath);
        if (target === null) return { error: `runtime filesystem manifest incomplete: readlink ${childPath}` };
        symlinks[childPath] = target;
        continue;
      }
      // Size comes from the inode, so a manifest costs no reads at all — this
      // is the whole reason it has no byte cap and cannot fail a spawn.
      sizes[childPath] = st.size;
      totalBytes += st.size;
      fileCount++;
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
      times,
      symlinks,
      enumeratedRoots: roots,
      revision: opts.revision,
    },
    files: fileCount,
    bytes: totalBytes,
  };
}

function nanoseconds(milliseconds: number): string {
  return String(BigInt(Math.trunc(milliseconds)) * 1000000n);
}

export function effectiveMode(mode: number, uid: number, gid: number, cred: Readonly<VfsCred>): number {
  if (cred.uid === 0) return 0o6 | ((mode & 0o111) !== 0 ? 0o1 : 0);
  if (cred.uid === uid) return (mode >> 6) & 0o7;
  if (cred.gid === gid || cred.groups.includes(gid)) return (mode >> 3) & 0o7;
  return mode & 0o7;
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
