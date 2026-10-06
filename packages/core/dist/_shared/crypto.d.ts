export interface SealedJsonOptions {
    purpose?: string;
    minSecretLength?: number;
}
export declare function randomBase64Url(byteLength: number): string;
export declare function sha256Base64Url(input: string): Promise<string>;
export declare function pkceChallenge(verifier: string): Promise<string>;
/** Lowercase hex SHA-256 — the digest form the staged-artifact integrity checks pin. */
export declare function sha256Hex(input: BufferSource | string): Promise<string>;
/** SHA-256 fed in pieces, for payloads too large to hold whole. */
export interface Sha256Digest {
    update(bytes: Uint8Array): Promise<void>;
    /** Lowercase hex, as {@link sha256Hex}. Ends the digest. */
    hex(): Promise<string>;
}
/** Web Crypto has no incremental digest: workerd offers `crypto.DigestStream`, Node and Bun `node:crypto`. */
export declare function sha256Incremental(): Sha256Digest;
export declare function sealJson(value: unknown, secret: string, options?: SealedJsonOptions): Promise<string>;
export declare function unsealJson<T>(value: string, secret: string, options?: SealedJsonOptions): Promise<T | null>;
export declare function encodeJsonBase64Url(value: unknown): string;
export declare function decodeJsonBase64Url<T>(value: string): T;
/** Standard base64 (with padding) of `bytes`, in chunks so a large array never overflows the call stack. */
export declare function base64(bytes: Uint8Array): string;
/** The bytes standard base64 `value` encodes; throws what `atob` throws. */
export declare function base64Decode(value: string): Uint8Array;
/** base64url, unpadded (RFC 4648 §5, as JWTs and PKCE carry it). */
export declare function base64Url(bytes: Uint8Array): string;
/** The bytes unpadded base64url `value` encodes; throws on any other alphabet or a length no encoding has. */
export declare function base64UrlDecode(value: string): Uint8Array;
export declare function base64Utf8(value: string): string;
//# sourceMappingURL=crypto.d.ts.map