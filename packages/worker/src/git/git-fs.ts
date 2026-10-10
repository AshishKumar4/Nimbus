/**
 * git/git-fs.ts — cf-git's `fs` over a backend: the session's filesystem
 * (git/commands.ts), or the git network facet's buffered writer
 * (pack/buffered-fs.ts). One adapter: paths normalized, text reads decoded,
 * inodes as Node's fs.Stats, failures as Node's errors.
 *
 * fs.promises.readFile takes its encoding bare as well as on an options
 * object, and cf-git uses both spellings ('utf8', and { encoding: 'utf8' }
 * everywhere else). An adapter that honours only the object form hands
 * those call sites bytes where they asked for text, and cf-git feeds the
 * result straight to `ignore().add()`, which silently accepts only strings,
 * so every .gitignore rule became a no-op.
 */
import { normalizeVfsPath } from '@nimbus-sh/core/vfs/path.js';

/** An inode as a backend reports it. */
export interface GitFsStat {
  type: 'file' | 'dir' | 'symlink';
  size: number;
  /** Permission bits. */
  mode: number;
  mtimeMs: number;
  ctimeMs: number;
  atimeMs: number;
  uid: number;
  gid: number;
  dev: number;
  ino: number;
  nlink: number;
}

/**
 * What the adapter asks of a backend, at a normalized path (`filepath` is
 * the caller's, for errors). Each keeps its own write rules: the session's
 * writes a worktree as git's checkout does; the facet's buffers waves.
 */
export interface GitFsBackend {
  /** `path`'s inode, through a final link when `follow`; null when there is none. */
  stat(path: string, follow: boolean): Promise<GitFsStat | null>;
  /** `path`'s bytes; null when there is no file. */
  readFile(path: string): Promise<Uint8Array | null>;
  /** `executable` when the caller's mode has an execute bit. */
  writeFile(path: string, data: Uint8Array | string, executable: boolean): Promise<void>;
  unlink(path: string, filepath: string): Promise<void>;
  readdir(path: string, filepath: string): Promise<string[]>;
  mkdir(path: string): Promise<void>;
  /** rmdir(2), or with `recursive` the whole subtree. */
  rmdir(path: string, filepath: string, recursive: boolean): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
  readlink(path: string, filepath: string): Promise<string>;
}

type FsErrorCode = 'ENOENT' | 'ENOTDIR' | 'EISDIR' | 'ENOTEMPTY' | 'EINVAL' | 'EIO' | 'ELOOP';

const FS_ERRORS: Record<FsErrorCode, [errno: number, message: string]> = {
  ENOENT: [-2, 'no such file or directory'],
  ENOTDIR: [-20, 'not a directory'],
  EISDIR: [-21, 'illegal operation on a directory'],
  ENOTEMPTY: [-39, 'directory not empty'],
  EINVAL: [-22, 'invalid argument'],
  EIO: [-5, 'input/output error'],
  ELOOP: [-40, 'too many symbolic links encountered'],
};

/** Node's error for `code` at `filepath`, as `syscall` reports it. */
export function fsError(code: FsErrorCode, syscall: string, filepath: string, detail?: string): Error & { code: string; errno: number } {
  const [errno, message] = FS_ERRORS[code];
  return Object.assign(new Error(`${code}: ${message}, ${syscall} '${filepath}'${detail ? `: ${detail}` : ''}`), { code, errno });
}

function wantsUtf8(options: unknown): boolean {
  const encoding = typeof options === 'string'
    ? options
    : (options as { encoding?: unknown } | null | undefined)?.encoding;
  return encoding === 'utf8' || encoding === 'utf-8';
}

const TYPE_BITS = { file: 0o100000, dir: 0o040000, symlink: 0o120000 } as const;

/** `st` as Node's fs.Stats: git's stat cache compares ctime, ino, uid and gid too. */
function nodeStats(st: GitFsStat) {
  return {
    isFile: () => st.type === 'file',
    isDirectory: () => st.type === 'dir',
    isSymbolicLink: () => st.type === 'symlink',
    size: st.size,
    mode: TYPE_BITS[st.type] | (st.mode & 0o7777),
    mtimeMs: st.mtimeMs, mtime: new Date(st.mtimeMs),
    ctimeMs: st.ctimeMs, ctime: new Date(st.ctimeMs),
    atimeMs: st.atimeMs, atime: new Date(st.atimeMs),
    uid: st.uid, gid: st.gid, dev: st.dev, ino: st.ino, nlink: st.nlink,
    type: st.type,
  };
}

const decoder = new TextDecoder();

/**
 * cf-git's `fs` over `backend`, with `packs` (pack/store.ts) its packs seam.
 * Each call is the backend's promise, shaped by one `then` where it needs
 * shaping: the adapter adds no await of its own to cf-git's many small calls.
 */
export function createGitFs<P>(backend: GitFsBackend, packs: P) {
  const statOf = (filepath: string, follow: boolean) => backend.stat(normalizeVfsPath(filepath), follow).then((st) => {
    if (st === null) throw fsError('ENOENT', follow ? 'stat' : 'lstat', filepath);
    return nodeStats(st);
  });
  return {
    packs,
    promises: {
      readFile: (filepath: string, options?: unknown): Promise<Uint8Array | string> => backend.readFile(normalizeVfsPath(filepath)).then((data) => {
        if (data === null) throw fsError('ENOENT', 'open', filepath);
        return wantsUtf8(options) ? decoder.decode(data) : data;
      }),
      writeFile(filepath: string, data: Uint8Array | ArrayBuffer | string, options?: { mode?: unknown }): Promise<void> {
        const bytes = typeof data === 'string' || data instanceof Uint8Array ? data : new Uint8Array(data);
        return backend.writeFile(normalizeVfsPath(filepath), bytes, (Number(options?.mode) & 0o111) !== 0);
      },
      unlink: (filepath: string): Promise<void> => backend.unlink(normalizeVfsPath(filepath), filepath),
      readdir: (filepath: string): Promise<string[]> => backend.readdir(normalizeVfsPath(filepath), filepath),
      mkdir: (filepath: string): Promise<void> => backend.mkdir(normalizeVfsPath(filepath)),
      // Taking options, it is also cf-git's recursive delete (models/FileSystem.js binds `_rm` to it).
      rmdir: (filepath: string, options?: { recursive?: boolean }): Promise<void> =>
        backend.rmdir(normalizeVfsPath(filepath), filepath, options?.recursive === true),
      stat: (filepath: string) => statOf(filepath, true),
      lstat: (filepath: string) => statOf(filepath, false),
      async chmod(): Promise<void> { /* no-op: git's modes live in the index */ },
      symlink: (target: string, filepath: string): Promise<void> => backend.symlink(String(target), normalizeVfsPath(filepath)),
      readlink: (filepath: string): Promise<string> => backend.readlink(normalizeVfsPath(filepath), filepath),
    },
  };
}
