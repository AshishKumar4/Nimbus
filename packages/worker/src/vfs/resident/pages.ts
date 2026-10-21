/**
 * Pages of a file too big to hold whole, each held at the revision it was
 * read at, so a rewritten file's pages are never another revision's. Bound
 * by RESIDENT_PAGE_CACHE_BYTES, and by half a one-shot heap's budget or a
 * share of the session's free storage (RESIDENT_PAGE_CACHE_FREE_SHARE),
 * least recently used out first; what does not fit is read through the
 * session (core runtime/wasi/resident-filesystem.ts reads a large file's
 * positional reads from here).
 */

import { FS_READ_BATCH_PATH_LIMIT, FS_READ_BATCH_REQUEST_BYTES } from '@nimbus-sh/core/constants.js';
import { RESIDENT_PAGE_BYTES, RESIDENT_PAGE_CACHE_BYTES, RESIDENT_PAGE_CACHE_FREE_SHARE } from '@nimbus-sh/platform/limits.js';
import type { Admission } from './admission.js';
import { RESIDENT_ROW_BYTES, residentBytes } from './cell-cost.js';
import type { Coherence } from './coherence.js';
import type { Learning, Namespace } from './namespace.js';
import type { ResidentSupervisor } from './supervisor.js';
import { rootOf } from '@nimbus-sh/core/runtime/feed-position.js';

export interface Pages {
  /**
   * Pages `first`..`last` of the file at `k` as of revision `rev` (`size`
   * bytes): those held, and the rest read in batches pinned to that revision
   * and held for the next reader; with how many were read. Null when the
   * session's file is no longer at `rev`, or a read fails: the caller reads
   * through its descriptor. A read is a learning (namespace.learning): pages
   * asked before the store started again are not held.
   */
  read(supervisor: ResidentSupervisor, k: string, rev: number, size: number, first: number, last: number): Promise<{ pages: Uint8Array[]; fetched: number } | null>;
  /** Forget what the counters knew: the tables were cleared or rebound. */
  reset(): void;
}

export function createPages(coherence: Coherence, admission: Admission, namespace: Namespace): Pages {
  let clock: number | null = null;
  let total: number | null = null;

  /** The bytes of the pages held, summed once per binding. */
  const held = (): number => (total ??= coherence.require().pageBytes());
  const tick = (): number => {
    clock ??= coherence.require().pageMaxUsed();
    return ++clock;
  };

  const bound = (): number => {
    // A one-shot's heap has a fixed budget, which the pages may have half of.
    // A facet's storage grows by grants as it needs, and its pages are held to
    // a share of what the ledger has left instead.
    const half = admission.inHeap && admission.cap !== null ? Math.floor(admission.cap / 2) : Infinity;
    const share = admission.available === null ? Infinity : Math.floor(RESIDENT_PAGE_CACHE_FREE_SHARE * (held() + admission.available));
    return Math.min(RESIDENT_PAGE_CACHE_BYTES, half, share);
  };

  const get = (path: string, rev: number, part: number): Uint8Array | undefined => {
    const t = coherence.require();
    const bin = t.pageGet(path, rev, part);
    if (bin === undefined) return undefined;
    t.pageUse(path, rev, part, tick());
    return residentBytes(bin);
  };

  /** Hold a page, the least recently used out first to stay in bounds. False when it cannot be held. */
  const put = (path: string, rev: number, part: number, bytes: Uint8Array): boolean => {
    const t = coherence.require();
    const size = bytes.byteLength;
    const limit = bound();
    if (size > limit) return false;
    while (held() + size > limit) {
      const oldest = t.pageOldest(16);
      if (oldest.length === 0) break;
      for (const row of oldest) {
        t.pageDelete(row.path, row.rev, row.part);
        total = held() - row.size;
        if (total + size <= limit) break;
      }
    }
    if (!admission.fits(size + RESIDENT_ROW_BYTES, false)) return false;
    const replaced = t.pagePut(path, rev, part, bytes, tick());
    total = held() + size - replaced;
    return true;
  };

  const readWith = async (
    learning: Learning, supervisor: ResidentSupervisor, k: string, rev: number, size: number, first: number, last: number,
  ): Promise<{ pages: Uint8Array[]; fetched: number } | null> => {
    const cursor = coherence.cursor();
    if (cursor === null || typeof supervisor.fsReadBatch !== 'function') return null;
    // A page is its epoch's. One database's revisions never go back, so no
    // epoch the platform produces names a revision of another's with other
    // bytes; a store that outlived its database would meet one, and keying by
    // epoch costs nothing.
    const epoch = rootOf(cursor).epoch;
    const keyed = epoch + '\u0000' + k;
    const out: Uint8Array[] = new Array(last - first + 1);
    const missing: number[] = [];
    for (let part = first; part <= last; part++) {
      const page = get(keyed, rev, part);
      if (page !== undefined) out[part - first] = page;
      else missing.push(part);
    }
    const perBatch = Math.max(1, Math.min(FS_READ_BATCH_PATH_LIMIT, Math.floor(FS_READ_BATCH_REQUEST_BYTES / RESIDENT_PAGE_BYTES)));
    for (let at = 0; at < missing.length; at += perBatch) {
      const batch = missing.slice(at, at + perBatch);
      const ranges = batch.map((part) => {
        const offset = part * RESIDENT_PAGE_BYTES;
        return { path: '/' + k, offset, length: Math.min(RESIDENT_PAGE_BYTES, Math.max(0, size - offset)), expectedEpoch: epoch, expectedRevision: rev };
      });
      // N18: room asked for first; a page the ledger will not admit is still read, only not held.
      await admission.ensureRoom(ranges.reduce((n, r) => n + r.length + RESIDENT_ROW_BYTES, 0));
      let results;
      try { results = await supervisor.fsReadBatch(ranges); }
      catch { return null; }
      if (!Array.isArray(results) || results.length !== ranges.length) return null;
      for (let i = 0; i < batch.length; i++) {
        const entry = results[i];
        if (!entry || entry.error || entry.bytes == null) return null;
        const bytes = residentBytes(entry.bytes);
        if (bytes.byteLength !== ranges[i]!.length) return null;
        out[batch[i]! - first] = bytes;
        if (learning.installs(k)) put(keyed, rev, batch[i]!, bytes);
      }
    }
    return { pages: out, fetched: missing.length };
  };

  return {
    async read(supervisor, k, rev, size, first, last) {
      const learning = namespace.learning();
      try {
        return await readWith(learning, supervisor, k, rev, size, first, last);
      } finally {
        learning.end();
      }
    },
    reset() {
      clock = null;
      total = null;
    },
  };
}
