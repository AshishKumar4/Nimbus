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
export declare function collectFiles(vfs: VFS, basePath: string, paths: string[]): TarEntry[];
//# sourceMappingURL=archive.d.ts.map