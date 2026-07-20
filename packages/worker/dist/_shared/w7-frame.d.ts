/**
 * W7 v3 — incremental typed records for streamed bulk filesystem writes.
 * The format is internal: every producer and consumer deploys together.
 */
import type { BatchInodeEntry, BatchWritePayload } from '../vfs/sqlite-vfs.js';
export declare const W7_MAGIC: Uint8Array<ArrayBuffer>;
export declare const W7_MAX_PATHS_PER_BATCH = 128;
export declare const W7_MAX_OWNED_PATH_BYTES: number;
export declare const W7_MAX_RECORD_BYTES: number;
declare const MODE: "path-atomic-committed-prefix";
export interface W7BatchSummary {
    recordCount: number;
    pathCount: number;
    deleteCount: number;
    directoryCount: number;
    fileCount: number;
    chunkCount: number;
    byteCount: number;
    check: number;
}
export interface W7ChunkRetention {
    readonly bytes: number;
    release(): void;
}
export interface W7DecodeOptions {
    signal?: AbortSignal;
    retainChunk?: (byteLength: number, signal?: AbortSignal) => Promise<W7ChunkRetention>;
}
type W7DirectoryInode = BatchInodeEntry & {
    kind: 'directory';
    isDir: true;
};
type W7ContentInode = BatchInodeEntry & {
    kind: 'file' | 'symlink';
    isDir: false;
};
export type W7DecodedRecord = {
    type: 'delete';
    path: string;
} | {
    type: 'directory';
    inode: W7DirectoryInode;
} | {
    type: 'file-begin';
    streamContentId: string;
    inode: W7ContentInode;
} | {
    type: 'file-chunk';
    streamContentId: string;
    path: string;
    chunkId: number;
    data: Uint8Array;
    retention: W7ChunkRetention;
} | {
    type: 'file-end';
    streamContentId: string;
    path: string;
    size: number;
    chunkCount: number;
    check: number;
} | {
    type: 'batch-end';
    summary: W7BatchSummary;
};
export interface W7DecodedStream {
    readonly batchId: string;
    readonly mode: typeof MODE;
    readonly records: AsyncIterable<W7DecodedRecord>;
}
/** Encode one bounded record per pull; no batch-sized metadata header exists. */
export declare function encodeWriteBatchStream(payload: BatchWritePayload): ReadableStream<Uint8Array>;
/**
 * Parse the v3 preamble eagerly, then expose validated operation records
 * incrementally. Chunk credit is acquired after its bounded header validates
 * and before its payload bytes are read or copied.
 */
export declare function decodeWriteBatchStream(stream: ReadableStream<Uint8Array>, options?: W7DecodeOptions): Promise<W7DecodedStream>;
export {};
//# sourceMappingURL=w7-frame.d.ts.map