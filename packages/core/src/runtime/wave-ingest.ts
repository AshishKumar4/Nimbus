/**
 * W7 ingestion: a wave's records, read in order, each applied where the
 * namespace places a mutation of that name (WaveRouter): on the session's
 * SQLite filesystem through the storage seam its caller's view opens
 * (CredentialedVfs.wave, WaveScope), or on a mount by the namespace's own
 * operations. The ingestion decides routing, numbering (WaveSequence), call
 * grouping, credit and turns; the storage seam decides what a commit is
 * (staging, authorisation, transactions, publication). ProcessFiles ingests
 * with its namespace as the router; a filesystem without one ingests with none.
 */

import { acquireSupervisorRunningAllocation, tryAcquireSupervisorRunningAllocation } from '@nimbus-sh/platform/heavy-alloc-coord.js';
import { decodeWriteBatchStream, encodeWriteBatchStream, type BatchInodeEntry, type BatchWritePayload, type W7DataCall, type W7DecodedRecord } from '@nimbus-sh/platform/w7-frame.js';
import type { CreditLease } from '@nimbus-sh/platform/weighted-credit-pool.js';
import { concatBytes, nameDec } from '../_shared/bytes.js';
import type { CredentialedVfs } from '../vfs/sqlite-vfs.js';
import { SYSCALL_VERDICTS, errnoCodeOf, vfsError, type VfsErrorCode } from '../vfs/vfs-error.js';
import { parentKey } from '../vfs/path.js';
import {
  CALL_GROUP_BYTES,
  CALL_GROUP_OPS,
  DATA_CALL_MAX,
  ROUTED_FILE_MAX,
  ROUTED_LINK_TARGET_MAX,
  untilAborted,
  validateFileChunks,
  validateInodeShape,
  withUmask,
  type WaveDescriptions,
  type WaveLocalOp,
  type WaveRouter,
  type WaveScope,
  type WriteBatchStreamFailurePhase,
  type WriteBatchStreamProgress,
  type WriteBatchStreamResult,
  type WriteStreamOptions,
  type WriteStreamReceipt,
} from './wave-contracts.js';
import type { MountedFileDescription } from './descriptors.js';
import type { RuntimeVfsStat } from './os-contracts.js';

/** A routed file arriving: where it was named and placed, and its chunks held until its call. */
interface RoutedFile {
  named: string;
  placed: string;
  link: boolean;
  mode: number;
  size: number;
  held: { data: Uint8Array; release(): void }[];
  index: number;
  /** What its record reserved when admitted (its whole size), and how much of it its chunks have not drawn yet. */
  credit: { left: number; lease: CreditLease | null };
  /** A process's data call (W7Call), made by the namespace's call of that name. */
  call?: W7DataCall;
  /** A 'write' call's offset. */
  offset?: number;
  /** A writeFile's or appendFile's umask (W7Call umask). */
  umask?: number;
  /** A write or append through the binding's description of a file on a mount: made on it, wherever its name leads now. */
  described?: MountedFileDescription;
}

/** A mounted description's answer, as the engine's is (WriteStreamReceipt): its file's stat now, and an open's descriptor. */
function receiptOf(path: string, now: RuntimeVfsStat, handle?: number): WriteStreamReceipt {
  return {
    path, ino: now.ino, mode: now.mode, size: now.size, mtimeMs: now.mtime, ctimeMs: now.ctime, uid: now.uid, gid: now.gid, dev: now.dev,
    ...(handle === undefined ? {} : { handle }),
  };
}

/** A re-sent open of a description the binding keeps on a mount: its answer again, as SqliteVFS.reopened gives one; null once its file is gone. */
async function reopenedOnMount(path: string, node: MountedFileDescription, handle: number | undefined, admit: () => void): Promise<WriteStreamReceipt | null> {
  try {
    return receiptOf(path, await node.stat(admit), handle);
  } catch (error) {
    const code = errnoCodeOf(error);
    if (code === 'ENOENT' || code === 'ESTALE') return null;
    throw error;
  }
}

type Placement = { resolved: string; epoch: number };

/** What a wave applies a routed record with (WaveIngest.routeRecord): its state, one per wave. */
interface Routing {
  file: RoutedFile | null;
  index: number;
  /** The wave's own name, for the slots its links are staged at. */
  waveId: string;
  routes: Map<string, Placement>;
  /** The view of the namespace the wave's placements are made in (consume's `view`). */
  view: () => number;
  /**
   * Where `named` lands, decided synchronously when it can be (placeSync
   * in consume): the namespace path on a mount, null when placed here
   * (and noted), undefined when only the asynchronous lookup decides.
   */
  placeSync: (kind: 'directory' | 'file' | 'delete', named: string) => string | null | undefined;
  /** A name placed on this filesystem: rechecked right before its commit. */
  placedHere: (kind: 'directory' | 'file' | 'delete', named: string, resolved: string, epoch: number) => void;
  reach?: WriteStreamOptions['mountReach'];
  /** The binding's descriptions (WriteStreamOptions.descriptions): a mounted one's calls are its own. */
  descriptions?: WaveDescriptions;
  guard: () => void;
  settleBefore: () => Promise<void>;
  /** The credit a mounted record's whole bytes take, granted before any of them is decoded. */
  reserve: (bytes: number) => Promise<CreditLease | null>;
  setPhase: (phase: WriteBatchStreamFailurePhase) => void;
  /** The record applied on its mount, with the bytes it wrote there. */
  committed: (receipt: WriteBatchStreamProgress['receipts'][number] | null, bytes: number) => void;
}


/** The paths a record lands at: where a delegation's holder is asked to give way first. */
function recordPaths(record: W7DecodedRecord): string[] {
  switch (record.type) {
    case 'delete': case 'truncate': case 'setattr': return [record.path];
    case 'directory': case 'file-begin': return [record.inode.path];
    case 'rename': return [record.from, record.to];
    case 'call': return record.call.call === 'copyFile' ? [record.call.path, record.call.from] : [record.call.path];
    default: return [];
  }
}

export class WaveIngest {
  constructor(private readonly router: WaveRouter | null) {}

  /** `stream`, a wave, applied as `view`'s caller (its credential, origin, delegations and lease). */
  writeStream(view: CredentialedVfs, stream: ReadableStream<Uint8Array>, options: WriteStreamOptions = {}): Promise<WriteBatchStreamResult> {
    return view.wave(options, (scope) => this.consume(scope, stream, options));
  }

