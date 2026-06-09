import type { VirtualProvider, Stat, Dirent } from '../types.js';
export declare class DevProvider implements VirtualProvider {
    private clipboardCache;
    readFile(subpath: string): Uint8Array;
    readFileString(subpath: string): string;
    writeFile(subpath: string, content: string | Uint8Array): void;
    exists(subpath: string): boolean;
    stat(subpath: string): Stat;
    readdir(subpath: string): Dirent[];
}
//# sourceMappingURL=DevProvider.d.ts.map