import type { VfsCred } from '../../../../runtime/os-contracts.js';

export type FileType = 'file' | 'directory';

export type VFSEventType = 'create' | 'modify' | 'delete' | 'rename';

export interface VFSWatchEvent {
  type: VFSEventType;
  path: string;
  oldPath?: string; // only for 'rename'
  fileType: FileType;
}

export type VFSWatchListener = (event: VFSWatchEvent) => void;

export interface ChunkRef {
  hash: string;
  size: number;
}

export interface INode {
  type: FileType;
  name: string;
  data: Uint8Array;         // file content (empty for dirs; empty for chunked files)
  children: Map<string, INode>;  // dir entries (empty map for files)
  ctime: number;
  mtime: number;
  mode: number;
  mime?: string;            // MIME type (files only, auto-detected)
  blobRef?: string;         // content-hash key into BlobStore (small files)
  chunks?: ChunkRef[];      // chunk manifest for large files (>= 1MB)
  storedSize?: number;      // authoritative size when chunked (data is empty)
}

/**
 * `st_mode` file-type bits. `Stat.type` only distinguishes file from
 * directory, so anything finer — a character device, a symlink — is carried
 * in the mode, exactly as Unix does it. `ls -l` and `stat` read the leading
 * type character from here.
 */
export const S_IFMT = 0o170000;
export const S_IFREG = 0o100000;
export const S_IFDIR = 0o040000;
export const S_IFCHR = 0o020000;
export const S_IFLNK = 0o120000;

/** True for a character device such as `/dev/zero`, which streams rather than stores. */
export function isCharacterDevice(mode: number): boolean {
  return (mode & S_IFMT) === S_IFCHR;
}

/** The `ls -l` type character for a mode, falling back to the coarse `Stat.type`. */
export function fileTypeChar(mode: number, type: FileType): string {
  switch (mode & S_IFMT) {
    case S_IFCHR: return 'c';
    case S_IFLNK: return 'l';
    case S_IFDIR: return 'd';
    case S_IFREG: return '-';
    default: return type === 'directory' ? 'd' : '-';
  }
}

export interface Stat {
  type: FileType;
  size: number;
  ctime: number;
  mtime: number;
  mode: number;
  uid?: number;
  gid?: number;
  mime?: string;
}

export interface Dirent {
  name: string;
  type: FileType;
}

export const ErrorCode = {
  ENOENT: 'ENOENT',
  EEXIST: 'EEXIST',
  ENOTDIR: 'ENOTDIR',
  EISDIR: 'EISDIR',
  ENOTEMPTY: 'ENOTEMPTY',
  EINVAL: 'EINVAL',
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface VirtualProvider {
  readFile(subpath: string): Uint8Array;
  readFileString(subpath: string): string;
  /**
   * Read at most `length` bytes at `offset` without materialising the whole
   * file. Short reads are legal (read(2) semantics) — callers must loop until
   * they get what they need or an empty result signals EOF. Providers that
   * cannot serve a slice cheaply omit this; `VFS.readRange` then slices a
   * whole-file read for them.
   */
  readRange?(subpath: string, offset: number, length: number): Uint8Array;
  writeFile?(subpath: string, content: string | Uint8Array): void;
  exists(subpath: string): boolean;
  stat(subpath: string): Stat;
  readdir(subpath: string): Dirent[];
  access?(subpath: string, mode: number): void;
  as?(cred: VfsCred): VirtualProvider;
}

export interface MountProvider extends VirtualProvider {
  writeFile(subpath: string, content: string | Uint8Array): void;
  /**
   * Write `bytes` at `offset`, growing the file as needed, without rewriting
   * the parts of it the range does not touch. Providers that cannot do this
   * omit it; `VFS.writeRange` then splices via a whole-file read/write.
   */
  writeRange?(subpath: string, offset: number, bytes: Uint8Array): void;
  truncate?(subpath: string, size: number): void;
  unlink(subpath: string): void;
  mkdir(subpath: string, options?: { recursive?: boolean }): void;
  rmdir(subpath: string): void;
  rename(oldSubpath: string, newSubpath: string): void;
  copyFile(srcSubpath: string, destSubpath: string): void;
  /** Set permission bits. Providers without chmod reject it (read-only fs). */
  chmod?(subpath: string, mode: number): void;
  chown?(subpath: string, uid: number | null, gid: number | null): void;
}

export class VFSError extends Error {
  code: ErrorCodeType;

  constructor(code: ErrorCodeType, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = 'VFSError';
  }
}
