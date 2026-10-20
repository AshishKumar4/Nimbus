/**
 * The W7 wave's contracts: what a wave's caller asks (WriteStreamOptions)
 * and is answered (WriteBatchStreamResult), the namespace that places its
 * records (WaveRouter), and the storage seam the session's filesystem opens
 * for each wave (WaveScope), through which WaveIngest commits what lands
 * there. Shared by the ingestion, the engine, the runtime bridges and the
 * clients that send waves.
 */

import { CHUNK_SIZE } from '@nimbus-sh/platform/limits.js';
import {
  w7ChunkCount,
  type BatchChunkEntry,
  type BatchInodeEntry,
  type VfsInodeKind,
  type W7Attrs,
  type W7DataCall,
  type W7DecodedRecord,
  type W7PathCall,
} from '@nimbus-sh/platform/w7-frame.js';
import type { CreditLease } from '@nimbus-sh/platform/weighted-credit-pool.js';
import { parentKey } from '../vfs/path.js';
import type { VfsOpenDescription, VfsStat } from '../vfs/sqlite-vfs.js';
import { vfsError } from '../vfs/vfs-error.js';
import type { VfsCred } from './os-contracts.js';
import type { MountedFileDescription } from './descriptors.js';
import type { PinnedName } from '../vfs/composite.js';
import type { Awaitable } from '../vfs/vfs.js';

export interface WriteBatchStreamProgress {
  /** 1-based sequence of the last durable publish group; zero means none. */
  committedGroupSequence: number;
  committedPathCount: number;
  /**
   * The wave's operations committed, in order: each removal, directory,
   * file, rename, truncate, attribute change and call counts one. On a
   * refusal, the refused operation is the one at this index.
   */
  committedOps: number;
  inodes: number;
  chunks: number;
  /** Each published file and link, by the path the stream named, as stat will report it. */
  receipts: WriteStreamReceipt[];
  /** A sequenced wave's answer (WriteStreamOptions.sequence). */
  sequence?: WaveSequenceAnswer;
  /** Each call, rename, truncate and attribute change the wave committed here (not on a mount): what its maker dates its own copy by. */
  mutations?: WaveMutation[];
  /**
   * The session's revision as it answers a wave whose writer has nothing
   * held for publication: every op of the wave committed here, in this
   * attempt or an earlier one whose answer was lost, and every earlier one of
   * its writer's, is published at or before it. Absent on a `held` answer.
   */
  revision?: number;
  /**
   * Answered at its commit while a commit of its writer's is held for its
   * publication (SqliteVFS.as's `continues`; its own, or, for a resend, the
   * attempt's before it): what its writer's runtime waits for before an
   * effect leaves by a way the session's gate does not see
   * (RuntimeFsBridge.published).
   */
  held?: true;
}

/**
 * One op a wave committed (`index`, its place among the wave's ops, from 0):
 * its path's revision right before it and the session's right after, read
 * in the turn it committed, as a single call's receipt has them
 * (VfsMutationReceipt): a copy dated at or above `before` was current, and
 * with this op on it is current at `after`.
 */
export interface WaveMutation {
  index: number;
  before: number;
  after: number;
}

/**
 * A sequenced writer's wave (a process's filesystem client): its ops are
 * numbered `first`, `first + 1`, … in order, under `writer` (the pid and
 * writer epoch the session admits the wave under). The session keeps, per
 * writer, the highest number it has committed (its cursor), moved in the
 * transaction that commits that op, so an op a re-sent wave carries again
 * is answered, never applied twice. `ack`: the highest cursor the writer
 * has had answered; the refusal stored for it is dropped.
 */
export interface WaveSequence {
  writer: string;
  first: number;
  ack: number;
  /** The process whose writer it is: what the session keeps of the process (its waves' open descriptions) is kept under it. */
  pid: number;
}

/**
 * What a sequenced wave committed: every op up to `cursor`. `refused`: the
 * op the session refused (its number, its errno); nothing after it in the
 * wave was applied. The same answer comes back for a re-send of the wave.
 */
