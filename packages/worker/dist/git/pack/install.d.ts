/**
 * git/pack/install.ts — a pack as the session stores it: written by ranged
 * appends as it arrives, read back by range, and installed once decoded.
 * One implementation for every pack the git facet takes: a clone's, a
 * history piece's, a fetch's, a promisor fetch's.
 *
 * Installing follows git's order (index-pack's finish_tmp_packfile): the
 * pack is named first and its idx last, so no reader finds an idx whose
 * pack is not all there. Every session call waits its turn behind the
 * clone's write waves (measured live: vscode's history ~25% slower with
 * eight more calls a pack), so an ordinary pack costs one rename and one
 * write of its .promisor, .rev and idx together, the idx last. A step that
 * may be run again after its answer was lost (a resumed pack, which cannot
 * be fetched again) asks for a durable record of the outcome: then the idx
 * and .rev go under temporary names with the record before anything is
 * named, and are renamed after the pack; run again, the step finds the
 * record and finishes the naming (resumeInstall).
 */
import type { PackProcessResult, PackStore, WorkTally } from './processor.js';
/** The session's ranged file calls, as a facet makes them. */
export interface PackFiles {
    fsWriteRange(path: string, offset: number, bytes: Uint8Array): Promise<unknown>;
    fsTruncate(path: string, size: number): Promise<unknown>;
    fsReadRange(path: string, offset: number, length: number): Promise<Uint8Array | null>;
    rename(from: string, to: string): Promise<unknown>;
    /** Names in a directory, [] when it is absent. */
    readdir(path: string): Promise<string[]>;
    /** Delete a file, durably, under whatever authority the caller writes with. */
    remove(path: string): Promise<unknown>;
    /**
     * Write whole files, in this order, in as few session calls as the caller
     * can (a wave): durable on return when `durable`, else by the time the
     * caller's step answers (its writer's last flush).
     */
    writeFiles(files: readonly {
        path: string;
        bytes: Uint8Array;
    }[], durable: boolean): Promise<unknown>;
}
export interface PackSummary {
    packSha: string;
    packBytes: number;
    objects: number;
    work: WorkTally;
}
/** Bytes [offset, offset + length) of `path`, read in pieces; short or missing is an error. */
export declare function readRange(files: Pick<PackFiles, 'fsReadRange'>, path: string, offset: number, length: number): Promise<Uint8Array>;
/** A file written by ranged appends and read back by range: a pack as it arrives, or an idx. */
export declare class RangedPackFile implements PackStore {
    private readonly files;
    readonly path: string;
    size: number;
    constructor(files: PackFiles, path: string);
    append(bytes: Uint8Array): Promise<void>;
    writeAt(offset: number, bytes: Uint8Array): Promise<void>;
    truncate(size: number): Promise<void>;
    read(offset: number, length: number): Promise<Uint8Array>;
}
export interface InstallRequest {
    /** The objects/pack directory. */
    dir: string;
    /** The stored pack's temporary name in `dir`. */
    tmpName: string;
    /** Its decoding, complete (entries set). */
    result: PackProcessResult;
    /** A partial clone's .promisor contents (the refs or ids it was fetched for). */
    promisor?: string;
    /** Where to record the outcome before anything is named, with what else the step returns. */
    record?: {
        path: string;
        extra: unknown;
    };
}
export interface InstalledRecord {
    summary: PackSummary;
    extra: unknown;
}
/**
 * Name a decoded pack, git's way; the same pack again (git keeps the one it
 * has) and an empty one leave nothing. Null for an empty pack.
 */
export declare function installPack(files: PackFiles, request: InstallRequest): Promise<PackSummary | null>;
/**
 * A step run again whose pack was installed, or was being named, when its
 * answer was lost: the outcome recorded at `recordPath`, with the naming
 * finished. Null when there is no record: the step had not reached it.
 */
export declare function resumeInstall(files: PackFiles, dir: string, tmpName: string, recordPath: string): Promise<InstalledRecord | null>;
//# sourceMappingURL=install.d.ts.map