/**
 * W7 v4 — incremental typed records for streamed filesystem writes, in
 * program order: the records are the operations a writer made, in the order
 * it made them, and a stream that stops commits a prefix of them (each group
 * whole). A path may be named by several operations (a file written, renamed,
 * written again). Every producer speaks v4; the format is internal, and every
 * producer and consumer deploys together. v3 (no rename, truncate or setattr,
 * one operation per path, deletes then directories then files) is still
 * decoded for the one release that rolls v4 out: delete it with W7_MAGIC_V3.
 * Fields added to v4 since (each deploys with both ends, so the magic stays):
 * a create call's `umask`, and the `open` call (a write description's open).
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
    /**
     * The inode number a delegation's holder gave a file or directory it made
     * (v4): one of the numbers its grant reserved, so the name keeps the
     * number the holder already showed. Absent: the session numbers it.
     */
    ino?: number;
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
    /**
     * The operations themselves, in program order (encoder only): a writer
     * with an order to keep (a delegation's holder) gives these, and nothing
     * in `inodes`, `chunks`, `deletePaths` or `streams`. Without them, a
     * payload is encoded as its deletes, then its directories, then its files.
     */
    ops?: W7Op[];
}
/** One attribute change (setattr): the mode, the owner, or the times; what chmod, chown and utimes each make. */
export type W7Attrs = {
    mode: number;
} | {
    uid: number;
    gid: number;
} | {
    atime: number;
    mtime: number;
};
/**
 * A process's filesystem call as a record (v4), applied by the session's own
 * operation of that name with that operation's semantics and refusals: a
 * writeFile follows a link at its name and refuses a directory (EISDIR), a
 * new file is `mode` less the process's umask and an existing one keeps its
 * mode, owner and inode, a mkdir refuses a name that exists (EEXIST), and
 * nothing makes a missing parent. The program-order counterpart of the
 * syscall, where `file` and `directory` are a checkout's upserts.
 */
export type W7Call = 
/**
 * `ino`, on a call that makes a name (writeFile, appendFile, mkdir,
 * symlink): the number a delegation's holder gave the name it made, from
 * its grant's range, kept when the call makes it (W7 v4 `ino`).
 */
