import type { ProcessView } from '../../../runtime/process-files.js';
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
/**
 * The entries of a tar archive, as the shell extracts them
 * (tarball-stream.ts streamTarRecords): a directory, or anything else with
 * its bytes as a file. Paths are canonical and inside the archive's root; an
 * entry that escapes it is left out, and one that claims more bytes than
 * the archive holds is never read (its buffer would be the claim's size).
 */
export declare function parseTar(data: Uint8Array): Promise<TarEntry[]>;
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
export declare function collectFiles(vfs: ProcessView, basePath: string, paths: string[]): Promise<TarEntry[]>;
//# sourceMappingURL=archive.d.ts.map