  /**
   * writeBatch where the namespace places it. When every record is placed on
   * the session's filesystem by lookups made in this turn, the batch commits
   * there, atomic, in that same turn; otherwise (a record on a mount, or a
   * lookup that left the synchronous backends) it goes as a wave, each
   * record applied where it lands and rechecked at its commit, refused as a
   * whole call is (its error) at the first refusal. `signal` cancels it
   * before anything commits.
   */
  async writeBatch(view: CredentialedVfs, payload: BatchWritePayload, options: { signal?: AbortSignal } = {}): Promise<{ inodes: number; chunks: number }> {
    options.signal?.throwIfAborted();
    const names = [...payload.inodes.map((inode) => inode.path), ...(payload.deletePaths ?? [])];
    // Placed and committed in the caller's turn: its lookups recall none of what it holds.
    if (view.asCaller(() => this.placedHere(view, names, options.signal))) return view.writeBatch(payload);
    const result = await this.writeStream(view, encodeWriteBatchStream(payload), { signal: options.signal });
    if (!result.ok) throw Object.assign(new Error(result.error.message), result.error.errno === undefined ? {} : { code: result.error.errno });
    return { inodes: result.committedPathCount, chunks: result.chunks };
  }

  /**
   * Whether the namespace places every one of `names` (as `view`'s caller
   * names them) on the session's filesystem, by lookups made in this turn:
   * false when one lands on a mount or (unless `aboveMounts`) is a
   * directory above a mount point, when a lookup leaves the synchronous
   * backends, or when it fails. A caller that writes in this same turn
   * writes where the namespace would. `follow`: each name is looked up
   * whole, a link at it followed, as an operation that follows its name's
   * link (stat, chown, writeFile) is placed; else by its directory.
   */
  placesHere(view: CredentialedVfs, names: readonly string[], options?: { aboveMounts?: boolean; follow?: boolean }): boolean {
    return this.placedHere(view, names, undefined, options?.aboveMounts === true, options?.follow === true);
  }

  private placedHere(view: CredentialedVfs, names: readonly string[], signal?: AbortSignal, aboveMounts = false, follow = false): boolean {
    const router = this.router;
    if (router === null) return true;
    const routes = new Map<string, string>();
    for (const named of names) {
      // Routing asks the namespace about the original components, not a store-only resolution.
      const key = named.startsWith('/') ? named.slice(1) : named;
      const looked = follow ? key : parentKey(key);
      let resolved = routes.get(looked);
      if (resolved === undefined) {
        let answer: string | Promise<string>;
        try {
          answer = looked === '' ? '/' : router.resolveDirectory('/' + looked, view.cred, signal);
        } catch {
          return false;
        }
        if (answer instanceof Promise) { answer.catch(() => {}); return false; }
        resolved = answer;
        routes.set(looked, resolved);
      }
      const path = follow ? resolved : `${resolved === '/' ? '' : resolved}/${key.slice(key.lastIndexOf('/') + 1)}`;
      // On a mount, or a directory above a mount point: the namespace's to answer.
      if (router.placement(path) !== null || (!aboveMounts && router.composes(path))) return false;
    }
    return true;
  }

