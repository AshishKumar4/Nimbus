/**
 * N18: the session's storage ledger admits a process store's growth before
 * it happens. The supervisor grants an allowance (the ledger records it under
 * the facet's name); the store never grows its database past the cap, and
 * asks for more, asynchronously, when it would. What does not fit is not
 * held: a fill degrades to reads through the session, and an own write goes
 * to the session only. A null cap: no ledger (no cap).
 *
 * A one-shot's heap (store.bindInMemory) is one fixed budget: its tables, the
 * own writes held beside them, the namespace's overlay and reserve, and what
 * a WASI process pins, all count against the same cap, and there is no one
 * to ask for more.
 */

import { residentBytes, residentCellCost } from './cell-cost.js';
import type { Coherence } from './coherence.js';
import type { ResidentSupervisor } from './supervisor.js';
import {
  arrayIsArray, arrayPush, arrayShift, mathMax, NumberOf, ownField, PromiseConstructor, promiseFinally, promiseResolve, promiseThen, SafeList, SafeMap,
} from '@nimbus-sh/core/_shared/primordials.js';
import { FACET_OWN_WRITE_MEMORY_BYTES } from '@nimbus-sh/platform/limits.js';

export interface Admission {
  /** Whether the store is a one-shot's heap rather than a facet's storage. */
  readonly inHeap: boolean;
  readonly cap: number | null;
  /** Everything the cap counts. */
  dbBytes(): number;
  /** Bound to a one-shot's heap, capped at `budget` and never growing past it. */
  bindHeap(budget: number): void;
  /** What the own writes held in memory take (cells' held cells): counted here, against the one budget. */
  readonly heldBytes: number;
  addHeld(bytes: number): void;
  /**
   * What gives held cells up, least recently read first, until `bytes` of
   * them are gone or none is left (cells): the session holds what they hold,
   * so they make room for bytes the process has yet to send (pin).
   */
  setHeldShedder(shed: (bytes: number) => void): void;
  /** The allowance this launch was admitted for (the fabric's startArgs.storage). */
  setStorage(storage: unknown, supervisor: ResidentSupervisor | null | undefined): void;
  /** The cap this store enforces, for startProcess to report. */
  storageCap(): number | null;
  /** What the session's ledger said a user may still write, at its last answer; null before one. */
  readonly available: number | null;
  /**
   * `bytes` held in the isolate's heap beside the store, whatever backs its
   * tables (a process's decided bytes, a descriptor's pinned content): a
   * one-shot's share the store's one budget; a facet's have their own bound
   * (FACET_OWN_WRITE_MEMORY_BYTES), with the own bytes the cells hold. False
   * where they do not fit.
   */
  pin(bytes: number): boolean;
  unpin(bytes: number): void;
  /** Room a one-shot's held own writes may take beside everything else. */
  heldLimit(maxBytes: number): number;
  /**
   * Why a one-shot's namespace may not grow by `bytes`, or null: the cap is
   * one budget, and a namespace that does not fit cannot be described. Only a
   * one-shot's heap is judged here; a facet's storage is admitted as it grows.
   */
  namespaceRefusal(bytes: number): string | null;
  /** namespaceRefusal of a row put into the heap tables, growing them by `growth` (the overlay and reserve beside them, not pins). */
  rowRefusal(growth: number): string | null;
  /** The namespace overlay's bytes (node-shims' own structural effects), charged to a one-shot's budget. */
  addOverlay(bytes: number): void;
  /** Hold `bytes` of namespace room while a reconcile fetches; give it back with the returned function. */
  reserveNamespace(bytes: number): () => void;
  reserve(path: string, bytes: number): Promise<boolean>;
  release(path: string): void;
  fits(bytes: number, ask?: boolean): boolean;
  ensureRoom(bytes: number): Promise<boolean>;
  roomForPushed(result: unknown): Promise<void>;
  reportSize(): Promise<void>;
}

