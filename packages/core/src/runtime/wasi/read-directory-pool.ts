/** Guest-side bookkeeping for real, single-use directory descriptions. It owns no filesystem authority. */
import { DIRECTORY_BATCH_LIMIT, DIRECTORY_END_WAIT_MS, DIRECTORY_PREFETCH_LIMIT } from '../../constants.js';
import type { ProcessFsClient } from '../../_shared/process-fs-client.js';
import type { RuntimeFileHandle, RuntimeFsPath, VfsAcquireResult } from '../os-contracts.js';
import type { ReadDirectoryBatchRequest, ReadDirectoryBatchResult, ReadDirectoryDescription } from '../read-directory-batch.js';
import type { ResidentBarrier, ResidentBarrierOptions, ResidentEntry } from './resident-filesystem.js';
import { notAfter, sameEpochs, type FeedPosition } from '../feed-position.js';
import {
  arrayCopy, arrayJoin, Error, mathMin, objectAssign, objectHasOwn, ownField, ownValue, PromiseConstructor, promiseRace, promiseResolve, promiseThen, SafeList,
  SafeMap, SafeSet, setList, stringSplit,
} from '../../_shared/primordials.js';

export interface DirectoryPoolStore {
  ready(): boolean;
  cursor(): FeedPosition | null;
  barrier(options?: ResidentBarrierOptions): Promise<ResidentBarrier>;
  entry(key: string): ResidentEntry | null | undefined;
}
interface Options {
  readonly call: (request: ReadDirectoryBatchRequest) => Promise<ReadDirectoryBatchResult>;
  readonly store: DirectoryPoolStore;
  readonly client: ProcessFsClient;
  /** Publish the caller's pending writes before recording the original lease ask. */
  readonly before: () => Promise<void>;
  /** How long dispose waits for the channel's last exchange (DIRECTORY_END_WAIT_MS). */
  readonly endWaitMs?: number;
}
export interface ReadDirectoryPool {
  open(path: RuntimeFsPath, key: string, prefetch: () => Promise<readonly RuntimeFsPath[]>): Promise<RuntimeFileHandle | null>;
  owns(id: number): boolean;
  closed(id: number): boolean;
  local(id: number): { key: string; entry: ResidentEntry } | null;
  /** `wait`: a close that may wait for the session retires what is queued when the queue is full; one that cannot queues it. */
  close(id: number, wait?: boolean): void | Promise<void>;
  /** Only call where a real supervisor/store I/O reply arrived; timers never establish trust. */
  io(): void;
  /**
   * The store may be behind (the process's own change, input): nothing is
   * claimed until a batch's answer is admitted, and then each prediction only
   * if the store still shows the directory it opened. None is retired for it.
   */
  invalidate(): void;
  /** A park timed out: late, not-yet-delivered descriptions are abandoned, never installed into the guest fd table. */
  cancelPending(): void;
  /**
   * The run ended: every description the pool accounts for is retired. A
   * shell's commands share its pid, and so its descriptor scope: a run
   * cannot leave them to the scope's release.
   */
  dispose(): Promise<void>;
}

function failure(code: string, message: string): Error { return objectAssign(new Error(`${code}: ${message}`), { code }); }

/** Whether the store's entry shows the directory as the authority's access check saw it when it opened it. */
function asOpened(entry: ReadDirectoryDescription, current: ResidentEntry): boolean {
  const seen = entry.opened;
  return seen !== null && current.mode === seen.mode && current.uid === seen.uid && current.gid === seen.gid && current.ctime === seen.ctime;
}

/** A candidate's key as the batch reports it (no leading or trailing `/`), for one already prefetched; a descriptor-relative one never matches. */
function keyOfPath(path: RuntimeFsPath): string {
  const named = typeof path === 'string' ? path : objectHasOwn(path, 'root') ? `${(path as { readonly root: string }).root}/${path.path}` : '';
  const segments = stringSplit(named, '/');
  const kept = new SafeList<string>();
  for (let i = 0; i < segments.length; i++) if (segments[i] !== '' && segments[i] !== '.') kept[kept.length] = segments[i];
  return arrayJoin(kept, '/');
}

