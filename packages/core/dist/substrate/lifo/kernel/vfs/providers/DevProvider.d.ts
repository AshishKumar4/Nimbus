import type { MountProvider, Stat, Dirent } from '../types.js';
export declare class DevProvider implements MountProvider {
    private norm;
    private node;
    readFile(subpath: string): Uint8Array;
    readFileString(subpath: string): string;
    readRange(subpath: string, _offset: number, length: number): Uint8Array;
    writeFile(subpath: string, content: string | Uint8Array): void;
    writeRange(subpath: string, _offset: number, bytes: Uint8Array): void;
    truncate(subpath: string, _size: number): void;
    exists(subpath: string): boolean;
    stat(subpath: string): Stat;
    readdir(subpath: string): Dirent[];
    unlink(subpath: string): void;
    mkdir(subpath: string): void;
    rmdir(subpath: string): void;
    rename(oldSubpath: string): void;
    copyFile(srcSubpath: string): void;
    isDirectory(subpath: string): boolean;
}
//# sourceMappingURL=DevProvider.d.ts.map