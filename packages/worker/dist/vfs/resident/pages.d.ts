/**
 * Pages of a file too big to hold whole, each held at the revision it was
 * read at, so a rewritten file's pages are never another revision's. Bound
 * by RESIDENT_PAGE_CACHE_BYTES, and by half a one-shot heap's budget or a
 * share of the session's free storage (RESIDENT_PAGE_CACHE_FREE_SHARE),
 * least recently used out first; what does not fit is read through the
 * session (core runtime/wasi/resident-filesystem.ts reads a large file's
 * positional reads from here).
 */
import type { Admission } from './admission.js';
import type { Coherence } from './coherence.js';
import type { Namespace } from './namespace.js';
import type { ResidentSupervisor } from './supervisor.js';
export interface Pages {
    /**
     * Pages `first`..`last` of the file at `k` as of revision `rev` (`size`
     * bytes): those held, and the rest read in batches pinned to that revision
     * and held for the next reader; with how many were read. Null when the
     * session's file is no longer at `rev`, or a read fails: the caller reads
     * through its descriptor. A read is a learning (namespace.learning): pages
     * asked before the store started again are not held.
     */
    read(supervisor: ResidentSupervisor, k: string, rev: number, size: number, first: number, last: number): Promise<{
        pages: Uint8Array[];
        fetched: number;
    } | null>;
    /** Forget what the counters knew: the tables were cleared or rebound. */
    reset(): void;
}
export declare function createPages(coherence: Coherence, admission: Admission, namespace: Namespace): Pages;
//# sourceMappingURL=pages.d.ts.map