import type { VFS } from '../kernel/vfs/index.js';
export declare function crc32(data: Uint8Array): number;
export declare function compressGzip(data: Uint8Array): Promise<Uint8Array>;
export declare function decompressGzip(data: Uint8Array): Promise<Uint8Array>;
export interface TarEntry {
    path: string;
    data: Uint8Array;
    type: 'file' | 'directory';
    mode: number;
    mtime: number;
}
export declare function createTar(entries: TarEntry[]): Uint8Array;
export declare function parseTar(data: Uint8Array): TarEntry[];
export interface ZipEntry {
    path: string;
    data: Uint8Array;
    isDirectory: boolean;
}
export declare function createZip(entries: ZipEntry[]): Uint8Array;
export declare function parseZip(data: Uint8Array): ZipEntry[];
/**
 * Members are named relative to the archive's working directory, so
 * `tar -czf a.tgz src/f.txt` stores `src/f.txt`. Naming them relative to each
 * operand's own parent instead flattened every multi-component operand to its
 * basename, and the archive lost the directory the caller asked for.
 */
export declare function collectFiles(vfs: VFS, basePath: string, paths: string[]): TarEntry[];
//# sourceMappingURL=archive.d.ts.map