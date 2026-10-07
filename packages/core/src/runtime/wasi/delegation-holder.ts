/**
 * A WASI process as a delegation's holder (spike/delegation/MEMO.md, P4a):
 * inside the subtrees it holds, the process decides its creates, writes,
 * mkdirs, unlinks, renames and attribute changes itself, against what its
 * resident store knows and what it decided, with no round trip, and logs
 * them as calls into the process's filesystem client (process-fs-client.ts,
 * P4b), which takes the subtrees, numbers the log and sends it, in order:
 * at each point where what it wrote could be observed (a socket send, an
 * fsync, the end of its run) and when the session recalls a subtree.
 *
 * What it decides is the session's answer, kept exactly:
 *   - A subtree is held once the process has mutated in it often enough to
 *     be worth it (the client's policy): the deepest existing directory
 *     holding the name it changes, a bounded number of them. Never the
 *     whole filesystem, a home directory itself, or the session's stores
 *     (the session refuses those), and never a subtree with a default ACL
 *     in it (its inheritance is the session's to apply): there, the process
 *     writes through as before.
 *   - Refusals are the walk's own (resolve), and the cases decided here are
 *     the plain ones: a create where the parent is a writable directory, a
 *     mkdir, an unlink of a file or link, a rename of a file, or of a
 *     directory to a free name outside itself, within one held subtree. Any
 *     other mutation in a held subtree sends the log first and is the
 *     session's, as before.
 *   - A name made here is numbered from the grant's reserved inode range and
 *     keeps that number in the session; it is owned as the session makes a
 *     holder's names (the process's, a setgid directory's group), its mode
 *     the asked mode less the umask.
 *   - The log keeps program order: each decision is logged as it is made,
 *     and a file's bytes, which change write by write, are logged whole (its
 *     latest) before the next decision is, or at the flush.
 *
 * A recall is answered by a loop per grant on the host side of the process:
 * a guest that waits in a syscall lets it run; one computing does not
 * (the documented limit, answered by the session's recall timeout).
 */

import type { RuntimeFileHandle, RuntimeVfsDirEntry } from '../os-contracts.js';
import type { ResidentEntry } from './resident-filesystem.js';
import { fsError, modeAllows } from '../beneath-walk.js';
import type { W7Attrs } from '@nimbus-sh/platform/w7-frame.js';
import { processFsClient, type ProcessFsClient, type ProcessFsGrant, type ProcessFsOp, type ProcessFsSession } from '../../_shared/process-fs-client.js';

/** Descriptors this holder opens are numbered below every session descriptor. */
const FIRST_LOCAL_HANDLE = -1;

/** What the holder reads of the process's resident store (its own decisions aside). */
export interface HolderStore {
  readonly device: number;
  readonly cred: { uid: number; gid: number; groups: readonly number[] };
  /** As ResidentNamespace.entry: undefined when the store does not know. */
  entry(key: string): ResidentEntry | null | undefined;
  /** As ResidentNamespace.children. */
  children(key: string): RuntimeVfsDirEntry[] | undefined;
}

export interface HolderOptions {
  /** The session the process's filesystem client sends to and takes its grants from. */
  readonly session: ProcessFsSession;
  readonly store: HolderStore;
  /** Every engine key that is a home directory (`home/<name>`): never held itself. */
  readonly isHomeRoot?: (key: string) => boolean;
  /** Told when what the holder decided changed the namespace the store shows (the barrier is owed after a send). */
  readonly sent?: () => void;
  /** The clock files are stamped with. */
  readonly now?: () => number;
  /** Mutations in a subtree before it is taken (the client's GRANT_AFTER). */
  readonly grantAfter?: number;
}

/** A file made or rewritten here: its bytes until they are sent. */
interface LocalFile {
  key: string;
  bytes: Uint8Array;
  length: number;
  mode: number;
}

interface LocalHandle {
  file: LocalFile;
  readable: boolean;
  writable: boolean;
  append: boolean;
  position: number;
  path: string;
}

