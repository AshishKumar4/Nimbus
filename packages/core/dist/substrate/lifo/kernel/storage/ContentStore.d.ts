/**
 * Synchronous, in-memory content-addressable store with LRU eviction.
 *
 * The VFS API is fully synchronous, so we need a sync cache for file content.
 * Large files (>= CHUNK_THRESHOLD) are split into fixed-size chunks and stored
 * here, keeping INodes lightweight (metadata-only, no inline data).
 *
 * The LRU eviction removes least-recently-accessed entries when the total
 * stored bytes exceed the configured budget.
 */
/** Files at or above this size are chunked rather than stored inline.
 *  Set high to avoid LRU eviction silently losing file data during npm install
 *  (many packages installed back-to-back can exceed the ContentStore budget). */
export declare const CHUNK_THRESHOLD: number;
/** Size of each chunk for large files. */
export declare const CHUNK_SIZE: number;
export interface ChunkRef {
    hash: string;
    size: number;
}
export declare class ContentStore {
    private cache;
    private accessCounter;
    private totalBytes;
    private maxBytes;
    constructor(maxBytes?: number);
    /** Retrieve a blob by hash. Returns null if not in cache. */
    get(hash: string): Uint8Array | null;
    /** Store a blob. Returns its content hash. Deduplicates by hash. */
    put(data: Uint8Array): string;
    /** Remove a blob from the cache. */
    delete(hash: string): void;
    /** Check if a hash exists in the cache. */
    has(hash: string): boolean;
    /** Current total bytes in cache. */
    get size(): number;
    /** Number of entries in cache. */
    get count(): number;
    /**
     * Split data into chunks, store each, and return the chunk manifest.
     */
    storeChunked(data: Uint8Array): ChunkRef[];
    /**
     * Reassemble data from a chunk manifest.
     * Returns null if any chunk is missing from cache.
     */
    loadChunked(chunks: ChunkRef[]): Uint8Array | null;
    /**
     * Remove all chunks in a manifest from the cache.
     */
    deleteChunked(chunks: ChunkRef[]): void;
    private evict;
}
//# sourceMappingURL=ContentStore.d.ts.map