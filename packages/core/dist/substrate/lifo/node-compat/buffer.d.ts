export declare class Buffer extends Uint8Array {
    static from(value: string | Uint8Array | number[] | ArrayBuffer | ArrayLike<number> | Iterable<number>, encodingOrMapFn?: string | ((v: number, k: number) => number), _thisArg?: unknown): Buffer;
    static alloc(size: number, fill?: number): Buffer;
    static allocUnsafe(size: number): Buffer;
    static isBuffer(obj: unknown): obj is Buffer;
    static concat(list: (Uint8Array | Buffer)[], totalLength?: number): Buffer;
    static byteLength(str: string, encoding?: string): number;
    toString(encoding?: string, start?: number, end?: number): string;
    write(str: string, offset?: number, length?: number, encoding?: string): number;
    toJSON(): {
        type: 'Buffer';
        data: number[];
    };
    copy(target: Buffer | Uint8Array, targetStart?: number, sourceStart?: number, sourceEnd?: number): number;
    equals(other: Uint8Array): boolean;
    compare(other: Uint8Array): number;
    slice(start?: number, end?: number): Buffer;
    subarray(start?: number, end?: number): Buffer;
    readUInt8(offset?: number): number;
    readUInt16BE(offset?: number): number;
    readUInt32BE(offset?: number): number;
    readInt8(offset?: number): number;
    readInt16BE(offset?: number): number;
    readInt32BE(offset?: number): number;
    readUInt16LE(offset?: number): number;
    readUInt32LE(offset?: number): number;
    readInt16LE(offset?: number): number;
    readInt32LE(offset?: number): number;
    writeUInt8(value: number, offset?: number): number;
    writeUInt16BE(value: number, offset?: number): number;
    writeUInt32BE(value: number, offset?: number): number;
    writeInt8(value: number, offset?: number): number;
    writeInt16BE(value: number, offset?: number): number;
    writeInt32BE(value: number, offset?: number): number;
    writeUInt16LE(value: number, offset?: number): number;
    writeUInt32LE(value: number, offset?: number): number;
    writeInt16LE(value: number, offset?: number): number;
    writeInt32LE(value: number, offset?: number): number;
    indexOf(value: number | Uint8Array | string, byteOffset?: number, encoding?: string): number;
    lastIndexOf(value: number | Uint8Array | string, byteOffset?: number, encoding?: string): number;
    includes(value: number | Uint8Array | string, byteOffset?: number, encoding?: string): boolean;
}
export default Buffer;
//# sourceMappingURL=buffer.d.ts.map