  private async consume(scope: WaveScope, stream: ReadableStream<Uint8Array>, options: WriteStreamOptions): Promise<WriteBatchStreamResult> {
    const { cred, signal } = scope;
    /** What the wave waits for that does not take its signal: ended by its cut too (untilAborted). */
    const unlessCut = <T>(work: Promise<T>, discard?: (late: T) => void): Promise<T> => untilAborted(work, signal, discard);
    const drain = scope.decodeDrain(options.decodeDrainStartedAt ?? performance.now());
    let recordIterator: AsyncIterator<W7DecodedRecord> | null = null;
    let recordIteratorFinished = false;
    /** A call's file (W7DataCall), its bytes gathered until its end. */
    let callFile: {
      path: string;
      call: W7DataCall;
      mode: number;
      size: number;
      ino?: number;
      offset?: number;
      umask?: number;
      description?: string;
      parts: Uint8Array[];
      /** Its whole size, reserved when it began: its chunks draw on it, and it is given back once the call is made. */
      credit: { left: number; lease: CreditLease | null };
    } | null = null;
    /** Reserved for data calls not yet made (callFile's credit): given back at each call, or when the wave ends. */
    const callLeases = new Set<CreditLease>();
    const progress: WriteBatchStreamProgress = {
      committedGroupSequence: 0,
      committedPathCount: 0,
      committedOps: 0,
      inodes: 0,
      chunks: 0,
      receipts: [],
    };
    let phase: WriteBatchStreamFailurePhase = 'decode';
    const router = this.router;
    /** A file the namespace places on a mount, its chunks handed to the router as they arrive. */
    let routedFile: RoutedFile | null = null;
    /** Each directory's resolved namespace path and the view it was resolved in, until a link or removal of the wave's. */
    const routes = new Map<string, Placement>();
    /**
     * The namespace as the wave's placements see it: `epoch` numbers the
     * views, `revision` is the store's revision the current one holds at.
     * The wave's own commit of files that are not links changes no directory
     * a later name resolves through, so the view holds across it. Anything
     * else that commits (another writer, or the wave's own links, removals
     * and directories) starts a new view, and every name placed in an older
     * one is resolved again: without this, each commit of the wave's own
     * files sent every later record back through the namespace's lookup.
     */
    const view = { revision: scope.revision(), mounts: router?.mounts() ?? 0, epoch: 0 };
    const viewEpoch = (): number => {
      const mounts = router?.mounts() ?? 0;
      const revision = scope.revision();
      if (revision !== view.revision || mounts !== view.mounts) { view.revision = revision; view.mounts = mounts; view.epoch++; }
      return view.epoch;
    };
    /**
     * Names the namespace placed on this filesystem, by the commit that
     * publishes them, each dated by the revision it was placed at. Right
     * before that commit, in its turn, each is placed again (resolved anew
     * when anything has been committed since): a peer that repointed a link
     * between the placement and the commit, or a mount made there, refuses
     * the wave (ESTALE) instead of writing rows a mount hides.
     */
    const placedHere = {
      directory: new Map<string, Placement>(),
      file: new Map<string, Placement>(),
      delete: new Map<string, Placement>(),
    };
    /**
     * Where `named` lands, decided in this turn when the lookup of its
     * directory answers synchronously (it stays on this filesystem's
     * backends): the namespace path when that is on a mount; null when it
     * is placed here, noted for its commit to recheck. Undefined when the
     * lookup would wait, or would refuse (a directory above a mount point,
     * a lookup that fails): routeRecord decides those, with its errors.
     */
    const placeSync = (kind: 'directory' | 'file' | 'delete', named: string): string | null | undefined => {
      if (router === null) return null;
      const parent = parentKey(named);
      const epoch = viewEpoch();
      let route = routes.get(parent);
      // A directory this wave placed in this view, not made yet: its names go under where it was placed.
      const made = placedHere.directory.get(parent);
      if ((route === undefined || route.epoch !== epoch) && made !== undefined && made.epoch === epoch) {
        route = { resolved: made.resolved, epoch };
        routes.set(parent, route);
      }
      if (route === undefined || route.epoch !== epoch) {
        let answer: string | Promise<string>;
        try {
          answer = parent === '' ? '' : scope.asWriter(() => router.resolveDirectory('/' + parent, cred, signal));
        } catch {
          return undefined;
        }
        if (typeof answer !== 'string') { answer.catch(() => {}); return undefined; }
        route = { resolved: answer, epoch };
        routes.set(parent, route);
      }
      const path = `${route.resolved === '/' ? '' : route.resolved}/${named.slice(named.lastIndexOf('/') + 1)}`;
      if (router.placement(path) !== null) return path;
      if (kind !== 'directory' && router.composes(path)) return undefined;
      placedHere[kind].set(named, { resolved: path, epoch });
      return null;
    };
    /** The wave's close calls, by number: a refused one forgets its description as an applied one does. */
    const closing = new Map<number, string>();
    /**
     * A record that lands on this filesystem, decided without an await: a
     * file (not a link) or directory placed here by placeSync, a chunk or end
     * of a file no mount takes, or the batch's end. Every other record (a
     * removal, a call, a link) goes to routeRecord.
     */
    const landsHere = (record: W7DecodedRecord): boolean => {
      if (routedFile !== null) return false;
      switch (record.type) {
        case 'file-chunk':
        case 'file-end':
        case 'batch-end':
          return true;
        case 'file-begin':
          // A description's write is its file's, wherever that is named now:
          // a mount's is routed to it, any other is this filesystem's (EBADF
          // for one not open), never placed by its name.
          if (record.inode.description !== undefined) return options.descriptions?.mounted(record.inode.description) === undefined;
          return record.inode.kind !== 'symlink' && placeSync('file', record.inode.path) === null;
        case 'directory':
          return placeSync('directory', record.inode.path) === null;
        default:
          return false;
      }
    };
    /** This wave's own name: the slots its routed links are staged at. */
    const waveId = crypto.randomUUID().slice(0, 8);
    /** Place `names` again, the ones this commit publishes, and forget them. */
    const recheck = (placements: Map<string, Placement>, names: Iterable<string>): void => {
      if (router === null || placements.size === 0) return;
      const resolvedNow = new Map<string, string | null>();
      for (const named of names) {
        const placed = placements.get(named);
        if (placed === undefined) continue;
        placements.delete(named);
        let now = placed.resolved;
        if (placed.epoch !== viewEpoch()) {
          const parent = parentKey(named);
          let dir = resolvedNow.get(parent);
          if (dir === undefined) {
            let answer: string | Promise<string> | null;
            try {
              answer = parent === '' ? '' : scope.asWriter(() => router.resolveDirectory('/' + parent, cred));
            } catch {
              answer = null;
            }
            // A lookup that leaves this filesystem's synchronous backends left it.
            if (answer instanceof Promise) { answer.catch(() => {}); answer = null; }
            dir = answer;
            resolvedNow.set(parent, dir);
          }
          now = dir === null ? '' : `${dir === '/' ? '' : dir}/${named.slice(named.lastIndexOf('/') + 1)}`;
        }
        if (now !== placed.resolved || router.placement(now) !== null || (placements !== placedHere.directory && router.composes(now))) {
          throw vfsError('ESTALE', named, 'the namespace changed under the wave: this name no longer lands where the wave placed it');
        }
      }
    };
    /** The index of the record being applied, as committedOps counts them. */
    let recordIndex = -1;

    // A turn waits for storage (NimbusSession.waveTurn), so it is owed per
    // group's worth of committed work, not per commit: after each file group
    // and directory batch (a transaction's bound apiece), and after a call
    // group's worth (CALL_GROUP_OPS, CALL_GROUP_BYTES) of the removals, calls
    // and routed records that commit one by one.
    let turnOwed = false;
    let opsSinceTurn = 0;
    let bytesSinceTurn = 0;
    const owe = (ops: number, bytes: number): void => {
      opsSinceTurn += ops;
      bytesSinceTurn += bytes;
      if (opsSinceTurn >= CALL_GROUP_OPS || bytesSinceTurn >= CALL_GROUP_BYTES) turnOwed = true;
    };
    const takeTurn = async (): Promise<void> => {
      turnOwed = false;
      opsSinceTurn = 0;
      bytesSinceTurn = 0;
      await unlessCut(options.turn!());
    };

    // The pending publish group of the wave's files: kept by the storage
    // seam, committed in its turn after its names are placed again.
    const files = scope.files({
      // In the turn that commits: a fenced wave overtaken by its re-send stops here.
      admit: () => options.admit?.(),
      recheck: (names) => recheck(placedHere.file, names),
      // The wave's own commit of files that are not links: the view holds across it
      // when nothing else had committed since it was taken.
      published: (before, revision) => { if (before === view.revision) view.revision = revision; },
      committed: (group) => {
        progress.committedGroupSequence++;
        progress.committedPathCount += group.paths;
        progress.committedOps += group.paths;
        progress.inodes += group.inodes;
        progress.chunks += group.chunks;
        progress.receipts.push(...group.receipts);
        turnOwed = true;
      },
    });

    // Directory upserts batch on their own: authorising a file consults the
    // committed inode tree for its parent, so directories flush before the
    // first file record rather than sharing the file group.
    let pendingDirectories: BatchInodeEntry[] = [];
    let directoryBatches: BatchInodeEntry[][] = [];
    const commitDirectoryBatch = (): boolean => {
      const inodes = directoryBatches.shift() ?? pendingDirectories;
      if (inodes === pendingDirectories) pendingDirectories = [];
      if (inodes.length === 0) return false;
      options.admit?.();
      recheck(placedHere.directory, inodes.map((inode) => inode.path));
      const made = scope.commitDirectories(inodes);
      progress.committedGroupSequence++;
      progress.committedPathCount += inodes.length;
      progress.committedOps += inodes.length;
      progress.inodes += made;
      turnOwed = true;
      return true;
    };
    const flushDirectories = (): void => {
      if (leading) throw new Error('internal: the leading directories commit only through endLeading');
      while (commitDirectoryBatch());
    };

    // A removal observes everything the stream wrote before it.
    const commitDelete = (path: string): void => {
      files.flush();
      flushDirectories();
      options.admit?.();
      recheck(placedHere.delete, [path]);
      const affected = scope.commitDelete(path);
      progress.committedGroupSequence++;
      progress.committedPathCount += affected;
      progress.committedOps++;
      owe(affected, 0);
    };

    // The wave's leading removals and directories (an encoder sends them
    // before its first file) are held until the first file or the end, and
    // checked together before any of them commits: a directory record over
    // a symbolic link they do not remove refuses the wave with nothing
    // committed. Then the removals commit, then the directories, in batches
    // the plan's accounting bounds.
    let leading = true;
    let leadingDeletes: string[] = [];
    // Once checked: the removals to commit, then the directories (held aside until the removals are in).
    let deletesToCommit: string[] = [];
    let directoriesToBatch: BatchInodeEntry[] | null = null;
    /** Commit the leading phase's next group: whether one was there. */
    const commitLeadingStep = (): boolean => {
      const path = deletesToCommit.shift();
      if (path !== undefined) {
        commitDelete(path);
        return true;
      }
      if (directoriesToBatch !== null) {
        let batch: BatchInodeEntry[] = [];
        for (const inode of directoriesToBatch) {
          if (!scope.directoriesFit(batch.length + 1)) {
            directoryBatches.push(batch);
            batch = [];
          }
          batch.push(inode);
        }
        if (batch.length > 0) directoryBatches.push(batch);
        directoriesToBatch = null;
      }
      return commitDirectoryBatch();
    };
    /**
     * The one way the leading phase ends, whatever ends it (a file, a call,
     * a routed record, the batch's end): checked, then committed a group a
     * turn when the caller gives turns.
     */
    const endLeading = async (): Promise<void> => {
      phase = 'publish';
      scope.asWriter(queueLeading);
      while (scope.asWriter(commitLeadingStep)) {
        if (options.turn !== undefined && turnOwed && (deletesToCommit.length > 0 || directoriesToBatch !== null || directoryBatches.length > 0)) await takeTurn();
      }
    };
    const queueLeading = (): void => {
      if (!leading) return;
      leading = false;
      const deletes = leadingDeletes;
      leadingDeletes = [];
      scope.checkLeading(pendingDirectories, deletes);
      // Held aside while the removals commit (commitDelete flushes what is
      // pending), then batched as the plan's accounting bounds (commitLeadingStep).
      directoriesToBatch = pendingDirectories;
      pendingDirectories = [];
      deletesToCommit = deletes;
    };

    // Give back every lease this stream holds: commit its group, and stage
    // the file it holds whole so far, whose pieces then commit with it.
    const releaseHeldCredit = (): void => {
      files.release();
      // Data calls gathered and not yet made hold their whole size: made now,
      // they give it back (a wave waiting with them held could be what every
      // other wave's wait needs).
      if (pendingCalls.length > 0) flushCalls();
    };

    // A stream waits for credit only once it holds none: a lease it kept
    // while waiting could be the one its wait needs (two streams over the
    // small-request reserve each waited on the other's held chunks, for good).
    const awaitCredit = async <T>(
      tryAcquire: () => T | null,
      acquire: () => Promise<T>,
    ): Promise<T> => {
      const granted = tryAcquire();
      if (granted !== null) return granted;
      releaseHeldCredit();
      const waited = scope.creditWait();
      try {
        return tryAcquire() ?? await acquire();
      } finally {
        waited();
      }
    };

    const acquireCredit = async (byteLength: number, abort?: AbortSignal): Promise<CreditLease> => {
      const writeLease = await awaitCredit(
        () => scope.credit.tryAcquire(byteLength),
        () => scope.credit.acquire(byteLength, abort),
      );
      let supervisorLease: CreditLease;
      try {
        // A running facet's wave: running work, never held up by a launch that is not running (the lock order).
        supervisorLease = await awaitCredit(
          () => tryAcquireSupervisorRunningAllocation(byteLength),
          () => acquireSupervisorRunningAllocation(byteLength, abort),
        );
      } catch (error) {
        writeLease.release();
        throw error;
      }

      let released = false;
      return {
        bytes: byteLength,
        release: () => {
          if (released) return;
          released = true;
          writeLease.release();
          supervisorLease.release();
        },
      };
    };

    const retainChunk = async (byteLength: number, abort?: AbortSignal): Promise<CreditLease> => {
      // A mounted file's chunk: covered by what its record reserved when admitted.
      const covered = routedFile?.credit ?? callFile?.credit;
      if (covered !== undefined) {
        covered.left -= byteLength;
        return { bytes: byteLength, release: () => {} };
      }
      if (files.wouldExceedPieces(byteLength)) files.flush();
      return acquireCredit(byteLength, abort);
    };

    // A sequenced writer's wave (WaveSequence): its ops are numbered from
    // `first`, and one the writer's cursor has passed is answered, never
    // applied again.
    const sequence = options.sequence === undefined ? null : { spec: options.sequence, cursor: 0 };
    /** The number of the op being applied: a refusal now is its answer. */
    let applying: number | null = null;
    /** A re-sent data call the cursor has passed: its chunks are drained, not applied. */
    let skipping: string | null = null;
    const advanced = (seq: number): void => {
      sequence!.cursor = seq;
      progress.sequence = { cursor: seq };
      applying = null;
    };
    /**
     * The wave's calls not yet committed: consecutive ones commit together,
     * in one transaction with their cursor's moves (flushCalls), at the next
     * record that is no call, or once the group is full. Each is applied by
     * the namespace's own operation, in order, and answered with its path's
     * revision right before it and the session's after (WaveMutation); a
     * data call with its file's stat.
     */
    type PendingCall = { index: number; seq: number | null; path: string; paths: number; op: WaveLocalOp; receipt: boolean };
    /**
     * Where `named` leads now, its leaf followed, as a key here; null when
     * the lookup waits on a mount or lands on one. The namespace's refusal
     * (EACCES, ENXIO, ELOOP) is the copy's: it throws.
     */
    const followedHere = (named: string): string | null => {
      const answer = scope.asWriter(() => router!.resolveDirectory('/' + named, cred, signal));
      if (typeof answer !== 'string') { answer.catch(() => {}); return null; }
      return router!.placement(answer) === null ? answer.slice(1) : null;
    };
    const pendingCalls: PendingCall[] = [];
    let pendingCallBytes = 0;
    const flushCalls = (): void => {
      if (pendingCalls.length === 0) return;
      // The op being decoded now (a routed one settling what came before it) stays the one being applied.
      const current = applying;
      const calls = pendingCalls.splice(0);
      const callBytes = pendingCallBytes;
      pendingCallBytes = 0;
      phase = 'publish';
      options.admit?.();
      const writer = sequence?.spec.writer ?? null;
      // A copy commits on what its names lead to now, in this turn, as the
      // namespace follows them; the engine would follow its own rows. One
      // that now leads off this filesystem was routed on a view gone stale.
      let stale: { at: number; error: unknown } | null = null;
      for (let at = 0; at < calls.length && router !== null; at++) {
        const op = calls[at]!.op;
        if (op.type !== 'call' || op.call.call !== 'copyFile') continue;
        let bound: { path: string | null; from: string | null };
        try {
          bound = { path: followedHere(op.call.path), from: followedHere(op.call.from) };
        } catch (error) {
          stale = { at, error };
          break;
        }
        if (bound.path === null || bound.from === null) {
          stale = { at, error: vfsError('ESTALE', op.call.path, 'a name the copy was placed by now leads elsewhere') };
          break;
        }
        calls[at] = { ...calls[at]!, op: { type: 'call', call: { call: 'copyFile', path: bound.path, from: bound.from } } };
      }
      let applied = stale === null ? scope.commitCalls(calls, writer)
        : stale.at === 0 ? { befores: [], results: [], after: 0 } : scope.commitCalls(calls.slice(0, stale.at), writer);
      let refused: { call: PendingCall; error: unknown } | null = stale === null ? null : { call: calls[stale.at]!, error: stale.error };
      if ('error' in applied) {
        // Rolled back whole: the calls before the one refused commit
        // together again (they did, before it), and its refusal is its answer.
        const at = applied.at;
        refused = { call: calls[at]!, error: applied.error };
        applied = at === 0 ? { befores: [], results: [], after: 0 } : scope.commitCalls(calls.slice(0, at), writer);
        if ('error' in applied) {
          applying = calls[applied.at]!.seq;
          throw applied.error;
        }
      }
      const { results, befores, after } = applied;
      // Read as the wave's writer: its receipts recall none of what it holds.
      scope.asWriter(() => results.forEach((result, at) => {
        const call = calls[at]!;
        progress.committedGroupSequence++;
        progress.committedPathCount += call.paths;
        progress.committedOps++;
        (progress.mutations ??= []).push({ index: call.index, before: befores[at]!, after });
        if (call.receipt && result) {
          // The revision its file was published at, as its path reports it.
          const handle: unknown = Reflect.get(result, 'handle');
          // A copy's source and the version it read, as the engine read it (nothing after moves it).
          const from: unknown = Reflect.get(result, 'from');
          const landed: unknown = Reflect.get(result, 'landed');
          progress.receipts.push({
            path: call.path, ino: result.ino, mode: result.mode, size: result.size, mtimeMs: result.mtime, ctimeMs: result.ctime,
            uid: result.uid, gid: result.gid, dev: scope.deviceId, revision: scope.pathRevision(call.path),
            ...(typeof handle === 'number' ? { handle } : {}),
            ...(from !== undefined ? { from: from as { path: string; revision: number } } : {}),
            ...(typeof landed === 'string' ? { landed } : {}),
          });
        }
        if (call.seq !== null) advanced(call.seq);
      }));
      owe(results.length, callBytes);
      if (refused !== null) {
        applying = refused.call.seq;
        throw refused.error;
      }
      applying = current;
    };
    /**
     * Queue `op` at the wave's current place, made at `path`. `alone`: it may
     * change where later names resolve (a removal, a link, a rename, an
     * attribute change), so it commits now, after the ones before it.
     */
    const queueCall = (path: string, op: WaveLocalOp, call: { bytes?: number; paths?: number; receipt?: boolean; alone?: boolean } = {}): void => {
      files.flush();
      flushDirectories();
      pendingCalls.push({ index: recordIndex, seq: applying, path, paths: call.paths ?? 1, op, receipt: call.receipt === true });
      applying = null;
      pendingCallBytes += call.bytes ?? 0;
      if (call.alone === true || pendingCalls.length >= CALL_GROUP_OPS || pendingCallBytes >= CALL_GROUP_BYTES) flushCalls();
    };

    // What a routed record is applied with (routeRecord): one per wave.
    const routing: Routing = {
      get file() { return routedFile; },
      set file(file) { routedFile = file; },
      get index() { return recordIndex; },
      waveId,
      routes,
      view: viewEpoch,
      placeSync,
      placedHere: (kind, named, resolved, epoch) => { placedHere[kind].set(named, { resolved, epoch }); },
      reach: options.mountReach,
      ...(options.descriptions === undefined ? {} : { descriptions: options.descriptions }),
      // Right before each call to the backend: the wave is still admitted, and not cancelled.
      guard: () => {
        signal.throwIfAborted();
        options.admit?.();
      },
      // Whatever the wave wrote here before the record commits first.
      settleBefore: async () => {
        flushCalls();
        await endLeading();
        flushDirectories();
        files.flush();
        options.admit?.();
      },
      reserve: (bytes) => (bytes === 0 ? Promise.resolve(null) : acquireCredit(bytes, signal)),
      setPhase: (next) => { phase = next; },
      committed: (receipt, bytes) => {
        progress.committedGroupSequence++;
        progress.committedPathCount++;
        progress.committedOps++;
        owe(1, bytes);
        if (receipt !== null) progress.receipts.push(receipt);
        // On a mount: the cursor moves once the backend has it, in a transaction of its own.
        if (sequence !== null && applying !== null) {
          const seq = applying;
          scope.advanceSequence(sequence.spec.writer, seq);
          advanced(seq);
        }
      },
    };

    try {
      if (sequence !== null) {
        const opened = scope.openSequence(sequence.spec);
        sequence.cursor = opened.cursor;
        progress.sequence = { cursor: opened.cursor };
        // A re-send of a wave whose op was refused: answered as it was, nothing after that op applied.
        if (opened.refused !== null && opened.refused.seq >= sequence.spec.first) {
          progress.sequence.refused = opened.refused;
          stream.cancel().catch(() => {});
          return {
            ok: false,
            ...progress,
            error: { code: 'ERR_WRITE_BATCH_STREAM', phase: 'publish', message: opened.refused.message, errno: opened.refused.errno },
          };
        }
      }
      const decoded = await unlessCut(decodeWriteBatchStream(stream, { signal, retainChunk }));
      recordIterator = decoded.records[Symbol.asyncIterator]();
      while (true) {
        if (options.turn !== undefined && turnOwed) await takeTurn();
        phase = 'decode';
        const waitStartedAt = performance.now();
        let next: IteratorResult<W7DecodedRecord>;
        try {
          next = await unlessCut(recordIterator.next(), (late) => { if (late.done !== true && late.value.type === 'file-chunk') late.value.retention.release(); });
        } finally {
          drain.waited(performance.now() - waitStartedAt);
        }
        if (next.done) {
          recordIteratorFinished = true;
          throw new Error('w7-frame: stream ended without batch-end');
        }
        const record = next.value;
        // A record that lands in another holder's delegation waits for it to
        // be given up first, here between records, where the stream may wait:
        // its group's commit would otherwise be refused.
        if (scope.leased()) {
          for (const lands of recordPaths(record)) await scope.recall(lands);
        }
        // A record that is no call: the calls before it commit first.
        const partOfCall = record.type === 'call' || (record.type === 'file-begin' && record.inode.call !== undefined)
          || (callFile !== null && (record.type === 'file-chunk' || record.type === 'file-end'));
        if (!partOfCall) flushCalls();
        if (record.type !== 'file-chunk' && record.type !== 'file-end' && record.type !== 'batch-end') recordIndex++;
        if (sequence !== null && record.type !== 'batch-end') {
          if (record.type === 'file-chunk' || record.type === 'file-end') {
            if (skipping !== null) {
              if (record.type === 'file-chunk') record.retention.release();
              else skipping = null;
              continue;
            }
          } else {
            // Numbered: a process's calls, renames, truncates and attribute changes; an upsert has no answer to keep.
            if (record.type === 'delete' || record.type === 'directory' || (record.type === 'file-begin' && record.inode.call === undefined)) {
              throw vfsError('EINVAL', record.type === 'delete' ? record.path : record.inode.path, 'a sequenced wave carries calls, renames, truncates and attribute changes, not upserts');
            }
            // Each op's number is its place in the wave (recordIndex counts ops, from 0).
            const seq = sequence.spec.first + recordIndex;
            if (seq <= sequence.cursor) {
              if (record.type === 'file-begin') skipping = record.streamContentId;
              // An open the cursor passed is answered again as it was (its
              // reply was lost): its description's descriptor and file.
              else if (record.type === 'call' && record.call.call === 'open' && record.call.description !== undefined) {
                const { path, description } = record.call;
                const mounted = options.descriptions?.mounted(description);
                const receipt = mounted === undefined
                  ? scope.asWriter(() => scope.reopened(path, description))
                  // Its mount's answer, which the wave's cut does not wait for (untilAborted), as every routed one.
                  : await untilAborted(reopenedOnMount(path, mounted, options.descriptions?.handle(description), () => scope.signal.throwIfAborted()), scope.signal);
                if (receipt !== null) progress.receipts.push(receipt);
              }
              continue;
            }
            applying = seq;
          }
        }
        // A close's answer is final whichever filesystem's description it closes (the refusal kept below).
        if (record.type === 'call' && record.call.call === 'close' && applying !== null) closing.set(applying, record.call.description);
        if (router !== null && !landsHere(record) && await this.routeRecord(record, router, scope, routing)) continue;
        // Only removals and directories are held in the leading phase: anything
        // else that lands here ends it first (a routed record ends it in settleBefore).
        if (leading && record.type !== 'delete' && record.type !== 'directory') await endLeading();
        // A call's bytes are gathered whole, and the call made at its end.
        if (record.type === 'file-begin' && record.inode.call !== undefined) {
          phase = 'validation';
          validateInodeShape(record.inode);
          if (record.inode.size > DATA_CALL_MAX) {
            throw vfsError('EINVAL', record.inode.path, `a data call carries at most ${DATA_CALL_MAX} bytes; this one is ${record.inode.size}`);
          }
          // What is ahead of it commits first, giving its credit back, so the
          // reservation below never waits on credit this wave holds.
          files.flush();
          flushDirectories();
          const lease = record.inode.size === 0 ? null : await acquireCredit(record.inode.size, signal);
          if (lease !== null) callLeases.add(lease);
          callFile = {
            path: record.inode.path, call: record.inode.call, mode: record.inode.mode, size: record.inode.size,
            ...(record.inode.ino === undefined ? {} : { ino: record.inode.ino }),
            ...(record.inode.offset === undefined ? {} : { offset: record.inode.offset }),
            ...(record.inode.umask === undefined ? {} : { umask: record.inode.umask }),
            ...(record.inode.description === undefined ? {} : { description: record.inode.description }),
            parts: [],
            credit: { left: record.inode.size, lease },
          };
          continue;
        }
        if (callFile !== null && record.type === 'file-chunk') {
          // Copied out, and the chunk's credit given back.
          callFile.parts.push(record.data.slice());
          record.retention.release();
          continue;
        }
        if (callFile !== null && record.type === 'file-end') {
          const file = callFile;
          callFile = null;
          phase = 'publish';
          const bytes = concatBytes(file.parts);
          file.parts = [];
          // Its bytes stay charged until the call is made.
          const lease = file.credit.lease;
          queueCall(file.path, {
            type: 'data-call', file, bytes,
            made: () => { if (lease !== null && callLeases.delete(lease)) lease.release(); },
          }, { bytes: bytes.byteLength, receipt: true });
          continue;
        }
        // A name a delegation's holder made is the caller's, as a create of
        // its own would make it: its owner, and a setgid directory's group.
        if (record.type === 'directory' || record.type === 'file-begin') scope.adoptCreation(record.inode, record.type === 'directory');
        // Each record is applied in one synchronous turn, by the stream's
        // caller: as the delegations it holds, whose lookups recall none of them.
        const ended = scope.asWriter((): boolean => {
          switch (record.type) {
            case 'delete': {
              phase = 'publish';
              if (leading) leadingDeletes.push(record.path);
              else commitDelete(record.path);
              break;
            }
            case 'directory': {
              phase = 'validation';
              validateFileChunks(record.inode, []);
              phase = 'publish';
              // Records commit in their order: files the stream wrote before
              // this directory commit before it.
              if (files.pending) files.flush();
              // Directory inodes carry no payload: rows are the only bound in
              // reach, priced by the plan's own accounting, so the strict batch
              // the flush commits always fits. The leading ones are bounded as
              // they commit (endLeading).
              if (!leading && !scope.directoriesFit(pendingDirectories.length + 1)) flushDirectories();
              pendingDirectories.push(record.inode);
              break;
            }
            case 'file-begin': {
              phase = 'validation';
              validateInodeShape(record.inode);
              phase = 'publish';
              // Authorising a file reads its parent from the committed inode
              // tree, so pending directories become visible first.
              flushDirectories();
              phase = 'validation';
              files.begin(record.inode);
              phase = 'stage';
              break;
            }
            case 'file-chunk': {
              phase = 'stage';
              files.chunk(record);
              break;
            }
            case 'file-end': {
              phase = 'publish';
              files.end(record);
              break;
            }
            case 'rename':
            case 'truncate':
            case 'setattr': {
              // Like a delete, it observes everything the stream wrote before it.
              phase = 'publish';
              queueCall(record.type === 'rename' ? record.from : record.path, record, { paths: record.type === 'rename' ? 2 : 1, alone: true });
              break;
            }
            case 'call': {
              // A call observes everything the stream wrote before it.
              phase = 'publish';
              const call = record.call;
              // A mkdir commits with the calls beside it; any other may change
              // where later names resolve, and commits now.
              queueCall(call.path, record, { alone: call.call !== 'mkdir', receipt: call.call === 'open' || call.call === 'copyFile' });
              break;
            }
            case 'batch-end':
              phase = 'publish';
              flushDirectories();
              files.flush();
              return true;
          }
          return false;
        });
        if (ended) {
          if (recordIterator.return) await recordIterator.return();
          recordIteratorFinished = true;
          drain.end();
          return { ok: true, ...progress };
        }
      }
    } catch (caught) {
      let error = caught;
      // The calls decoded before a stream that failed (cut, malformed) commit
      // as they would have: a re-send then carries only what came after them.
      if (pendingCalls.length > 0) {
        try { flushCalls(); } catch (refusal) { error = refusal; }
      }
      const errno = errnoCodeOf(error);
      // A close its binding carried out, whatever it then reported (lastClose:
      // what storing its writes failed with, an errno or none): its answer is
      // final, kept with the forgetting of its description, so no path
      // leaves a closed description to adopt again.
      const closeOf = applying === null ? undefined : closing.get(applying);
      const closed = closeOf !== undefined && options.descriptions?.handle(closeOf) === undefined ? closeOf : undefined;
      // The op being applied was refused: its answer, kept for a re-send; nothing after it applies.
      if (sequence !== null && applying !== null && (closed !== undefined || (errno !== undefined && SYSCALL_VERDICTS.has(errno as VfsErrorCode)))) {
        const refused = { seq: applying, errno: errno ?? 'EIO', message: error instanceof Error ? error.message : String(error) };
        try {
          scope.refuseInSequence(sequence.spec.writer, refused, closed === undefined ? undefined : { pid: sequence.spec.pid, id: closed });
          progress.sequence = { cursor: refused.seq, refused };
        } catch {
          // Not kept: the op is unanswered, and a re-send applies it again.
        }
      }
      return {
        ok: false,
        ...progress,
        error: {
          code: 'ERR_WRITE_BATCH_STREAM',
          phase,
          message: error instanceof Error ? error.message : String(error),
          ...(errno === undefined ? {} : { errno }),
        },
      };
    } finally {
      // What the wave staged and never published goes back to the store, and
      // every chunk lease it holds with it, before the decoder is let go.
      files.abandon();
      // Data calls the wave did not make: what they held goes back.
      for (const lease of callLeases) lease.release();
      callLeases.clear();
      // A routed file the wave did not finish: what it held goes back.
      const unfinished = routedFile as RoutedFile | null;
      if (unfinished !== null) {
        for (const chunk of unfinished.held) chunk.release();
        unfinished.credit.lease?.release();
        routedFile = null;
      }
      if (!recordIteratorFinished && recordIterator?.return) {
        try { await unlessCut(recordIterator.return()); } catch { /* preserve the primary stream result */ }
      }
      drain.end();
    }
  }

