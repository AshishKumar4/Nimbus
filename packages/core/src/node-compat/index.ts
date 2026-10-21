/**
 * Node's modules over a session client (Kinu ask 67): `createNodeCompat`
 * gives `fs` and `fs/promises`, written once (node-compat/fs.ts), over the
 * file calls a client provides, and `child_process` (node-compat/
 * child_process.ts) over its start; `nodeFacesOf` makes those over a Nimbus
 * session. There is no synchronous face: a client's isolate cannot wait, so
 * every `*Sync` call that reaches the session throws EAGAIN (a child's,
 * ERR_NIMBUS_SYNC_CHILD_PROCESS), and every asynchronous form works.
 */
import { errnoCodeOf, fsError } from '../vfs/vfs-error.js';
import type { RuntimeDirentType, RuntimeVfsDirEntry, RuntimeVfsStat } from '../runtime/os-contracts.js';
import type { SessionDirectoryEntry, SessionFileStat, SessionFollowOptions, SessionMkdirOptions } from '../runtime/session-protocol.js';
import type { StartedSessionProgram } from '../runtime/program-start.js';
import type { FilesFace, NodeFiles, NodeStart } from './faces.js';
import { createNodeFs } from './fs.js';
import { createNodeChildProcess } from './child_process.js';

export type { FilesFace, NodeFaces, NodeFiles, NodeFilesystem, NodeProgram, NodeStart, NodeWatch } from './faces.js';
export { createNodeFs } from './fs.js';
export { ChildProcess, createNodeChildProcess } from './child_process.js';

/**
 * `fs` and `fs/promises` over `files`, and `child_process` over `start`
 * (none: every start refused ENOSYS), relative paths taken from `cwd`.
 */
export function createNodeCompat({ files, start }: { files: NodeFiles; start?: NodeStart }, { cwd }: { cwd: string }) {
  const fs = createNodeFs({ async: completeFiles(files) }, { cwd });
  return { fs, fsPromises: fs.promises, childProcess: createNodeChildProcess(start, { cwd }) };
}

/** `path`'s stat, or null where nothing is there. */
async function statIfPresent(files: NodeFiles, path: string): Promise<RuntimeVfsStat | null> {
  try {
    return await files.stat(path);
  } catch (error) {
    if (errnoCodeOf(error) === 'ENOENT') return null;
    throw error;
  }
}

/** `files` with the calls Node's `fs` uses made from those it has: readFileString, exists, isFile, isDirectory. */
function completeFiles(files: NodeFiles): FilesFace<'async'> {
  return {
    readFile: files.readFile.bind(files),
    writeFile: files.writeFile.bind(files),
    stat: files.stat.bind(files),
    lstat: files.lstat.bind(files),
    readdir: files.readdir.bind(files),
    readFileString: files.readFileString?.bind(files) ?? (async (path) => new TextDecoder().decode(await files.readFile(path))),
    // As Node's existsSync: a stat it cannot make (ENOTDIR below a file, EACCES) is a no.
    exists: files.exists?.bind(files) ?? (async (path) => {
      try {
        await files.stat(path);
        return true;
      } catch (error) {
        if (errnoCodeOf(error) !== undefined) return false;
        throw error;
      }
    }),
    isFile: files.isFile?.bind(files) ?? (async (path) => (await statIfPresent(files, path))?.type === 'file'),
    isDirectory: files.isDirectory?.bind(files) ?? (async (path) => (await statIfPresent(files, path))?.type === 'directory'),
    appendFile: files.appendFile?.bind(files),
    realpath: files.realpath?.bind(files),
    symlink: files.symlink?.bind(files),
    readlink: files.readlink?.bind(files),
    mkdir: files.mkdir?.bind(files),
    unlink: files.unlink?.bind(files),
    rmdir: files.rmdir?.bind(files),
    rmdirRecursive: files.rmdirRecursive?.bind(files),
    rename: files.rename?.bind(files),
    copyFile: files.copyFile?.bind(files),
    chmod: files.chmod?.bind(files),
    chown: files.chown?.bind(files),
    truncate: files.truncate?.bind(files),
    open: files.open?.bind(files),
    read: files.read?.bind(files),
    write: files.write?.bind(files),
    fstat: files.fstat?.bind(files),
    fchown: files.fchown?.bind(files),
    ftruncate: files.ftruncate?.bind(files),
    fsync: files.fsync?.bind(files),
    close: files.close?.bind(files),
    watch: files.watch?.bind(files),
  };
}