/** The decisions the process made in a held subtree, not yet sent. */
export interface DelegationHolder {
  /** The process's filesystem client: what the holder decided is logged into it. */
  readonly client: ProcessFsClient;
  /** What the process decided is at `key`: an entry, null (removed), or undefined (nothing decided). */
  entry(key: string): ResidentEntry | null | undefined;
  /** The names in `key`, as `base` lists them with what the process decided there. */
  children(key: string, base: RuntimeVfsDirEntry[] | undefined): RuntimeVfsDirEntry[] | undefined;
  /** The bytes of a file made or rewritten here. */
  content(entry: ResidentEntry): Uint8Array | undefined;
  /** Whether `handleId` is one of the holder's own descriptors. */
  owns(handleId: number): boolean;
  /**
   * Decide an open that creates or empties a file at `key` (resolved, its
   * parent known): a descriptor of the holder's, or undefined when the
   * session is to decide it.
   */
  open(key: string, path: string, flags: { read?: boolean; write?: boolean; append?: boolean; create?: boolean; truncate?: boolean; exclusive?: boolean; mode?: number }): RuntimeFileHandle | undefined;
  read(handleId: number, offset: number | null, length: number): Uint8Array;
  write(handleId: number, offset: number | null, bytes: Uint8Array): number;
  seek(handleId: number, offset: number, whence: 'set' | 'current' | 'end'): number;
  ftruncate(handleId: number, size: number): void;
  fstat(handleId: number): ResidentEntry;
  close(handleId: number): void;
  /** The name a descriptor of the holder's writes, now. */
  keyOf(handleId: number): string;
  /** Another descriptor of the same open file (its position shared). */
  dup(handleId: number): RuntimeFileHandle;
  /** Decide a mkdir at `key`: true when decided here (and done), false when the session is to. */
  mkdir(key: string, path: string, mode: number): boolean;
  /** Decide an unlink of `key` (a file or link): true when decided here. */
  unlink(key: string, path: string): boolean;
  /** Decide a rename of `from` to `to` (both resolved): true when decided here. */
  rename(from: string, to: string, path: string): boolean;
  /** Decide an attribute change of `key`: true when decided here. */
  setattr(key: string, attrs: W7Attrs): boolean;
  /** Whether a mutation at `key` would be decided here (a held subtree holds it). */
  holds(key: string): boolean;
  /** Whether anything decided here is not sent yet. */
  pending(): boolean;
  /** Send everything decided, in order. A refusal is thrown (the run fails, naming it). */
  flush(): Promise<void>;
  /** The end of the run: send everything, and give every subtree back. */
  settle(): Promise<void>;
  /** Waves sent, recalls answered, and grants taken. */
  stats(): { waves: number; ops: number; recalls: number; grants: number; widened: number };
}

function parentKey(key: string): string {
  const at = key.lastIndexOf('/');
  return at < 0 ? '' : key.slice(0, at);
}

function nameOf(key: string): string {
  return key.slice(key.lastIndexOf('/') + 1);
}

function within(key: string, root: string): boolean {
  return key === root || key.startsWith(`${root}/`);
}