export interface WaveSequenceAnswer {
  cursor: number;
  refused?: { seq: number; errno: string; message: string };
}

/** A streamed file's stat as published: what a producer's git index entry records. */
export interface WriteStreamReceipt {
  path: string;
  /** An `open` call's: the session's descriptor of the description it opened (WaveDescriptions.open). */
  handle?: number;
  ino: number;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  uid: number;
  gid: number;
  dev: number;
  /** The session's revision once a call's file landed: what its writeFile answers. */
  revision?: number;
  /** A copyFile's: the file it copied (its key) and that file's revision then; bytes held of it at that revision or later are the copy's. */
  from?: { path: string; revision: number };
  /** A copyFile's: the key it wrote, its destination's links followed as the session followed them. */
  landed?: string;
}

/**
 * A wave's consecutive calls that commit together, in one transaction (the
 * stream's call group): at most this many, or this many bytes of their
 * data. Measured in process: a writeFile call alone cost 177 us, most of it
 * its own commit (2026-10-07, apply-prof); a group pays that once.
 */
export const CALL_GROUP_OPS = 512;
export const CALL_GROUP_BYTES = 1024 * 1024;

/** The longest target a routed symbolic link takes, in bytes: PATH_MAX, as symlink(2) bounds it. */
export const ROUTED_LINK_TARGET_MAX = 4096;

/**
 * The largest file a wave writes to a mount. A routed file is one
 * whole-file writeFile, its bytes held until that call under credit its
 * record reserves whole when it is admitted (so an admitted record always
 * finishes; at most the shared write credit, MAX_GLOBAL_WRITE_STREAM_CREDIT_BYTES,
 * and half of it, so a held file never starves the wave); a larger one is
 * refused (ENOTSUP, naming this) before anything is touched. A backend that
 * declares an atomic streaming write could take more; none does yet.
 */
export const ROUTED_FILE_MAX = 4 * 1024 * 1024;

/**
 * The most bytes one data call (W7DataCall: a writeFile, appendFile or
 * write at an offset) carries. Its bytes are held until the call is made,
 * under credit its record reserves whole when it begins, as a routed
 * file's are; a client splits a larger write into pieces of this size
 * (process-fs-client's DATA_PIECE_BYTES, WAVE_BYTES). A larger call is
 * refused (EINVAL) before any of its bytes are read.
 */
export const DATA_CALL_MAX = 4 * 1024 * 1024;

/** `cred` with the umask a process's call was made under, when the call carries one (W7Call umask). */
export function withUmask(cred: VfsCred, umask: number | undefined): VfsCred {
  return umask === undefined || umask === cred.umask ? cred : { ...cred, umask };
}

/**
 * A wave's record that the namespace places on a mount (WaveRouter.apply),
 * each the single call a program would make there. Paths are where the
 * namespace's lookup placed them ('/'-rooted, the directory's links
 * resolved). A link is made at `slot` beside its name first: a name the
 * wave owns (its id and the record's index), renamed over the link's.
 */
export type RoutedWaveRecord =
  | { readonly type: 'delete'; readonly path: string }
  | { readonly type: 'directory'; readonly path: string; readonly mode: number }
  | { readonly type: 'file'; readonly path: string; readonly mode: number; readonly bytes: Uint8Array }
  | { readonly type: 'symlink'; readonly path: string; readonly target: string; readonly slot: string }
  /** A process's call (W7Call), made by the namespace's operation of that name, its data whole. */
  | { readonly type: 'call'; readonly call: W7PathCall }
  | { readonly type: 'data-call'; readonly call: W7DataCall; readonly path: string; readonly mode: number; readonly bytes: Uint8Array; readonly offset?: number }
  /** A process's rename, truncate or attribute change (W7 v4), made by the namespace's operation of that name. */
  | { readonly type: 'rename'; readonly from: string; readonly to: string }
  | { readonly type: 'truncate'; readonly path: string; readonly size: number }
  /** `description`: through the session's open description of that id, its file whatever names it now. */
  | { readonly type: 'setattr'; readonly path: string; readonly attrs: W7Attrs; readonly description?: string };

