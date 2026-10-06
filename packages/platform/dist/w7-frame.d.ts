/**
 * W7 v3 — incremental typed records for streamed bulk filesystem writes.
 * The format is internal: every producer and consumer deploys together.
 */
export type VfsInodeKind = 'file' | 'directory' | 'symlink';
/** Entry for bulk inode creation via writeBatch(). */
export interface BatchInodeEntry {
    path: string;
    parentPath: string;
    /** Defaults to isDir ? directory : file for legacy/non-symlink producers. */
    kind?: VfsInodeKind;
    isDir: boolean;
    size: number;
    atime?: number;
    mtime: number;
    mode: number;
    uid?: number;
    gid?: number;
    chunkCount: number;
}
/** Entry for bulk chunk creation via writeBatch(). */
export interface BatchChunkEntry {
    path: string;
    chunkId: number;
    data: Uint8Array;
}
/**
 * A file whose bytes are read from `source` while the stream is drained, never
 * held whole: its inode (in `inodes`) carries the size, and the source must
 * yield exactly that many bytes, in pieces of any size.
 */
export interface BatchStreamEntry {
    path: string;
    source: AsyncIterable<Uint8Array>;
}
/** Payload for writeBatch() — all inodes + chunks written in ONE transactionSync(). */
export interface BatchWritePayload {
    inodes: BatchInodeEntry[];
    chunks: BatchChunkEntry[];
    /** Paths to delete before writing (for clean reinstall). */
    deletePaths?: string[];
    /** Files streamed from a source rather than given as chunks; encoder only. */
    streams?: BatchStreamEntry[];
}
export declare const W7_MAGIC: Uint8Array<ArrayBuffer>;
/**
 * A batch's owned paths. Each stream costs the receiver a round trip and a
 * publication's fixed work, so a batch is as wide as its byte budget allows;
 * ownership is a set of names, small beside the bytes.
 */
export declare const W7_MAX_PATHS_PER_BATCH = 1024;
export declare const W7_MAX_OWNED_PATH_BYTES: number;
export declare const W7_MAX_RECORD_BYTES: number;
/** The wire chunks a file or link of `size` bytes travels as: CHUNK_SIZE each, the last short, none when empty. */
export declare function w7ChunkCount(size: number): number;
/** `data`, the content at `path`, as its wire chunks (w7ChunkCount): views of it, not copies. */
export declare function w7Chunks(path: string, data: Uint8Array): BatchChunkEntry[];
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
/**
 * Encode the records a pull reaches into one enqueued chunk of about
 * ENCODER_PULL_BYTES (a record never splits; a file's chunk is at most
 * CHUNK_SIZE), so a wave crosses the RPC boundary in a few writes rather than
 * one per record. The bytes are the same records either way; no batch-sized
 * metadata header exists.
 */
export declare function encodeWriteBatchStream(payload: BatchWritePayload): ReadableStream<Uint8Array>;
/**
 * Parse the v3 preamble eagerly, then expose validated operation records
 * incrementally. Chunk credit is acquired after its bounded header validates
 * and before its payload bytes are read or copied.
 */
export declare function decodeWriteBatchStream(stream: ReadableStream<Uint8Array>, options?: W7DecodeOptions): Promise<W7DecodedStream>;
export {};
//# sourceMappingURL=w7-frame.d.ts.map