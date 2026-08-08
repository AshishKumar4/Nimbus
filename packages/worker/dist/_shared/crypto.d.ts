export interface SealedJsonOptions {
    purpose?: string;
    minSecretLength?: number;
}
export declare function randomBase64Url(byteLength: number): string;
export declare function sha256Base64Url(input: string): Promise<string>;
export declare function pkceChallenge(verifier: string): Promise<string>;
/** Lowercase hex SHA-256 — the digest form the staged-artifact integrity checks pin. */
export declare function sha256Hex(input: BufferSource | string): Promise<string>;
export declare function sealJson(value: unknown, secret: string, options?: SealedJsonOptions): Promise<string>;
export declare function unsealJson<T>(value: string, secret: string, options?: SealedJsonOptions): Promise<T | null>;
export declare function encodeJsonBase64Url(value: unknown): string;
export declare function decodeJsonBase64Url<T>(value: string): T;
export declare function base64Url(bytes: Uint8Array): string;
export declare function base64UrlDecode(value: string): Uint8Array;
export declare function base64Utf8(value: string): string;
//# sourceMappingURL=crypto.d.ts.map