/** A routed name's stat once published: what its receipt reports. */
export interface RoutedStat {
  readonly ino: number;
  readonly mode: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly uid: number;
  readonly gid: number;
  readonly dev: number;
}

/**
 * The namespace above the session's filesystem (WaveIngest): every record
 * of every wave, whoever streams it, is placed by its lookup, and one it
 * places on a mount is applied there by its own operations. ProcessFiles
 * ingests through its CompositeVFS.
 */
export interface WaveRouter {
  /**
   * The namespace path ('/'-rooted) directory `path` resolves to by the
   * mutations' lookup (CompositeVFS.mutationRoute, links followed). A tail
   * that does not exist yet is kept as named, after the nearest ancestor
   * that resolves. Synchronous while the lookup stays on synchronous
   * backends, so a commit can recheck a placement in its own turn, and the
   * wave runs it as its writer (WaveScope.asWriter).
   */
  resolveDirectory(path: string, cred: VfsCred, signal?: AbortSignal): string | Promise<string>;
  /** The mount a mutation at resolved namespace path `path` lands on, or null when it is this filesystem's alone. */
  placement(path: string): string | null;
  /** The namespace's mount-table generation (CompositeVFS.mountGeneration): a placement made under another may be stale. */
  mounts(): number;
  /**
   * Whether resolved namespace path `path` is a directory the namespace
   * composes (one above a mount point): a removal of it is EBUSY and a file
   * or link at it EISDIR, before anything commits.
   */
  composes(path: string): boolean;
  /**
   * Apply `record` on the namespace as `cred`; `guard` runs right before
   * each call to the backend (the wave's admission and cancellation). A
   * refusal throws its errno. Answers the published name's stat, for its
   * receipt (null for a removal). `owner`, the wave's exclusive-mutation
   * lease, is presented to the namespace's lease check, as a group commit
   * presents it here.
   */
  apply(record: RoutedWaveRecord, cred: VfsCred, guard: () => void, owner?: string): Promise<RoutedStat | null>;
  /**
   * open(2) of a name the namespace places on a mount (W7Call open), decided
   * as every open is (openOnMount), `guard` run right before it changes
   * anything: the name it found (CompositeVFS.pin, presenting `owner`, never
   * the wave's admission: a description outlives its wave) and its stat.
   */
  open(call: Extract<W7PathCall, { call: 'open' }>, cred: VfsCred, guard: () => void, owner?: string): Promise<{ file: PinnedName; stat: RoutedStat }>;
}

/**
 * How far an earlier attempt of the same fenced wave may have reached into
 * mounted records (`prior`: the highest record index, -1 for none), and how
 * this attempt notes its own (`note`, before the backend is called). A
 * mounted record cannot be deduplicated, so one an earlier attempt may have
 * applied is refused as outcome-unknown rather than applied again.
 */
export interface WaveMountReach {
  readonly prior: number;
  note(index: number): void;
}

/** How a wave is applied (writeStream): its cancellation, lease, timing, admission and mount reach. */
export interface WriteStreamOptions {
  decodeDrainStartedAt?: number;
  signal?: AbortSignal;
  mutationOwner?: string;
  /** Right before each commit: the fenced wave is still admitted (SupervisorDeliveries.admitWave). */
  admit?: () => void;
  /** Between committed groups: the isolate is given to whatever else it hosts (another session), never to this one. */
  turn?: () => Promise<void>;
  mountReach?: WaveMountReach;
  sequence?: WaveSequence;
  /** The writing process's open descriptions, for its `open`, `close` and description calls (W7Call description). */
  descriptions?: WaveDescriptions;
}

/**
 * A process's open descriptions as its waves name them (W7Call
 * `description`): kept by the binding that serves the process, as its
 * descriptors are (SqliteRuntimeFsBridge), so the process reads, stats and
 * closes them as its own. Each one's access was decided at its open: a later
 * chmod, chown, rename or unlink never changes what it can do, and its file
 * lives until its last close.
 */