/** A Nimbus session's file calls, as its client (the SDK's `sandbox.files`) makes them. */
export interface SessionFilesClient {
  read(path: string): Promise<string | null>;
  readBytes(path: string): Promise<Uint8Array | null>;
  write(path: string, content: string | Uint8Array): Promise<void>;
  stat(path: string): Promise<SessionFileStat | null>;
  lstat(path: string): Promise<SessionFileStat | null>;
  readlink(path: string): Promise<string | null>;
  rename(from: string, to: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  list(path?: string): Promise<SessionDirectoryEntry[]>;
  mkdir(path: string, options?: SessionMkdirOptions): Promise<void>;
  exists(path: string): Promise<boolean>;
  delete(path: string, options?: { recursive?: boolean }): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  appendFile(path: string, content: string | Uint8Array): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
  realpath(path: string): Promise<string>;
  truncate(path: string, size: number): Promise<void>;
  chown(path: string, uid: number | null, gid: number | null, options?: SessionFollowOptions): Promise<void>;
}

const FILE_TYPES: Readonly<Record<string, RuntimeVfsStat['type']>> = { file: 'file', directory: 'directory', symlink: 'symlink' };
const DIRENT_TYPES: Readonly<Record<string, RuntimeDirentType>> = {
  file: 'file', directory: 'directory', symlink: 'symlink', character: 'character', block: 'block', fifo: 'fifo', socket: 'socket',
};

/** A session's stat as the filesystem's: a session older than the whole stat(2) leaves what it lacks at zero, its times at mtime. */
function runtimeStatOf(stat: SessionFileStat, syscall: string, path: string): RuntimeVfsStat {
  const type = FILE_TYPES[stat.type];
  if (type === undefined) throw fsError('EIO', syscall, path, undefined, { detail: `a file of type ${stat.type} the session names but Node's fs does not` });
  return {
    dev: stat.dev ?? 0, ino: stat.ino ?? 0, nlink: stat.nlink ?? 1, type, size: stat.size,
    ctime: stat.ctime ?? stat.mtime, atime: stat.atime ?? stat.mtime, mtime: stat.mtime,
    mode: stat.mode, uid: stat.uid ?? 0, gid: stat.gid ?? 0, revision: stat.revision ?? 0,
  };
}

/** A Nimbus session's argv start, as its client (the SDK's `sandbox.startProgram`) makes it. */
export type SessionStartClient = (
  argv: string[],
  options: { cwd?: string; env?: Record<string, string>; stdin?: ReadableStream<Uint8Array>; signal?: AbortSignal },
) => Promise<StartedSessionProgram>;

/**
 * Node's `fs` calls over a Nimbus session's (`sandbox.files`), its absences
 * Node's ENOENT; and its starts over the session's (`sandbox.startProgram`),
 * placed by their cwd as every start is, a child given no environment the
 * session's own.
 */
export function nodeFacesOf(session: { files: SessionFilesClient; startProgram?: SessionStartClient }): { files: NodeFiles; start?: NodeStart } {
  const { startProgram } = session;
  const start: NodeStart | undefined = startProgram === undefined ? undefined : (program, cancel) => startProgram.call(session, [...program.argv], {
    cwd: program.cwd,
    ...(program.env === undefined ? {} : { env: { ...program.env } }),
    ...(program.stdin === null ? {} : { stdin: program.stdin }),
    signal: cancel,
  });
  const client = session.files;
  const statOf = async (path: string, follow: boolean): Promise<RuntimeVfsStat> => {
    const syscall = follow ? 'stat' : 'lstat';
    const stat = follow ? await client.stat(path) : await client.lstat(path);
    if (stat === null) throw fsError('ENOENT', syscall, path);
    return runtimeStatOf(stat, syscall, path);
  };
  const files: NodeFiles = {
    async readFile(path) {
      const bytes = await client.readBytes(path);
      if (bytes === null) throw fsError('ENOENT', 'open', path);
      return bytes;
    },
    async readFileString(path) {
      const text = await client.read(path);
      if (text === null) throw fsError('ENOENT', 'open', path);
      return text;
    },
    writeFile: (path, data) => client.write(path, data),
    exists: (path) => client.exists(path),
    stat: (path) => statOf(path, true),
    lstat: (path) => statOf(path, false),
    async readdir(path): Promise<RuntimeVfsDirEntry[]> {
      return (await client.list(path)).map((entry) => ({ name: entry.name, type: DIRENT_TYPES[entry.type] ?? 'unknown' }));
    },
    appendFile: (path, data) => client.appendFile(path, data),
    realpath: (path) => client.realpath(path),
    symlink: (target, path) => client.symlink(target, path),
    // readlink(2) tells no link (EINVAL) from nothing there (ENOENT), where the session answers null for both.
    async readlink(path) {
      const text = await client.readlink(path);
      if (text !== null) return text;
      throw fsError((await client.lstat(path)) === null ? 'ENOENT' : 'EINVAL', 'readlink', path);
    },
    mkdir: (path, options) => client.mkdir(path, { recursive: options?.recursive ?? false, ...(options?.mode === undefined ? {} : { mode: options.mode }) }),
    unlink: (path) => client.unlink(path),
    rmdir: (path) => client.rmdir(path),
    rmdirRecursive: (path) => client.delete(path, { recursive: true }),
    rename: (from, to) => client.rename(from, to),
    chmod: (path, mode) => client.chmod(path, mode),
    chown: (path, uid, gid, follow) => client.chown(path, uid, gid, { followSymlinks: follow }),
    truncate: (path, size) => client.truncate(path, size),
  };
  return start === undefined ? { files } : { files, start };
}