export function delegationHolder(options: HolderOptions): DelegationHolder {
  const { store } = options;
  const now = options.now ?? Date.now;
  /** Decided entries (null: removed) and decided names per directory. */
  const decided = new Map<string, ResidentEntry | null>();
  const added = new Map<string, Map<string, RuntimeVfsDirEntry['type']>>();
  const removed = new Map<string, Set<string>>();
  /** Files whose bytes are here, by inode number. */
  const files = new Map<number, LocalFile>();
  const handles = new Map<number, LocalHandle>();
  let nextHandle = FIRST_LOCAL_HANDLE;
  /** Files written since their bytes were last logged, in the order last written. */
  const dirty = new Set<LocalFile>();

  /** Log each file's latest bytes, in the order last written, under the name it has now. */
  const drain = (): void => {
    for (const file of [...dirty]) {
      dirty.delete(file);
      client.submit({ type: 'call', call: { call: 'writeFile', path: file.key, mode: file.mode, data: file.bytes.subarray(0, file.length) } }, { acknowledged: true });
    }
  };

  /** Forget what was decided under `root`: sent, so the store (after its barrier) answers. */
  const dropDecisions = (root: string): void => {
    drain();
    for (const key of [...decided.keys()]) if (within(key, root)) decided.delete(key);
    for (const key of [...added.keys()]) if (within(key, root)) added.delete(key);
    for (const key of [...removed.keys()]) if (within(key, root)) removed.delete(key);
    options.sent?.();
  };

  const client = processFsClient({
    session: options.session,
    now,
    ...(options.isHomeRoot === undefined ? {} : { isHomeRoot: options.isHomeRoot }),
    ...(options.grantAfter === undefined ? {} : { grantAfter: options.grantAfter }),
    released: dropDecisions,
    drain,
  });

  /** Log a decision, after the bytes written before it. */
  const log = (op: ProcessFsOp): void => {
    drain();
    client.submit(op, { acknowledged: true });
  };

  const entryOf = (key: string): ResidentEntry | null | undefined => {
    const own = decided.get(key);
    return own !== undefined ? own : store.entry(key);
  };

  /** The ownership a new name under `parent` takes: the process's, with a setgid directory's group. */
  const ownership = (parent: ResidentEntry): { uid: number; gid: number; setgid: boolean } => {
    const setgid = (parent.mode & 0o2000) !== 0;
    return { uid: store.cred.uid, gid: setgid ? parent.gid : store.cred.gid, setgid };
  };

  const note = (dir: string, name: string, type: RuntimeVfsDirEntry['type'] | null): void => {
    if (type === null) {
      added.get(dir)?.delete(name);
      let gone = removed.get(dir);
      if (gone === undefined) removed.set(dir, gone = new Set());
      gone.add(name);
    } else {
      removed.get(dir)?.delete(name);
      let made = added.get(dir);
      if (made === undefined) added.set(dir, made = new Map());
      made.set(name, type);
    }
  };

  /** The parent of `key`, when the process may make a name in it: a known, writable, searchable directory of the session's filesystem. */
  const writableParent = (key: string, path: string, syscall: string): ResidentEntry | undefined => {
    const parent = entryOf(parentKey(key));
    if (parent === undefined || parent === null || parent.dev !== store.device) return undefined;
    if (parent.type !== 'directory') throw fsError('ENOTDIR', syscall, path);
    if (!modeAllows(parent, 3, store.cred)) throw fsError('EACCES', syscall, path);
    return parent;
  };

  /** The file's bytes changed: logged whole before the next decision, or at the flush. */
  const written = (file: LocalFile): void => {
    dirty.delete(file);
    dirty.add(file);
  };

  const handleOf = (handleId: number): LocalHandle => {
    const handle = handles.get(handleId);
    if (handle === undefined) throw fsError('EBADF', 'fd', String(handleId));
    return handle;
  };

  const room = (file: LocalFile, length: number): boolean => {
    if (length <= file.bytes.byteLength) return true;
    const grant = client.held(file.key);
    const size = Math.max(length, file.bytes.byteLength * 2, 4096);
    if (grant === undefined || !client.draw(grant, size - file.bytes.byteLength)) return false;
    const next = new Uint8Array(size);
    next.set(file.bytes.subarray(0, file.length));
    file.bytes = next;
    return true;
  };

  /** What the session refused of what was decided here: the run fails, naming it. */
  const failed = (): void => {
    const failures = client.takeFailures();
    if (failures.length > 0) {
      throw new Error(`the session refused what this process decided: ${failures.map((failure) => `${failure.op} ${failure.path}: ${failure.message}`).join('; ')}`);
    }
  };

  const holder: DelegationHolder = {
    client,
    entry: (key) => decided.get(key),

    children: (key, base) => {
      const made = added.get(key);
      const gone = removed.get(key);
      if (made === undefined && gone === undefined) return base;
      // A directory made here has no names but the ones made in it; one the
      // store has not listed is listed first (undefined asks for that).
      const madeHere = store.entry(key) === null || (store.entry(key) === undefined && decided.get(key)?.type === 'directory');
      if (base === undefined && !madeHere) return undefined;
      const out = new Map<string, RuntimeVfsDirEntry['type']>();
      for (const child of base ?? []) if (!gone?.has(child.name)) out.set(child.name, child.type);
      for (const [name, type] of made ?? []) out.set(name, type);
      return [...out].map(([name, type]) => ({ name, type }));
    },

    content: (entry) => {
      if (entry.dev !== store.device) return undefined;
      const file = files.get(entry.ino);
      return file === undefined ? undefined : file.bytes.slice(0, file.length);
    },

    owns: (handleId) => handles.has(handleId),

    open: (key, path, flags) => {
      if (!flags.write || flags.append) return undefined;
      if (!flags.create && !flags.truncate) return undefined;
      // Set-id and sticky bits asked at creation are the session's to grant or strip.
      if (((flags.mode ?? 0o666) & 0o7000) !== 0) return undefined;
      const current = entryOf(key);
      if (current === undefined || (current !== null && current.type !== 'file')) return undefined;
      const grant = client.holder(key);
      if (grant === undefined) return undefined;
      if (current !== null && flags.exclusive && flags.create) throw fsError('EEXIST', 'open', path);
      if (current === null && !flags.create) throw fsError('ENOENT', 'open', path);
      let file: LocalFile;
      if (current === null) {
        const parent = writableParent(key, path, 'open');
        if (parent === undefined) return undefined;
        const ino = client.number(grant);
        if (ino === undefined) return undefined;
        const { uid, gid } = ownership(parent);
        const stamp = now();
        const asked = (flags.mode ?? 0o666) & 0o777;
        const entry: ResidentEntry = {
          type: 'file', dev: store.device, ino, nlink: 1, size: 0, atime: stamp, mtime: stamp, ctime: stamp,
          mode: 0o100000 | (asked & ~grant.umask), uid, gid, revision: 0, target: null,
        };
        decided.set(key, entry);
        note(parentKey(key), nameOf(key), 'file');
        file = { key, bytes: new Uint8Array(0), length: 0, mode: asked };
        files.set(ino, file);
        // Made here: the name exists from now on, empty, in the log's order.
        log({ type: 'call', call: { call: 'writeFile', path: key, mode: asked, ino, data: new Uint8Array(0) } });
      } else {
        // An existing file emptied: decided here, its number the session's.
        if (!modeAllows(current, 2, store.cred)) throw fsError('EACCES', 'open', path);
        file = files.get(current.ino) ?? { key, bytes: new Uint8Array(0), length: 0, mode: current.mode & 0o7777 };
        file.length = 0;
        files.set(current.ino, file);
        decided.set(key, { ...current, size: 0, mtime: now(), ctime: now() });
        written(file);
      }
      const id = nextHandle--;
      handles.set(id, { file, readable: !!flags.read, writable: true, append: false, position: 0, path });
      return { id, path } as RuntimeFileHandle;
    },

    read: (handleId, offset, length) => {
      const handle = handleOf(handleId);
      if (!handle.readable) throw fsError('EBADF', 'read', handle.path);
      const start = Math.min(offset ?? handle.position, handle.file.length);
      const chunk = handle.file.bytes.slice(start, Math.min(handle.file.length, start + length));
      if (offset === null) handle.position = start + chunk.byteLength;
      return chunk;
    },

    write: (handleId, offset, bytes) => {
      const handle = handleOf(handleId);
      const file = handle.file;
      const start = offset ?? handle.position;
      const end = start + bytes.byteLength;
      if (!room(file, end)) throw fsError('ENOSPC', 'write', handle.path);
      if (start > file.length) file.bytes.fill(0, file.length, start);
      file.bytes.set(bytes, start);
      file.length = Math.max(file.length, end);
      if (offset === null) handle.position = end;
      const entry = decided.get(file.key);
      if (entry) decided.set(file.key, { ...entry, size: file.length, mtime: now(), ctime: now() });
      written(file);
      return bytes.byteLength;
    },

    seek: (handleId, offset, whence) => {
      const handle = handleOf(handleId);
      const position = (whence === 'set' ? 0 : whence === 'current' ? handle.position : handle.file.length) + offset;
      if (position < 0) throw fsError('EINVAL', 'lseek', handle.path);
      handle.position = position;
      return position;
    },

    ftruncate: (handleId, size) => {
      const handle = handleOf(handleId);
      const file = handle.file;
      if (!room(file, size)) throw fsError('ENOSPC', 'ftruncate', handle.path);
      if (size > file.length) file.bytes.fill(0, file.length, size);
      file.length = size;
      const entry = decided.get(file.key);
      if (entry) decided.set(file.key, { ...entry, size, mtime: now(), ctime: now() });
      written(file);
    },

    fstat: (handleId) => {
      const handle = handleOf(handleId);
      const entry = decided.get(handle.file.key) ?? store.entry(handle.file.key);
      if (!entry) throw fsError('EBADF', 'fstat', handle.path);
      return { ...entry, size: handle.file.length };
    },

    close: (handleId) => { handleOf(handleId); handles.delete(handleId); },

    keyOf: (handleId) => handleOf(handleId).file.key,

    dup: (handleId) => {
      const handle = handleOf(handleId);
      const id = nextHandle--;
      handles.set(id, handle);
      return { id, path: handle.path } as RuntimeFileHandle;
    },

    mkdir: (key, path, mode) => {
      if ((mode & 0o7000) !== 0) return false;
      const current = entryOf(key);
      if (current === undefined) return false;
      const grant = client.holder(key);
      if (grant === undefined) return false;
      if (current !== null) throw fsError('EEXIST', 'mkdir', path);
      const parent = writableParent(key, path, 'mkdir');
      if (parent === undefined) return false;
      const ino = client.number(grant);
      if (ino === undefined) return false;
      const { uid, gid, setgid } = ownership(parent);
      const stamp = now();
      const perm = (mode & 0o777 & ~grant.umask) | (setgid ? 0o2000 : 0);
      decided.set(key, {
        type: 'directory', dev: store.device, ino, nlink: 2, size: 0, atime: stamp, mtime: stamp, ctime: stamp,
        mode: 0o40000 | perm, uid, gid, revision: 0, target: null,
      });
      note(parentKey(key), nameOf(key), 'directory');
      added.set(key, added.get(key) ?? new Map());
      log({ type: 'call', call: { call: 'mkdir', path: key, mode: mode & 0o777, ino } });
      return true;
    },

    unlink: (key, path) => {
      const current = entryOf(key);
      if (current === undefined || current === null || current.type === 'directory') return false;
      if (client.holder(key) === undefined) return false;
      if (writableParent(key, path, 'unlink') === undefined) return false;
      decided.set(key, null);
      note(parentKey(key), nameOf(key), null);
      const local = files.get(current.ino);
      if (local !== undefined && local.key === key) {
        files.delete(current.ino);
        // Its bytes go with it: nothing of them is logged.
        dirty.delete(local);
      }
      log({ type: 'call', call: { call: 'unlink', path: key } });
      return true;
    },

    rename: (from, to, path) => {
      const source = entryOf(from);
      const target = entryOf(to);
      if (source === undefined || source === null || target === undefined) return false;
      if (source.type === 'directory' && (target !== null || within(to, from))) return false;
      if (target !== null && (target.type === 'directory' || source.type === 'directory')) return false;
      const grant = client.holder(from);
      if (grant === undefined || client.held(to) !== grant) return false;
      if (from === to) return true;
      if (writableParent(from, path, 'rename') === undefined || writableParent(to, path, 'rename') === undefined) return false;
      // What was written before the rename is logged under the name it had.
      drain();
      // What was decided under the source moves with it.
      for (const [key, value] of [...decided]) {
        if (key !== from && within(key, from)) { decided.delete(key); decided.set(to + key.slice(from.length), value); }
      }
      for (const map of [added, removed] as Map<string, unknown>[]) {
        for (const [key, value] of [...map]) if (within(key, from)) { map.delete(key); map.set(to + key.slice(from.length), value); }
      }
      decided.set(from, null);
      decided.set(to, { ...source, ctime: now() });
      note(parentKey(from), nameOf(from), null);
      note(parentKey(to), nameOf(to), source.type);
      for (const file of files.values()) if (within(file.key, from)) file.key = to + file.key.slice(from.length);
      log({ type: 'rename', from, to });
      return true;
    },

    setattr: (key, attrs) => {
      const current = entryOf(key);
      if (current === undefined || current === null) return false;
      if (client.holder(key) === undefined) return false;
      // Only the owner (or root) changes a mode or times here; anything else is the session's to refuse.
      if (store.cred.uid !== 0 && store.cred.uid !== current.uid) return false;
      if ('uid' in attrs) return false;
      const next: ResidentEntry = 'mode' in attrs
        ? { ...current, mode: (current.mode & ~0o7777) | (attrs.mode & 0o7777), ctime: now() }
        : { ...current, atime: attrs.atime, mtime: attrs.mtime, ctime: now() };
      decided.set(key, next);
      const local = files.get(current.ino);
      if (local !== undefined && 'mode' in attrs) local.mode = attrs.mode & 0o7777;
      log({ type: 'setattr', path: key, attrs });
      return true;
    },

    holds: (key) => client.held(key) !== undefined,
    pending: () => dirty.size > 0 || client.pending(),
    flush: async () => {
      await client.flush();
      options.sent?.();
      failed();
    },
    settle: async () => {
      drain();
      await client.settle();
      options.sent?.();
    },
    stats: () => {
      const stats = client.stats();
      return { waves: stats.waves, ops: stats.ops, recalls: stats.recalls, grants: stats.grants, widened: stats.widened };
    },
  };
  return holder;
}