export interface WaveDescriptions {
  /**
   * Open `id`, a description of the file `ino` numbers with `rights`, its
   * access decided already (SqliteVFS.describeInode): the session's
   * descriptor of it, or null when no file has that number any more.
   */
  adopt(id: string, ino: number, rights: { read: boolean; write: boolean }, path: string, cred: VfsCred): number | null;
  /** The description `id` names on this filesystem, or undefined (never opened, closed, or a mount's). */
  node(id: string): VfsOpenDescription | undefined;
  /** The description of a file on a mount `id` names (describe), or undefined (never opened, closed, or this filesystem's). */
  mounted(id: string): MountedFileDescription | undefined;
  /**
   * Keep the file at `file`, the name a wave's open of a name on a mount
   * found (WaveRouter.open), as description `id` (PinnedName.hold), each
   * write in its mount before it is answered: the session's descriptor of
   * it, which the process reads, stats and closes as any of its own.
   */
  describe(id: string, file: PinnedName, ino: number, rights: { read: boolean; write: boolean }): Awaitable<number>;
  /** The session's descriptor of `id`, or undefined. */
  handle(id: string): number | undefined;
  /** Closes `id`: its last close's answer (lastClose), which a mount's description's backend may await. */
  close(id: string): Awaitable<void>;
}

export type WriteBatchStreamFailurePhase = 'decode' | 'stage' | 'validation' | 'publish';

export type WriteBatchStreamResult =
  | (WriteBatchStreamProgress & { ok: true })
  | (WriteBatchStreamProgress & {
      ok: false;
      error: {
        code: 'ERR_WRITE_BATCH_STREAM';
        phase: WriteBatchStreamFailurePhase;
        message: string;
        /** The refusal's errno (EACCES, EEXIST, EROFS, …) when the filesystem refused; absent otherwise. */
        errno?: string;
        /**
         * Placing the op after the cursor met a delegation the session recalls
         * first (vfs/recall.ts RecallRequired), the recall started, before
         * anything of that op applied: no refusal is kept, so the same ops sent
         * again apply once it is over. Never set where the op took effect (a
         * close that consumed its description, a commit).
         */
        recall?: true;
      };
    });

/**
 * Abort a stream commit when ANY of the given signals fires. AbortSignal.any
 * is not in every runtime this code ships to, so the combination is a small
 * linked controller instead.
 */
export function linkedSignal(signals: readonly (AbortSignal | undefined)[]): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const listeners: Array<() => void> = [];
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) { controller.abort(signal.reason); break; }
    const onAbort = (): void => controller.abort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    listeners.push(() => signal.removeEventListener('abort', onAbort));
  }
  return { signal: controller.signal, dispose: () => { for (const remove of listeners) remove(); } };
}