/**
 * `umask`, on a call that makes a name with a mode (writeFile, appendFile,
 * mkdir): the process's umask when it made the call, applied in place of
 * the session's record of it (which a later change may have moved).
 */
{
    call: 'writeFile';
    path: string;
    mode: number;
    ino?: number;
    umask?: number;
    data: Uint8Array;
} | {
    call: 'appendFile';
    path: string;
    mode: number;
    ino?: number;
    umask?: number;
    data: Uint8Array;
}
/**
 * A write through an open description (pwrite(2)) at `offset`: of the
 * file whose inode is `ino` when the process knows it (wherever that file
 * is named now, and nowhere once no name has it), else of the file at
 * `path`. Past its end, the gap reads as zeros.
 */
 | {
    call: 'write';
    path: string;
    ino?: number;
    offset: number;
    data: Uint8Array;
}
/** A write through an O_APPEND description: at the file's end as it is when the write lands. */
 | {
    call: 'append';
    path: string;
    ino?: number;
    data: Uint8Array;
}
/** ftruncate(2) through an open description: the file `ino` names when given, else the one at `path`. */
 | {
    call: 'ftruncate';
    path: string;
    ino?: number;
    size: number;
}
/** `existing: 'ok'`: a directory already there answers success, as `mkdir -p` takes it (anything else there is still EEXIST). */
 | {
    call: 'mkdir';
    path: string;
    mode: number;
    ino?: number;
    umask?: number;
    existing?: 'ok';
} | {
    call: 'unlink';
    path: string;
} | {
    call: 'rmdir';
    path: string;
} | {
    call: 'symlink';
    path: string;
    target: string;
    ino?: number;
}
/**
 * rm(1) as fs.rm makes it: a file or link unlinked, a directory with all
 * it holds when `recursive` (else EISDIR's refusal, as unlink's), and a
 * name not there no refusal when `force`.
 */
 | {
    call: 'rm';
    path: string;
    recursive?: true;
    force?: true;
}
/** chown(2) of the link itself (lchown): the name's own entry, never what it names. */
 | {
    call: 'lchown';
    path: string;
    uid: number;
    gid: number;
}
/** utimes of the link itself (lutimes). */
 | {
    call: 'lutimes';
    path: string;
    atime: number;
    mtime: number;
}
/**
 * open(2) of a file to write it, as the session's own open decides it: a
 * name made (`create`, `mode` less `umask`) or refused (EEXIST when
 * `exclusive`, ENOENT without `create`, EISDIR, EACCES), emptied when
 * `truncate`, a link at the name followed unless `nofollow` (ELOOP). Its
 * answer is the file's stat; the description writes it by its number
 * (write, append and ftruncate calls with `ino`).
 */
 | {
    call: 'open';
    path: string;
    mode: number;
    umask?: number;
    create?: true;
    truncate?: true;
    exclusive?: true;
    nofollow?: true;
};
/** A call whose bytes travel as a file's chunks. */
export type W7DataCall = Extract<W7Call, {
    data: Uint8Array;
}>['call'];
/** A call that is one metadata record. */
export type W7PathCall = Exclude<W7Call, {
    data: Uint8Array;
}>;
/** One operation of a program-order payload (BatchWritePayload.ops). */
export type W7Op = {
    type: 'delete';
    path: string;
} | {
    type: 'directory';
    inode: BatchInodeEntry;
} | {
    type: 'file';
    inode: BatchInodeEntry;
    data: Uint8Array;
} | {
    type: 'file';
    inode: BatchInodeEntry;
    source: AsyncIterable<Uint8Array>;
} | {
    type: 'rename';
    from: string;
    to: string;
} | {
    type: 'truncate';
    path: string;
    size: number;
} | {
    type: 'setattr';
    path: string;
    attrs: W7Attrs;
} | {
    type: 'call';
    call: W7Call;
};
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
declare const MODE: "program-order-committed-prefix";
/** v3's batch mode. Delete with v3 decoding. */
declare const MODE_V3: "path-atomic-committed-prefix";
type W7Mode = typeof MODE | typeof MODE_V3;
export interface W7BatchSummary {
    recordCount: number;
    pathCount: number;
    deleteCount: number;
    directoryCount: number;
    fileCount: number;
    chunkCount: number;
    byteCount: number;
    /** Renames, truncates, attribute changes and path calls (v4; none in v3). */
    opCount: number;
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
/** `call`: the file is a W7DataCall's bytes (its path, mode and size), not an upsert's inode. */
type W7ContentInode = BatchInodeEntry & {
    kind: 'file' | 'symlink';
    isDir: false;
    call?: W7DataCall;
    offset?: number;
    umask?: number;
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
    type: 'rename';
    from: string;
    to: string;
} | {
    type: 'truncate';
    path: string;
    size: number;
} | {
    type: 'setattr';
    path: string;
    attrs: W7Attrs;
} | {
    type: 'call';
    call: W7PathCall;
} | {
    type: 'batch-end';
    summary: W7BatchSummary;
};
export interface W7DecodedStream {
    readonly batchId: string;
    readonly mode: W7Mode;
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
 * The bytes encodeWriteBatchStream would stream for `payload`, as one buffer:
 * for a payload held in memory (no streamed sources), the same records in
 * the same order, copied once.
 */
export declare function encodeWriteBatch(payload: BatchWritePayload): Promise<Uint8Array>;
/**
 * Parse the v3 preamble eagerly, then expose validated operation records
 * incrementally. Chunk credit is acquired after its bounded header validates
 * and before its payload bytes are read or copied.
 */
export declare function decodeWriteBatchStream(stream: ReadableStream<Uint8Array>, options?: W7DecodeOptions): Promise<W7DecodedStream>;
export {};
//# sourceMappingURL=w7-frame.d.ts.map