/**
 * Compute a 64-bit FNV-1a hash of the given bytes and return it as a
 * 16-character lowercase hex string.
 *
 * We split the 64-bit state into two 32-bit halves (high, low) and apply
 * the FNV-1a algorithm byte-by-byte: xor then multiply by the prime.
 */
export declare function hashBytes(data: Uint8Array): string;
export interface BlobStore {
    get(hash: string): Promise<Uint8Array | null>;
    put(data: Uint8Array): Promise<string>;
    delete(hash: string): Promise<void>;
    has(hash: string): Promise<boolean>;
}
export declare class MemoryBlobStore implements BlobStore {
    private blobs;
    get(hash: string): Promise<Uint8Array | null>;
    put(data: Uint8Array): Promise<string>;
    delete(hash: string): Promise<void>;
    has(hash: string): Promise<boolean>;
}
//# sourceMappingURL=BlobStore.d.ts.map