/**
 * `work`, something a wave waits for, raced with the wave's `signal`: once
 * it aborts, the wave goes on at once (ending refused), and a late answer is
 * `discard`ed. The namespace's guard starts no backend call after the abort
 * (WaveRouter.apply).
 */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined, discard?: (late: T) => void): Promise<T> {
  if (signal === undefined) return work;
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { work.then((late) => discard?.(late), () => {}); reject(signal.reason); };
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    work.then(
      (value) => { signal.removeEventListener('abort', abort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}

/** A data call's file (W7DataCall), its bytes gathered whole: what the session applies it as. */
export interface WaveDataCallFile {
  path: string;
  call: W7DataCall;
  mode: number;
  ino?: number;
  offset?: number;
  umask?: number;
  description?: string;
}

/**
 * One of a wave's ops that lands on the session's filesystem and is applied
 * by the namespace's operation of that name (a call, a rename, truncate or
 * attribute change, a data call with its bytes whole). `made`: run once the
 * data call is applied, refused or not.
 */
export type WaveLocalOp =
  | Extract<W7DecodedRecord, { type: 'call' | 'rename' | 'truncate' | 'setattr' }>
  | { type: 'data-call'; file: WaveDataCallFile; bytes: Uint8Array; made(): void };

/** What one commit of a wave's file group published. */
export interface WaveFileGroup {
  paths: number;
  inodes: number;
  chunks: number;
  receipts: WriteStreamReceipt[];
}

/**
 * A wave's files on the session's filesystem (WaveScope.files): each staged
 * as its chunks arrive, held in the pending group until it commits, and
 * authorised there, in the turn that commits it.
 */
export interface WaveFiles {
  /** Whether a completed file waits in the group. */
  readonly pending: boolean;
  /** Commit the pending group (a group of only a file in flight stages its chunks). */
  flush(): void;
  /** Whether a piece of `bytes` would close the group. */
  wouldExceedPieces(bytes: number): boolean;
  /** A file's begin: placed where its name lands, and authorised now when too large to commit whole. */
  begin(inode: BatchInodeEntry): void;
  chunk(record: Extract<W7DecodedRecord, { type: 'file-chunk' }>): void;
  end(record: Extract<W7DecodedRecord, { type: 'file-end' }>): void;
  /** Stage the file held whole so far and commit the group: every chunk lease it held is given back. */
  release(): void;
  /** What the wave staged and never published, given back (the wave's end, whatever ended it). */
  abandon(): void;
}

/** What a wave's files group asks of the wave around each commit. */
export interface WaveFileHooks {
  /** Right before the commit: the wave is still admitted. */
  admit(): void;
  /** Right before the commit, in its turn: the names it publishes are placed again. */
  recheck(names: Iterable<string>): void;
  /** The commit's own publication reshaped nothing a name resolves through: the store's revision before it, and the one it made. */
  published(before: number, revision: number): void;
  committed(group: WaveFileGroup): void;
}

/**
 * The session's filesystem as one wave sees it (CredentialedVfs.wave): its
 * caller's credential, origin, delegations and lease, taken in the caller's
 * turn, and the storage operations the wave's ingestion composes.
 */
export interface WaveScope {
  readonly cred: VfsCred;
  /** The wave's cancellation: its caller's signal, and the engine's cut (cancelStreams). */
  readonly signal: AbortSignal;
  /** The exclusive-mutation lease the wave writes under. */
  readonly mutationOwner: string | undefined;
  readonly deviceId: number;
  /** `fn` as the wave's writer: the delegations it holds, which its lookups recall none of. */
  asWriter<T>(fn: () => T): T;
  /** A record of the wave changes `path` on a mounted backend: a captured run of its process cannot put that back (SqliteVFS.captureRun). */
  landsElsewhere(path: string): void;
  /** The store's revision now. */
  revision(): number;
  /** `path`'s revision, as its caller names it. */
  pathRevision(path: string): number;
  /** Whether a delegation or read lease is held that a record could meet. */
  leased(): boolean;
  /** A record landing at `path` waits for any other holder there to give it up. */
  recall(path: string): Promise<void>;
  /** The wave's decode drain, timed: each wait for a record, and its end. */
  decodeDrain(startedAt: number): { waited(ms: number): void; end(): void };
  /** A wait for credit begins: its end. */
  creditWait(): () => void;
  /** The engine's shared write credit. */
  readonly credit: {
    tryAcquire(bytes: number): CreditLease | null;
    acquire(bytes: number, signal?: AbortSignal): Promise<CreditLease>;
  };
  files(hooks: WaveFileHooks): WaveFiles;
  /** Whether `count` directories fit one batch. */
  directoriesFit(count: number): boolean;
  /** Commit one batch of directories: the inodes it made. */
  commitDirectories(inodes: readonly BatchInodeEntry[]): number;
  /** Remove `path` and everything below it: how many entries it removed. */
  commitDelete(path: string): number;
  /** The leading directories and removals, checked together before any commits. */
  checkLeading(directories: readonly BatchInodeEntry[], deletes: readonly string[]): void;
  /** A directory or file a delegation's holder makes is owned as its caller's (its owner, a setgid directory's group). */
  adoptCreation(inode: BatchInodeEntry, directory: boolean): void;
  /**
   * Apply `calls` in one transaction, each after the revision its path had,
   * with the writer's cursor moved to each one's number: the results and
   * the store's revision after; or, rolled back whole, the index of the one
   * refused and its error.
   */
  commitCalls(
    calls: readonly { path: string; seq: number | null; op: WaveLocalOp }[],
    writer: string | null,
  ): { at: number; error: unknown } | { befores: number[]; results: (VfsStat | null | void)[]; after: number };
  /** An open the cursor passed, answered again as it was. */
  reopened(path: string, id: string): WriteStreamReceipt | null;
  /** What the session kept of the wave's process's description `id` (vfs_wave_descriptions) is no longer this filesystem's: a mount's description took the id, or closed it. */
  forgetDescription(id: string): void;
  /** The writer's cursor and any refusal kept for it (WaveSequence), acknowledging `ack`. */
  openSequence(sequence: WaveSequence): { cursor: number; refused: NonNullable<WaveSequenceAnswer['refused']> | null };
  /** The writer's cursor moved to `seq`, in a transaction of its own. */
  advanceSequence(writer: string, seq: number): void;
  /** The op `refused.seq` refused, kept as its answer; `closed`: a description its close ended, forgotten with it. */
  refuseInSequence(writer: string, refused: NonNullable<WaveSequenceAnswer['refused']>, closed?: { pid: number; id: string }): void;
}

export function inodeKind(inode: Pick<BatchInodeEntry, 'kind' | 'isDir'>): VfsInodeKind {
  const kind = inode.kind ?? (inode.isDir ? 'directory' : 'file');
  if (kind !== 'file' && kind !== 'directory' && kind !== 'symlink') {
    throw vfsError('EINVAL', `invalid inode kind ${String(kind)}`);
  }
  return kind;
}

export function validateFileChunks(inode: BatchInodeEntry, chunks: readonly BatchChunkEntry[]): void {
  validateInodeShape(inode);
  if (inode.chunkCount !== chunks.length) {
    throw vfsError('EINVAL', inode.path, `expected ${inode.chunkCount} chunks, got ${chunks.length}`);
  }
  let total = 0;
  const ordered = [...chunks].sort((a, b) => a.chunkId - b.chunkId);
  for (let index = 0; index < ordered.length; index++) {
    const chunk = ordered[index];
    if (chunk.chunkId !== index) {
      throw vfsError('EINVAL', inode.path, `expected chunk ${index}, got ${chunk.chunkId}`);
    }
    const expected = Math.min(CHUNK_SIZE, inode.size - (index * CHUNK_SIZE));
    if (chunk.data.byteLength !== expected) {
      throw vfsError('EINVAL', inode.path, `chunk ${index} has ${chunk.data.byteLength} bytes; expected ${expected}`);
    }
    total += chunk.data.byteLength;
  }
  if (total !== inode.size) {
    throw vfsError('EINVAL', inode.path, `chunk bytes ${total} do not match size ${inode.size}`);
  }
}

export function validateInodeShape(inode: BatchInodeEntry): void {
  const kind = inodeKind(inode);
  const expectedParent = parentKey(inode.path);
  if (inode.parentPath !== expectedParent) {
    throw vfsError('EINVAL', inode.path, `parentPath ${inode.parentPath} does not match ${expectedParent}`);
  }
  if (inode.isDir !== (kind === 'directory')) {
    throw vfsError('EINVAL', inode.path, `inode kind ${kind} conflicts with isDir=${inode.isDir}`);
  }
  if (!Number.isSafeInteger(inode.size) || inode.size < 0) {
    throw vfsError('EINVAL', inode.path, `invalid size ${inode.size}`);
  }
  if (!Number.isSafeInteger(inode.chunkCount) || inode.chunkCount < 0) {
    throw vfsError('EINVAL', inode.path, `invalid chunk count ${inode.chunkCount}`);
  }
  if (kind === 'directory' && inode.size !== 0) {
    throw vfsError('EINVAL', inode.path, 'directory size must be zero');
  }
  const expectedChunkCount = kind === 'directory' ? 0 : w7ChunkCount(inode.size);
  if (inode.chunkCount !== expectedChunkCount) {
    throw vfsError(
      'EINVAL',
      `${inode.path}: expected ${expectedChunkCount} chunks for ${inode.size} bytes, got ${inode.chunkCount}`,
    );
  }
}