export function createAdmission(coherence: Coherence): Admission {
  let cap: number | null = null;
  let facet: string | null = null;
  let supervisor: ResidentSupervisor | null = null;
  let grantAsk: Promise<void> | null = null;
  let inHeap = false;
  let heldBytes = 0;
  let namespaceOverlayBytes = 0;
  let namespaceReserveBytes = 0;
  /**
   * Heap a WASI process holds outside the tables, charged to the same budget:
   * file bytes a descriptor keeps for its lifetime, and writes held for the
   * session (core runtime/wasi/resident-filesystem.ts). pin refuses what does
   * not fit, and the caller then reads through the session instead.
   */
  let pinnedBytes = 0;
  let shedHeld: ((bytes: number) => void) | null = null;
  let available: number | null = null;

  /**
   * Room promised to fills in flight. A fault-in asks for its file's room
   * before the bytes arrive (reserve), and the room is its own until the put
   * that lands them spends it (store.put) or the fill gives it up (release).
   * Every other fit counts it as taken: a grant measured against the database
   * alone went to whichever of a batch of fills landed first, and the rest
   * were refused.
   */
  // A SafeMap: a fill's settle releases its reservation, after the program may have replaced Map's methods.
  const reservations = new SafeMap<string, number>();
  let reservedBytes = 0;

  /**
   * Reservations waiting for room, in the order they were asked for. Room that
   * comes is held for them in that order as it comes, and one ask covers what
   * they all still need: when each ask was for its asker's own room, and a
   * waiter that saw room free took it without holding it, a grant served one
   * fill of a batch, and the batch's tail gave up with the ledger granting
   * every byte asked (astro dev: a hundred of zod's locales at once).
   */
  // A SafeList: a fill's reservation reaches it after the program may have replaced Array.prototype's methods.
  const reserveQueue = new SafeList<{ path: string; bytes: number; resolve: (held: boolean) => void }>();
  let reserveServing = false;

  const tablesBytes = (): number => coherence.tables('a storage measure').bytes();
  const dbBytes = (): number => tablesBytes()
    + (inHeap ? heldBytes + namespaceOverlayBytes + namespaceReserveBytes + pinnedBytes : 0);
  const refusal = (total: number): string | null => (inHeap && cap !== null && total > cap
    ? 'namespace storage budget exceeded (' + cap + ' bytes)' : null);

  /** Hold room for `path` if `bytes` fit now: true once it is held. */
  const holdRoom = (path: string, bytes: number): boolean => {
    if (dbBytes() + reservedBytes + bytes > cap!) return false;
    // A second fill of the path in line holds the room the first held, not twice it.
    release(path);
    reservations.set(path, bytes);
    reservedBytes += bytes;
    return true;
  };

  /**
   * The waiting reservations' one asker. It holds room for those that fit, in
   * order, then asks the ledger for what the rest need, until none waits. An
   * ask that raises the cap not at all is the ledger's refusal (it admits a
   * fill whole or not at all): the reservations still waiting are refused, and
   * their fills are not fetched. Rounds whose room others took are bounded.
   */
  const serveReserves = async (): Promise<void> => {
    if (reserveServing) return;
    reserveServing = true;
    try {
      for (let idle = 0; ; ) {
        const waiting = reserveQueue.length;
        while (reserveQueue.length > 0 && holdRoom(reserveQueue[0].path, reserveQueue[0].bytes)) {
          arrayShift(reserveQueue)?.resolve(true);
        }
        if (reserveQueue.length === 0) return;
        idle = reserveQueue.length < waiting ? 0 : idle + 1;
        const before = cap;
        if (idle <= 8) {
          let need = 0;
          for (let i = 0; i < reserveQueue.length; i++) need += reserveQueue[i].bytes;
          await askGrant(need);
        }
        if (cap === before) {
          const refused = new SafeList<{ path: string; bytes: number; resolve: (held: boolean) => void }>();
          for (let i = 0; i < reserveQueue.length; i++) refused[i] = reserveQueue[i];
          reserveQueue.length = 0;
          for (let i = 0; i < refused.length; i++) refused[i].resolve(false);
          return;
        }
      }
    } finally {
      reserveServing = false;
    }
  };

  /** Give up the room reserved for `path`, if any. */
  const release = (path: string): void => {
    const bytes = reservations.get(path);
    if (bytes === undefined) return;
    reservations.delete(path);
    reservedBytes -= bytes;
  };

  /**
   * Ask the ledger for `bytes` more, reporting what the database measures.
   * Exactly what is needed: room granted and unused is room the session's own
   * writes cannot have. Resolves to whether `bytes` now fit.
   */
  const askGrant = (bytes: number): Promise<boolean> => {
    const asked = supervisor;
    if (cap === null) return promiseResolve(true);
    // A store with no ledger row (a one-shot's heap) has a fixed budget: no one to ask.
    if (facet === null || !asked || typeof asked.fsStorageGrant !== 'function') return promiseResolve(false);
    // Another ask is out: wait for it, and ask for this one's room after it if
    // that grant did not cover it too. Giving up there left all but the first
    // of a batch of fills at the cap refused.
    if (grantAsk) {
      return promiseThen(grantAsk, () => dbBytes() + reservedBytes + bytes <= cap! || askGrant(bytes));
    }
    const want = mathMax(0, dbBytes() + reservedBytes + bytes - cap);
    const named = facet;
    grantAsk = promiseFinally((async () => {
      try {
        const answer = await asked.fsStorageGrant!(named, want, dbBytes());
        cap! += NumberOf(answer && answer.granted) || 0;
        if (answer && typeof answer.available === 'number') available = answer.available;
      } catch {}
    })(), () => { grantAsk = null; });
    return promiseThen(grantAsk, () => dbBytes() + reservedBytes + bytes <= cap!);
  };

  /**
   * Whether the store may grow by `bytes` now; when not, and `ask`, more room
   * is asked for. A copy of an own write never asks: the session's copy is the
   * one that must have the room, and the cache must not take it first.
   */
  const fits = (bytes: number, ask = true): boolean => {
    if (cap === null) return true;
    if (dbBytes() + reservedBytes + bytes <= cap) return true;
    if (ask) void askGrant(bytes);
    return false;
  };

  /** Room for `bytes` before an asynchronous fill writes them: true when they fit. */
  const ensureRoom = async (bytes: number): Promise<boolean> => {
    if (cap === null || dbBytes() + reservedBytes + bytes <= cap) return true;
    return askGrant(bytes);
  };

  return {
    get inHeap() { return inHeap; },
    get cap() { return cap; },
    dbBytes,
    bindHeap(budget) {
      inHeap = true;
      facet = null;
      cap = NumberOf(budget);
      namespaceOverlayBytes = 0;
      namespaceReserveBytes = 0;
      pinnedBytes = 0;
    },
    setStorage(storage, given) {
      supervisor = given || null;
      const allowance = typeof storage === 'object' && storage !== null ? storage : null;
      const room = allowance === null ? undefined : ownField(allowance, 'available');
      available = typeof room === 'number' ? room : null;
      const named = allowance === null ? undefined : ownField(allowance, 'facet');
      const grant = allowance === null ? undefined : ownField(allowance, 'grant');
      if (typeof named !== 'string' || typeof grant !== 'number') return;
      facet = named;
      cap = dbBytes() + grant;
    },
    storageCap() { return cap; },
    get available() { return available; },
    pin(bytes) {
      if (!inHeap && pinnedBytes + heldBytes + bytes > FACET_OWN_WRITE_MEMORY_BYTES) shedHeld?.(pinnedBytes + heldBytes + bytes - FACET_OWN_WRITE_MEMORY_BYTES);
      if (inHeap ? !fits(bytes, false) : pinnedBytes + heldBytes + bytes > FACET_OWN_WRITE_MEMORY_BYTES) return false;
      pinnedBytes += bytes;
      return true;
    },
    setHeldShedder(shed) { shedHeld = shed; },
    unpin(bytes) {
      pinnedBytes = mathMax(0, pinnedBytes - bytes);
    },
    get heldBytes() { return heldBytes; },
    addHeld(bytes) { heldBytes += bytes; },
    heldLimit(maxBytes) {
      // In a facet the held cells share the process's own-write bound with what it pins. In a
      // one-shot's heap they share the store's: what the cap leaves beside the tables.
      return inHeap ? mathMax(0, NumberOf(cap) - tablesBytes() - namespaceOverlayBytes - namespaceReserveBytes) : mathMax(0, maxBytes - pinnedBytes);
    },
    namespaceRefusal(bytes) { return refusal(dbBytes() + bytes); },
    rowRefusal(growth) { return refusal(tablesBytes() + heldBytes + namespaceOverlayBytes + namespaceReserveBytes + growth); },
    addOverlay(bytes) { namespaceOverlayBytes += bytes; },
    reserveNamespace(bytes) {
      namespaceReserveBytes += bytes;
      return () => { namespaceReserveBytes -= bytes; };
    },
    /** Reserve room for a fill of `path` before its bytes arrive: true once it is held for it. */
    reserve(path, bytes) {
      release(path);
      if (cap === null) return promiseResolve(true);
      if (reserveQueue.length === 0 && holdRoom(path, bytes)) return promiseResolve(true);
      return new PromiseConstructor((resolve) => {
        arrayPush(reserveQueue, { path, bytes, resolve });
        void serveReserves();
      });
    },
    release,
    fits,
    ensureRoom,
    /** Room for what an ACQUIRE answer pushes, asked for before it is applied. */
    async roomForPushed(result) {
      const listed = cap === null || typeof result !== 'object' || result === null ? undefined : ownField(result, 'paths');
      if (cap === null || !arrayIsArray(listed)) return;
      const paths = listed as unknown[];
      let bytes = 0;
      for (let i = 0; i < paths.length; i++) {
        const entry = paths[i];
        const held = typeof entry === 'object' && entry !== null ? ownField(entry, 'bytes') : undefined;
        if (held != null) bytes += residentCellCost(residentBytes(held));
      }
      if (bytes > 0) await ensureRoom(bytes);
    },
    /** What the database measures, after a fill batch: the ledger settles to it, or records overshoot. */
    async reportSize() {
      const asked = supervisor;
      if (cap === null || facet === null || !asked || typeof asked.fsStorageGrant !== 'function') return;
      try {
        const answer = await asked.fsStorageGrant(facet, 0, dbBytes());
        if (answer && typeof answer.available === 'number') available = answer.available;
      } catch {}
    },
  };
}
