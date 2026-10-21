/**
 * The file calls Node's `fs` is written over (Kinu ask 67): one set of
 * calls, answered now by a synchronous face or later by an asynchronous one.
 * Each `fs` operation is written once (node-compat/fs.ts) and run over
 * either face (node-compat/drive.ts).
 */
import type { RuntimeOpenFlags, RuntimeVfsDirEntry, RuntimeVfsStat } from '../runtime/os-contracts.js';
import type { VfsEvent } from '../vfs/events.js';
import type { StartedProgram } from '../runtime/program-start.js';

export interface NodeWatch {
  close(): void;
  ref(): void;
  unref(): void;
}

/** How a face answers: now, or with a promise. */
export type FaceMode = 'sync' | 'async';
type Answer<M extends FaceMode, T> = M extends 'sync' ? T : Promise<T>;

/**
 * The file calls, each answered as `M` says. Those a filesystem may lack
 * are optional: an `fs` call that needs one it lacks is ENOSYS, Linux's
 * answer for an operation a filesystem does not have.
 */
export interface FilesFace<M extends FaceMode> {
  readFile(path: string): Answer<M, Uint8Array>;
  readFileString(path: string): Answer<M, string>;
  writeFile(path: string, data: string | Uint8Array): Answer<M, void>;
  exists(path: string): Answer<M, boolean>;
  isFile(path: string): Answer<M, boolean>;
  isDirectory(path: string): Answer<M, boolean>;
  stat(path: string): Answer<M, RuntimeVfsStat>;
  /** stat(2) of `path` itself where it names a link (lstat); ENOENT when nothing is there. */
  lstat(path: string): Answer<M, RuntimeVfsStat>;
  readdir(path: string): Answer<M, RuntimeVfsDirEntry[]>;
  appendFile?(path: string, data: string | Uint8Array): Answer<M, void>;
  /** Canonical VFS path, following links; native module caches key by it. */
  realpath?(path: string): Answer<M, string>;
  /** symlink(2): a link at `path` whose text is `target`, as given (a relative one stays relative). */
  symlink?(target: string, path: string): Answer<M, void>;
  /** readlink(2): the text of the link at `path`; EINVAL where `path` is no link, ENOENT where nothing is there. */
  readlink?(path: string): Answer<M, string>;
  mkdir?(path: string, options?: { recursive?: boolean; mode?: number }): Answer<M, void>;
  unlink?(path: string): Answer<M, void>;
  rmdir?(path: string): Answer<M, void>;
  rmdirRecursive?(path: string): Answer<M, void>;
  rename?(from: string, to: string): Answer<M, void>;
  copyFile?(from: string, to: string): Answer<M, void>;
  chmod?(path: string, mode: number): Answer<M, void>;
  /** chown(2), or lchown(2) when not `follow`: a null side keeps the file's, in the same change. */
  chown?(path: string, uid: number | null, gid: number | null, follow: boolean): Answer<M, void>;
  /** truncate(2) by path; a face without it is truncated through a descriptor. */
  truncate?(path: string, size: number): Answer<M, void>;
  /** open(2): the process's descriptor (its DescriptorScope's), whatever filesystem the file is on. */
  open?(path: string, flags: RuntimeOpenFlags): Answer<M, number>;
  /** read(2), at `position`, or at the descriptor's offset (null), which then moves. */
  read?(fd: number, position: number | null, length: number): Answer<M, Uint8Array>;
  /** write(2), at `position`, or at the descriptor's offset (null), which then moves; an O_APPEND descriptor's at the end. */
  write?(fd: number, position: number | null, data: Uint8Array): Answer<M, number>;
  fstat?(fd: number): Answer<M, RuntimeVfsStat>;
  /** fchown(2): a null side keeps the file's. */
  fchown?(fd: number, uid: number | null, gid: number | null): Answer<M, void>;
  ftruncate?(fd: number, size: number): Answer<M, void>;
  fsync?(fd: number): Answer<M, void>;
  close?(fd: number): Answer<M, void>;
  /**
   * Each change at `path` or under it the process's namespace shows
   * (RuntimeFsBridge.subscribe), its paths absolute. `persistent` (default
   * true): a guest stays while the watch is open and ref'd, as Node's does.
   */
  watch?(path: string, listener: (event: VfsEvent) => void, options?: { persistent?: boolean }): NodeWatch;
}

/** The synchronous filesystem the in-process Node interpreter's `fs` and `require` read: every call but a path's truncate. */
export type NodeFilesystem = Required<Omit<FilesFace<'sync'>, 'truncate'>>;

/**
 * What a session client gives Node's `fs` (createNodeCompat): the calls
 * with promises. stat, lstat, readFile, writeFile and readdir are needed;
 * readFileString, exists, isFile and isDirectory are made from them when
 * absent; any other absent call is ENOSYS. A failure is an Error with
 * `code`, `syscall` and `path`, its own: `fs` names the path in it as its
 * caller gave it (one frozen is copied instead).
 */
export type NodeFiles = Pick<FilesFace<'async'>, 'stat' | 'lstat' | 'readFile' | 'writeFile' | 'readdir'> & Partial<FilesFace<'async'>>;

/** A program Node's child_process starts: its argv, its cwd, its environment (none: its parent's, the session's own), its input (none: ended at once). */
export interface NodeProgram {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin: ReadableStream<Uint8Array> | null;
}

/**
 * Starts `program` (ExecDelegate.start's contract): resolved once it runs,
 * with its pid where its host numbers it; refused with Node's spawn error
 * (`code`, `errno`, `syscall: 'spawn <file>'`, `path`). `cancel` before then
 * cancels the start.
 */
export type NodeStart = (program: NodeProgram, cancel: AbortSignal) => Promise<StartedProgram & { readonly pid?: number }>;

/** The faces one `fs` runs over: a synchronous one, an asynchronous one, or both. */
export type NodeFaces =
  | { readonly sync: FilesFace<'sync'>; readonly async?: FilesFace<'async'> }
  | { readonly sync?: undefined; readonly async: FilesFace<'async'> };