  /**
   * Route `record` through `router` when the namespace places it on a mount,
   * in its place in the wave: what the wave wrote here before it commits
   * first (`at.settleBefore`), then the namespace's own operation, with its
   * refusals (EROFS on a read-only mount, EACCES, ENOENT). A file's chunks
   * are handed to the router as they arrive, each held by the wave's credit
   * until the router has written it. True when the record was routed.
   */
  private async routeRecord(
    record: W7DecodedRecord,
    router: WaveRouter,
    scope: WaveScope,
    at: Routing,
  ): Promise<boolean> {
    const { cred } = scope;
    /** The exclusive-mutation lease the wave writes under, presented to the namespace's guard. */
    const owner = scope.mutationOwner;
    /** Every answer a mounted backend owes the wave, which its cut does not wait for (untilAborted). */
    const backend = <T>(work: Promise<T>): Promise<T> => untilAborted(work, scope.signal);
    /**
     * Where `named` lands, by the namespace's lookup: its directory resolved
     * (again when anything has committed since), then the name placed by the
     * mount table. The namespace path when that is on a mount; else null,
     * the placement noted with the revision its resolution saw, for its
     * commit to recheck. A removal of a directory above a mount point is
     * EBUSY and a file at one EISDIR, as the single call is, before anything
     * commits.
     */
    const mountOf = async (kind: 'directory' | 'file' | 'delete', named: string): Promise<string | null> => {
      const quick = at.placeSync(kind, named);
      if (quick !== undefined) return quick;
      const parent = parentKey(named);
      let route = at.routes.get(parent);
      const epoch = at.view();
      if (route === undefined || route.epoch !== epoch) {
        // Synchronous while the lookup stays on this filesystem's backends.
        const answer = parent === '' ? '' : scope.asWriter(() => router.resolveDirectory('/' + parent, cred, scope.signal));
        const resolved = typeof answer === 'string' ? answer : await backend(answer);
        route = { resolved, epoch };
        at.routes.set(parent, route);
      }
      const path = `${route.resolved === '/' ? '' : route.resolved}/${named.slice(named.lastIndexOf('/') + 1)}`;
      if (router.placement(path) !== null) return path;
      if (kind !== 'directory' && router.composes(path)) {
        throw vfsError(kind === 'delete' ? 'EBUSY' : 'EISDIR', named, 'a directory above a mount point');
      }
      at.placedHere(kind, named, path, route.epoch);
      return null;
    };
    /** Refuse a record an earlier attempt may have applied; note this one. */
    const reached = (): void => {
      if (at.reach === undefined) return;
      if (at.index <= at.reach.prior) {
        throw vfsError('EIO', `record ${at.index}`, 'outcome unknown: an earlier attempt of this wave may have applied this mounted record, which cannot be applied twice');
      }
      at.reach.note(at.index);
    };
    switch (record.type) {
      case 'delete': {
        // A removal may change where later names resolve.
        at.routes.clear();
        const placed = await mountOf('delete', record.path);
        if (placed === null) return false;
        at.setPhase('publish');
        await at.settleBefore();
        reached();
        await backend(router.apply({ type: 'delete', path: placed }, cred, at.guard, owner));
        at.committed(null, 0);
        return true;
      }
      case 'directory': {
        const placed = await mountOf('directory', record.inode.path);
        if (placed === null) return false;
        at.setPhase('publish');
        await at.settleBefore();
        reached();
        // A directory has no receipt, here as in a group.
        await backend(router.apply({ type: 'directory', path: placed, mode: record.inode.mode }, cred, at.guard, owner));
        at.committed(null, 0);
        return true;
      }
      case 'call': {
        const call = record.call;
        // A close is the binding's: of a mount's description, awaited here, its backend's close its answer;
        // of any other, the engine's (closeDescribed), in its transaction.
        if (call.call === 'close') {
          const { descriptions } = at;
          if (descriptions?.mounted(call.description) === undefined) return false;
          at.setPhase('publish');
          await at.settleBefore();
          reached();
          await backend(Promise.resolve(descriptions.close(call.description)));
          scope.forgetDescription(call.description);
          at.committed(null, 0);
          return true;
        }
        // A truncate through a description is that description's, never placed by its name: a mount's
        // file wherever its name leads now; any other is this filesystem's (EBADF for one not open).
        if (call.call === 'ftruncate' && call.description !== undefined) {
          const described = at.descriptions?.mounted(call.description);
          if (described === undefined) return false;
          at.setPhase('publish');
          await at.settleBefore();
          reached();
          await backend(Promise.resolve(described.truncate(call.size, at.guard)));
          at.committed(null, 0);
          return true;
        }
        if (call.call !== 'mkdir') at.routes.clear();
        // A copy with either name on a mount is the namespace's copy (by its
        // bytes across filesystems); both here, this filesystem's, by reference.
        if (call.call === 'copyFile') {
          await mountOf('file', call.path);
          await mountOf('file', call.from);
          // copyfile opens both names, each leaf link followed: a link here into a mount is the mount's file.
          const followed = async (named: string): Promise<string> => {
            const answer = scope.asWriter(() => router.resolveDirectory('/' + named, cred, scope.signal));
            return typeof answer === 'string' ? answer : await backend(answer);
          };
          const to = await followed(call.path);
          const from = await followed(call.from);
          if (router.placement(to) === null && router.placement(from) === null) return false;
          at.setPhase('publish');
          await at.settleBefore();
          reached();
          await backend(router.apply({ type: 'call', call: { call: 'copyFile', path: to, from } }, cred, at.guard, owner));
          at.committed(null, 0);
          return true;
        }
        const placed = await mountOf(
          call.call === 'mkdir' ? 'directory'
            : call.call === 'symlink' || call.call === 'ftruncate' || call.call === 'lchown' || call.call === 'lutimes' || call.call === 'open' ? 'file' : 'delete',
          call.path,
        );
        if (placed === null) return false;
        at.setPhase('publish');
        await at.settleBefore();
        reached();
        // Made under the umask the process made it with, as on this filesystem (W7Call umask).
        const as = withUmask(cred, 'umask' in call ? call.umask : undefined);
        if (call.call === 'open') {
          const { descriptions } = at;
          if (call.description !== undefined && descriptions === undefined) throw vfsError('ENOTSUP', call.path, 'no binding keeps open descriptions for this wave');
          // Its answer is the file's stat; with `description`, the binding keeps the file it found, and its descriptor is in the answer.
          const opened = await backend(router.open({ ...call, path: placed }, as, at.guard, owner));
          const handle = call.description === undefined || descriptions === undefined ? undefined
            : await backend(Promise.resolve(descriptions.describe(call.description, opened.file, opened.stat.ino, { read: call.read === true, write: true })));
          // The id is this mount's description's now: what the session kept of an earlier one under it is not adopted again.
          if (call.description !== undefined) scope.forgetDescription(call.description);
          at.committed({ path: call.path, ...opened.stat, ...(handle === undefined ? {} : { handle }) }, 0);
          return true;
        }
        await backend(router.apply({ type: 'call', call: { ...call, path: placed } }, as, at.guard, owner));
        at.committed(null, 0);
        return true;
      }
      case 'rename': {
        // Both names placed: on one filesystem, the rename is that one's;
        // between this filesystem and a mount (or two mounts), EXDEV, as
        // rename(2) across mounts is. A directory above a mount point is
        // EBUSY to move, as one is to remove.
        at.routes.clear();
        const from = await mountOf('delete', record.from);
        const to = await mountOf('file', record.to);
        if (from === null && to === null) return false;
        if (from === null || to === null || router.placement(from) !== router.placement(to)) {
          throw vfsError('EXDEV', record.from, `a rename to '${record.to}' crosses a mount`);
        }
        at.setPhase('publish');
        await at.settleBefore();
        reached();
        await backend(router.apply({ type: 'rename', from, to }, cred, at.guard, owner));
        at.committed(null, 0);
        return true;
      }
      case 'truncate':
      case 'setattr': {
        // A mode changes who may search a directory: later names resolve again.
        if (record.type === 'setattr') at.routes.clear();
        const placed = await mountOf('file', record.path);
        if (placed === null) return false;
        at.setPhase('publish');
        await at.settleBefore();
        reached();
        await backend(router.apply(record.type === 'truncate' ? { type: 'truncate', path: placed, size: record.size } : { type: 'setattr', path: placed, attrs: record.attrs }, cred, at.guard, owner));
        at.committed(null, 0);
        return true;
      }
      case 'file-begin': {
        // A write or append through a description is that description's (as landsHere decides it): a mount's file wherever its name leads now.
        const described = record.inode.description === undefined ? undefined : at.descriptions?.mounted(record.inode.description);
        if (record.inode.description !== undefined && described === undefined) return false;
        const placed = described !== undefined ? record.inode.path : await mountOf('file', record.inode.path);
        if (placed === null) return false;
        if (record.inode.kind === 'symlink') at.routes.clear();
        at.setPhase('validation');
        validateInodeShape(record.inode);
        // Refused before anything is touched: past what one whole-file call carries.
        if (record.inode.kind === 'symlink' && record.inode.size > ROUTED_LINK_TARGET_MAX) {
          throw vfsError('ENAMETOOLONG', record.inode.path, `a link's target is at most ${ROUTED_LINK_TARGET_MAX} bytes; this one is ${record.inode.size}`);
        }
        if (record.inode.kind !== 'symlink' && record.inode.size > ROUTED_FILE_MAX) {
          throw vfsError('ENOTSUP', record.inode.path, `a wave writes a file to a mount in one call, up to ${ROUTED_FILE_MAX} bytes; this one is ${record.inode.size}`);
        }
        // Admitted with its whole size reserved: its chunks draw on that, never
        // on the shared credit, so three waves each holding part of a file
        // cannot all wait for more before their file-ends.
        const lease = await at.reserve(record.inode.size);
        at.file = {
          named: record.inode.path, placed, link: record.inode.kind === 'symlink',
          mode: record.inode.mode, size: record.inode.size, held: [], index: at.index,
          credit: { left: record.inode.size, lease },
          ...(record.inode.call === undefined ? {} : { call: record.inode.call }),
          ...(record.inode.offset === undefined ? {} : { offset: record.inode.offset }),
          ...(record.inode.umask === undefined ? {} : { umask: record.inode.umask }),
          ...(described === undefined ? {} : { described }),
        };
        return true;
      }
      case 'file-chunk': {
        // The decoder yields a file's chunks in order, each its size, after
        // its file-begin and before its file-end (decodeWriteBatchStream).
        const file = at.file;
        if (file === null) return false;
        // Held under the wave's credit until the file's call.
        file.held.push({ data: record.data, release: () => record.retention.release() });
        return true;
      }
      case 'file-end': {
        const file = at.file;
        if (file === null) return false;
        at.setPhase('publish');
        try {
          await at.settleBefore();
          reached();
          const bytes = concatBytes(file.held.map((chunk) => chunk.data));
          const node = file.described;
          if (node !== undefined) {
            await backend(Promise.resolve(file.call === 'append' ? node.append(bytes, at.guard) : node.write(file.offset ?? 0, bytes, at.guard)));
            at.committed(receiptOf(file.named, await backend(Promise.resolve(node.stat(at.guard)))), bytes.byteLength);
            return true;
          }
          const stat = await backend(router.apply(file.call !== undefined
            ? { type: 'data-call', call: file.call, path: file.placed, mode: file.mode, bytes, ...(file.offset === undefined ? {} : { offset: file.offset }) }
            : file.link
            ? { type: 'symlink', path: file.placed, target: nameDec.decode(bytes), slot: `${at.waveId}-${file.index}` }
            : { type: 'file', path: file.placed, mode: file.mode, bytes }, withUmask(cred, file.umask), at.guard, owner));
          at.committed(stat === null ? null : { path: file.named, ...stat }, bytes.byteLength);
        } finally {
          at.file = null;
          for (const chunk of file.held) chunk.release();
          file.credit.lease?.release();
        }
        return true;
      }
      default:
        return false;
    }
  }
}
