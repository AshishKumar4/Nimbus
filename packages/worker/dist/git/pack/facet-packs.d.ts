/**
 * git/pack/facet-packs.ts — cf-git's `packs` seam inside the git network
 * facet, over the supervisor's ranged reads and writes.
 *
 * read/has/expand serve objects from the session's packs by range
 * (store.ts), so a pull's merge and checkout, or a push's pack, never load a
 * pack whole. ingest takes a fetched pack as it arrives (cf-git's _fetch
 * hands over its side-band stream, paced by the reader): stored by ranged
 * appends, indexed in the same pass (processor.ts), thin bases completed
 * from the repository, then installed (install.ts) as git names it, pack
 * before idx; a fetch that fails leaves no temporary file behind.
 */
import { type GitPacksSeam } from './store.js';
/** The supervisor calls the seam makes. */
export interface FacetPacksSupervisor {
    fsReadRange(path: string, offset: number, length: number): Promise<Uint8Array | null>;
    fsWriteRange(path: string, offset: number, bytes: Uint8Array): Promise<unknown>;
    fsTruncate(path: string, size: number): Promise<unknown>;
    rename(from: string, to: string): Promise<unknown>;
    unlink(path: string): Promise<unknown>;
    readdir(path: string): Promise<string[]>;
    /** Make `dir` exist durably (a clone's objects/pack may not yet). */
    ensureDirectory(dir: string): Promise<void>;
}
/** cf-git's FIFO of pack chunks (its side-band demux's band 1). */
export interface PackChunkQueue {
    next(): Promise<{
        value?: Uint8Array;
        done?: boolean;
    }>;
    error?: unknown;
}
/** cf-git's _readObject, for a thin pack's bases. */
export type ExternalObjectReader = (oid: string) => Promise<{
    type: string;
    object: Uint8Array;
}>;
export interface FacetPacksSeam extends GitPacksSeam {
    /** Store and index a fetched pack; its id, or null for an empty pack. */
    ingest(gitdir: string, packfile: PackChunkQueue, readExternal: ExternalObjectReader): Promise<string | null>;
}
export declare function facetPacks(supervisor: FacetPacksSupervisor): FacetPacksSeam;
//# sourceMappingURL=facet-packs.d.ts.map