export function readDirectoryPool(options: Options): ReadDirectoryPool {
  const { call, store, client, before } = options;
  const waitMs = ownValue(options, 'endWaitMs');
  const endWaitMs = waitMs === undefined ? DIRECTORY_END_WAIT_MS : waitMs;
  const channel = crypto.randomUUID();
  let sequence = 0, generation = 0, cancelled = 0;
  /** The lease's owner, and the store's incarnation it was applied at (sameEpochs). */
  let owner: string | null = null, incarnation: FeedPosition | null = null;
  let trustedAtIo = false, ended = false, uncertain = 0, reserved = 0;
  /** The session refused the channel itself (its scope's channel budget, or the channel's own window): the batch is not used again. */
  let unavailable = false;
  let tail = promiseResolve();
  const unused = new SafeMap<string, ReadDirectoryDescription>();
  const owned = new SafeMap<number, ReadDirectoryDescription>();
  const retiring = new SafeSet<number>();
  const claiming = new SafeSet<number>();
  const serial = <T>(body: () => Promise<T>): Promise<T> => {
    const result = promiseThen(tail, body);
    tail = promiseThen(result, () => {}, () => {});
    return result;
  };
  const outstanding = (): number => unused.size + owned.size + retiring.size + uncertain + reserved;
  const discardUnused = (): void => {
    unused.forEach((entry) => { claiming.delete(entry.handle.id); retiring.add(entry.handle.id); });
    unused.clear();
  };
  /**
   * The store may be behind (a change of the process's own, input, a
   * recall): nothing is claimed until a batch's answer is admitted, and then
   * each prediction only if the store still shows the directory it opened.
   */
  const distrust = (): void => { generation++; trustedAtIo = false; };
  /** What the pool knows may be wrong (a failed or foreign answer, the end): every prediction is retired. */
  const invalidate = (): void => { distrust(); discardUnused(); };
  const sameIncarnation = (): boolean => {
    const now = store.cursor();
    return now !== null && incarnation !== null && sameEpochs(now, incarnation);
  };
  const valid = (): boolean => {
    const yes = trustedAtIo && owner !== null && client.readUnchanged(owner)
      && store.ready() && sameIncarnation();
    if (!yes) {
      trustedAtIo = false;
      // Another incarnation's store: no description of the old one is worth
      // keeping. (Before a lease was applied there is no incarnation to compare.)
      if (incarnation !== null && !sameIncarnation()) discardUnused();
    }
    return yes;
  };
  const local = (entry: ReadDirectoryDescription): { key: string; entry: ResidentEntry } | null => {
    if (!valid() || entry.key === null) return null;
    const current = store.entry(entry.key);
    return current?.type === 'directory' && current.dev === entry.dev && current.ino === entry.ino
      ? { key: entry.key, entry: current } : null;
  };
  const claim = (entry: ReadDirectoryDescription): RuntimeFileHandle => {
    if (entry.key !== null && unused.get(entry.key)?.handle.id === entry.handle.id) unused.delete(entry.key);
    retiring.delete(entry.handle.id);
    owned.set(entry.handle.id, entry);
    claiming.add(entry.handle.id);
    return entry.handle;
  };
  const exchange = async (open: readonly RuntimeFsPath[], wantLease: boolean, end = false): Promise<readonly ReadDirectoryDescription[]> => {
    await before();
    const cursor = store.cursor();
    // Captured ONCE outside the retried RPC. A cached once-delivery answer
    // can never obtain a new deadline from the retry's later arrival.
    const ask = wantLease && cursor !== null ? client.readLeaseAsk() : null;
    const stamp = generation;
    const cancelAt = cancelled;
    const sentRetire = arrayCopy(setList(retiring));
    const sentClaim = arrayCopy(setList(claiming));
    const sentSequence = ++sequence;
    reserved += open.length;
    let result: ReadDirectoryBatchResult;
    try {
      result = await call({ channel, sequence: sentSequence, position: cursor,
        open: arrayCopy(open), retire: sentRetire, claim: sentClaim, lease: ask !== null, ...(end ? { end } : {}) });
    } catch (error) {
      uncertain += open.length;
      invalidate();
      throw error;
    } finally { reserved -= open.length; }
    if (result.channel !== channel || result.sequence !== sentSequence) {
      uncertain += open.length;
      invalidate();
      throw failure('ESTALE', 'directory batch reply belongs to another request');
    }
    for (let i = 0; i < result.retired.length; i++) { const id = result.retired[i]; retiring.delete(id); }
    for (let i = 0; i < result.claimed.length; i++) { const id = result.claimed[i]; claiming.delete(id); }
    uncertain = 0; // advancing the channel retires an abandoned earlier answer
    // Account for every received ID before admission can yield or fail.
    // Successful adoption transfers it from this retirement set to unused/owned.
    for (let i = 0; i < result.opened.length; i++) { const entry = result.opened[i]; retiring.add(entry.handle.id); }
    const lease = result.acquire.readLease;
    if (lease) client.readLeaseAnswered(lease); // ownership precedes any admission/yield
    const current = store.cursor();
    const applies = current !== null && (sameEpochs(current, result.acquire.position)
      ? notAfter(current, result.acquire.position)
      : cursor !== null && sameEpochs(current, cursor) && generation === stamp);
    let admitted: boolean;
    try { admitted = applies && ownValue(await store.barrier({ answer: result.acquire }), 'applied') === true; }
    catch (error) { invalidate(); throw error; }
    trustedAtIo = false;
    if (lease && ask && admitted && !result.acquire.poison && generation === stamp && cancelled === cancelAt) {
      client.readLeased(lease, ask);
      owner = lease.owner;
      incarnation = result.acquire.position;
      trustedAtIo = client.readTrusted(); // a real batch reply, never a timer
    }
    if (open.length > 0 && (cancelled !== cancelAt || ended)) {
      for (let i = 0; i < result.opened.length; i++) { const entry = result.opened[i]; retiring.add(entry.handle.id); }
      throw failure('EAGAIN', 'directory batch completed after its park ended');
    }
    return result.opened;
  };
  const drain = async (): Promise<void> => {
    invalidate();
    if (retiring.size || claiming.size || uncertain) await exchange([], false);
  };

  return {
    open(path, key, prefetch) {
      const began = cancelled;
      return promiseThen(serial(async () => {
        if (ended) throw failure('ESTALE', 'directory pool ended');
        if (unavailable) return null;
        if (began !== cancelled) throw failure('EAGAIN', 'directory open was cancelled while queued');
        if (!store.ready() || !store.cursor()) { await drain(); return null; }
        const hit = unused.get(key);
        const current = hit ? local(hit) : null;
        if (hit && current && asOpened(hit, current.entry)) return claim(hit);
        // Only a hit that no longer holds is retired; the rest of what the
        // walk was guessed to open stays, validated when it is claimed. The
        // session closes what an advance of the channel leaves unclaimed, so
        // the next exchange claims it there (still unused here, and retired
        // at the run's end or when the store moves, as any).
        if (hit) { unused.delete(key); claiming.delete(hit.handle.id); retiring.add(hit.handle.id); }
        unused.forEach((entry) => { claiming.add(entry.handle.id); });
        const guessed = await prefetch();
        const candidates = new SafeList<RuntimeFsPath>();
        for (let i = 0; i < guessed.length; i++) if (!unused.has(keyOfPath(guessed[i]))) candidates[candidates.length] = guessed[i];
        if (began !== cancelled) throw failure('EAGAIN', 'directory open was cancelled while preparing');
        // At capacity, ACK retirement first. Do not spend credits merely
        // because a close was sent or a previous answer never arrived.
        if (uncertain || outstanding() >= DIRECTORY_PREFETCH_LIMIT) await drain();
        const credit = mathMin(DIRECTORY_BATCH_LIMIT, DIRECTORY_PREFETCH_LIMIT - outstanding());
        if (credit <= 0) return null;
        const open = new SafeList<RuntimeFsPath>();
        for (let i = -1; i < candidates.length && open.length < credit; i++) open[open.length] = i < 0 ? path : candidates[i];
        const opened = await exchange(open, true);
        const required = opened[0];
        if (!required) return null;
        for (let i = 1; i < opened.length; i++) {
          const entry = opened[i];
          const current = local(entry);
          if (entry.key !== null && entry.key !== required.key && current && asOpened(entry, current.entry) && !unused.has(entry.key)) {
            retiring.delete(entry.handle.id);
            unused.set(entry.key, entry);
          }
        }
        // Even if the lease was recalled before admission, the required
        // real descriptor is the completed open; never reopen it by name.
        return claim(required);
      }), undefined, (error) => {
        invalidate();
        // An optimization the session cannot account for: the directory is
        // opened as any is (null), now and from now on. The open's own
        // refusal (ENOENT, EACCES) and a park given up on stay the caller's.
        const code = typeof error === 'object' && error !== null ? ownField(error, 'code') : undefined;
        if (!ended && (code === 'ENOSPC' || code === 'ESTALE')) { unavailable = true; return null; }
        throw error;
      });
    },
    owns: (id) => owned.has(id),
    closed: (id) => retiring.has(id),
    local: (id) => { const entry = owned.get(id); return entry ? local(entry) : null; },
    close(id, wait = true) {
      if (!owned.delete(id)) throw failure('EBADF', 'directory description is not open');
      claiming.delete(id);
      retiring.add(id);
      if (wait && retiring.size >= DIRECTORY_PREFETCH_LIMIT) return serial(drain);
    },
    io() {
      trustedAtIo = owner !== null && client.readUnchanged(owner) && client.readTrusted();
    },
    invalidate: distrust,
    cancelPending() { cancelled++; distrust(); },
    async dispose() {
      ended = true;
      cancelled++;
      owned.forEach((_entry, id) => { retiring.add(id); });
      owned.clear(); claiming.clear();
      invalidate();
      if (sequence === 0) return;
      // The channel's last exchange retires the rest and ends the channel. It
      // is sent now, not behind an exchange the session may never answer (a
      // park the watchdog gave up on): its later sequence supersedes that
      // one. The run waits for it at most endWaitMs.
      let timer: ReturnType<typeof setTimeout> | null = null;
      const ends = new SafeList<Promise<void>>();
      ends[0] = promiseThen(exchange([], false, true), () => {}, () => {});
      ends[1] = new PromiseConstructor<void>((resolve) => { timer = setTimeout(resolve, endWaitMs); });
      await promiseRace(ends);
      clearTimeout(timer);
    },
  };
}
