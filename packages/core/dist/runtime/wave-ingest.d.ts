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
import { type BatchWritePayload } from '@nimbus-sh/platform/w7-frame.js';
import type { CredentialedVfs } from '../vfs/sqlite-vfs.js';
import { type WaveRouter, type WriteBatchStreamResult, type WriteStreamOptions } from './wave-contracts.js';
export declare class WaveIngest {
    private readonly router;
    constructor(router: WaveRouter | null);
    /** `stream`, a wave, applied as `view`'s caller (its credential, origin, delegations and lease). */
    writeStream(view: CredentialedVfs, stream: ReadableStream<Uint8Array>, options?: WriteStreamOptions): Promise<WriteBatchStreamResult>;
    /**
     * writeBatch where the namespace places it. When every record is placed on
     * the session's filesystem by lookups made in this turn, the batch commits
     * there, atomic, in that same turn; otherwise (a record on a mount, or a
     * lookup that left the synchronous backends) it goes as a wave, each
     * record applied where it lands and rechecked at its commit, refused as a
     * whole call is (its error) at the first refusal. `signal` cancels it
     * before anything commits.
     */
    writeBatch(view: CredentialedVfs, payload: BatchWritePayload, options?: {
        signal?: AbortSignal;
    }): Promise<{
        inodes: number;
        chunks: number;
    }>;
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
    placesHere(view: CredentialedVfs, names: readonly string[], options?: {
        aboveMounts?: boolean;
        follow?: boolean;
    }): boolean;
    private placedHere;
    private consume;
    /**
     * Route `record` through `router` when the namespace places it on a mount,
     * in its place in the wave: what the wave wrote here before it commits
     * first (`at.settleBefore`), then the namespace's own operation, with its
     * refusals (EROFS on a read-only mount, EACCES, ENOENT). A file's chunks
     * are handed to the router as they arrive, each held by the wave's credit
     * until the router has written it. True when the record was routed.
     */
    private routeRecord;
}
//# sourceMappingURL=wave-ingest.d.ts.map