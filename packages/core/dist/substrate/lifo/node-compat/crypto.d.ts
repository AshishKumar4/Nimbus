import { Buffer } from './buffer.js';
export declare function randomBytes(size: number): Buffer;
export declare function randomUUID(): string;
interface HashObject {
    update(data: string | Uint8Array): HashObject;
    digest(encoding?: string): string | Buffer;
}
export declare function createHash(algorithm: string): HashObject;
export declare function randomInt(min: number, max?: number): number;
export declare function getRandomValues<T extends ArrayBufferView>(array: T): T;
export declare const subtle: SubtleCrypto;
/** Node.js 21+ one-shot sync hash: crypto.hash(algo, data, encoding) */
export declare function hash(algorithm: string, data: string | Uint8Array, outputEncoding?: string): string;
declare const _default: {
    randomBytes: typeof randomBytes;
    randomUUID: typeof randomUUID;
    createHash: typeof createHash;
    randomInt: typeof randomInt;
    getRandomValues: typeof getRandomValues;
    subtle: SubtleCrypto;
    hash: typeof hash;
};
export default _default;
//# sourceMappingURL=crypto.d.ts.map